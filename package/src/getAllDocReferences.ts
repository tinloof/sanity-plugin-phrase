import { Reference, SanityDocument } from 'sanity'
import pMap from 'p-map'
import { SanityClient, collate } from 'sanity'
import { parseAllReferences } from './utils/references'
import { PhrasePluginOptions, SanityDocumentWithPhraseMetadata } from './types'
import { draftId, isDraft, undraftId } from './utils'

type TranslatableRef = {
  translatable: true
  doc: SanityDocumentWithPhraseMetadata
  references: string[]
  occurrences: {
    depth: number
    ref: Reference
  }[]
  maxDepth: number
}

type UnstranslatableRef = {
  translatable: false
  doc: SanityDocumentWithPhraseMetadata
}

type RefsState = {
  [docId: string]: TranslatableRef | UnstranslatableRef
}

/**
 * @TODO How can we improve this? We're currently over-fecthing from Sanity.
 * One possible improvement is skipping published docs if drafts are present.
 */
export default async function getAllDocReferences({
  sanityClient,
  document: parentDocument,
  maxDepth = 3,
  translatableTypes,
}: {
  sanityClient: SanityClient
  document: SanityDocumentWithPhraseMetadata
  maxDepth?: number
  translatableTypes: PhrasePluginOptions['translatableTypes']
}) {
  const state = {
    referenced: {
      [parentDocument._id]: {
        doc: parentDocument,
        references: [],
        occurrences: [],
        maxDepth: 0,
        translatable: true,
      },
    } as RefsState,
    errors: {} as { [docId: string]: unknown },
  }

  function addRefOccurrence(ref: Reference, depth: number) {
    const existing = state.referenced[ref._ref]
    if (existing && existing.translatable === true) {
      existing.occurrences.push({ ref, depth })
      existing.maxDepth = Math.max(existing.maxDepth, depth)
    }
  }

  function addDocReferences(
    doc: SanityDocumentWithPhraseMetadata,
    references: Reference[],
    depth: number,
  ) {
    if (!translatableTypes.includes(doc._type)) {
      state.referenced[doc._id] = {
        doc,
        translatable: false,
      }

      return
    }

    const existing = state.referenced[doc._id]
    if (!existing) {
      state.referenced[doc._id] = {
        doc,
        occurrences: [],
        references: [],
        maxDepth: depth,
        translatable: true,
      }
    }

    if (existing.translatable) {
      existing.references.push(...references.map((ref) => ref._ref))
    }
  }

  function persistError(
    doc: SanityDocumentWithPhraseMetadata,
    error: (typeof state)['errors'][string],
  ) {
    state.errors[doc._id] = error
  }

  async function fetchDocReferences(
    doc: SanityDocumentWithPhraseMetadata,
    currentDepth: number,
  ) {
    const docReferences = parseAllReferences(doc, [])

    addDocReferences(doc, docReferences, currentDepth)
    docReferences.forEach((ref) => addRefOccurrence(ref, currentDepth))

    if (currentDepth >= maxDepth) {
      return
    }

    const toFetch = docReferences.reduce(
      (refs, ref) => {
        if (state.referenced[ref._ref]) {
          return refs
        }

        return {
          ...refs,
          [ref._ref]: [...(refs[ref._ref] || []), ref],
        }
      },
      {} as Record<string, Reference[]>,
    )

    console.log('QUERYING FROM SANITY', doc._id)
    const referencedDocuments = await sanityClient.fetch<SanityDocument[]>(
      `*[_id in $publishedIds || _id in $draftIds]`,
      {
        publishedIds: Object.keys(toFetch).map(undraftId),
        draftIds: Object.keys(toFetch).map(draftId),
      },
    )

    await pMap(
      referencedDocuments,
      async (d: SanityDocument) => {
        try {
          // If we have a draft of the current published document, let that drive the references.
          // @TODO: is this valid? It leads to some missing published documents in the final data as compared to not having this check.
          // Come back to this once I'm ready to work with the references
          if (
            !isDraft(d._id) &&
            referencedDocuments.find((a) => a._id === draftId(d._id))
          ) {
            return
          }

          await fetchDocReferences(d, currentDepth + 1)
        } catch (error) {
          persistError(d, error)
        }
      },
      {
        stopOnError: false,
        concurrency: 2,
      },
    )
  }

  await fetchDocReferences(parentDocument, 1)

  const finalDocs = collate(
    Object.values(state.referenced).flatMap((a) => {
      if (a.doc._id === parentDocument._id || !a.translatable) return []

      return {
        ...a.doc,
        __occurrences: a.occurrences,
        __references: a.references,
      }
    }),
  )

  return finalDocs
}