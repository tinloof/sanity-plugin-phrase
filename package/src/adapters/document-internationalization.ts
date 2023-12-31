import { uuid } from '@sanity/uuid'
import { KeyedObject, Reference } from 'sanity'
import {
  DocPairFromAdapter,
  ExistingReference,
  I18nAdapter,
  ReferenceMap,
} from '../types'
import { draftId, isDraft, undraftId } from '../utils'

// https://github.com/sanity-io/document-internationalization/blob/main/src/constants.ts
const METADATA_SCHEMA_NAME = `translation.metadata`
const TRANSLATIONS_ARRAY_NAME = `translations`

type TranslationReference = KeyedObject & {
  _type: 'internationalizedArrayReferenceValue'
  value: Reference
}

export function documentInternationalizationAdapter({
  languageField = 'language',
  weakReferences = true,
}: {
  languageField?: string
  weakReferences?: boolean
} = {}): I18nAdapter {
  return {
    injectDocumentLang: (document, language) => ({
      ...document,
      [languageField]: language,
    }),
    getTranslatedReferences: async ({
      sanityClient,
      references,
      targetLang,
      translatableTypes,
    }) => {
      const fetched = await sanityClient.fetch<
        {
          publishedId: string
          draftId: string
          type?: string
          translation?: Reference | null
          translationHasDraft: boolean
          translationHasPublished: boolean
        }[]
      >(
        /* groq */ `$idPairs[] {
          ...,
          "type": *[_id == ^.publishedId || _id == ^.draftId][0]._type,
          "translation": *[
            _type == "translation.metadata" &&
            (references(^.publishedId) || references(^.draftId))
          ][0].${TRANSLATIONS_ARRAY_NAME}[_key == $targetLanguage][0].value 
        }
        | {
          ...,
          "translationHasDraft": defined(translation) && defined(*[_id == ("drafts." + ^.translation._ref)][0]._id),
          "translationHasPublished": defined(translation) && defined(*[_id == ^.translation._ref][0]._id),
        }`,
        {
          idPairs: references.flatMap((ref) =>
            ref ? { publishedId: undraftId(ref), draftId: draftId(ref) } : [],
          ),
          targetLanguage: targetLang,
        },
      )

      return references.reduce((refMap, ref) => {
        const refDoc = fetched.find((doc) => doc.publishedId === undraftId(ref))

        if (!refDoc || !refDoc.type) {
          return {
            ...refMap,
            [ref]: 'doc-not-found',
          }
        }

        if (!translatableTypes.includes(refDoc.type)) {
          return {
            ...refMap,
            [ref]: 'untranslatable',
          }
        }

        return {
          ...refMap,
          [ref]: {
            targetLanguageDocId: refDoc.translation?._ref || null,
            _type: refDoc.type,
            state: parseState({
              hasDraft: refDoc.translationHasDraft,
              hasPublished: refDoc.translationHasPublished,
            }),
          } as ExistingReference,
        }
      }, {} as ReferenceMap)
    },
    getDocumentLang: (document) =>
      (document?.[languageField] as string) || null,
    getOrCreateTranslatedDocuments: async (props) => {
      const { sanityClient, sourceDoc } = props
      const query = /* groq */ `
      coalesce(
        // For documents with translations, fetch the translations metadata
        *[_type == $metadataType && references($publishedId)][0] {
          _id,
          _type,
          "translations": ${TRANSLATIONS_ARRAY_NAME}[] {
            "lang": _key,
            "published": value->,
            "draft": *[_id == ("drafts." + ^.value._ref)][0],
          }
        },
        // Otherwise, fetch the document itself and handle its draft & published states
        *[_id == $publishedId][0]{
          "lang": ${languageField},
          "published": @,
          "draft": *[_id == $draftId][0],
        },
        *[_id == $draftId][0]{
          "lang": ${languageField},
          "published": null,
          "draft": @,
        },
      )`
      const fetched = await sanityClient.fetch<
        | {
            _id: string
            _type: typeof METADATA_SCHEMA_NAME
            translations: DocPairFromAdapter[]
          }
        | DocPairFromAdapter
      >(query, {
        publishedId: undraftId(sourceDoc._id),
        draftId: draftId(sourceDoc._id),
        metadataType: METADATA_SCHEMA_NAME,
      })

      if (!fetched) throw new Error('Failed fetching fresh documents')

      const metaDocument =
        '_type' in fetched && fetched._type === 'translation.metadata'
          ? fetched
          : undefined
      const allInitialDocuments = metaDocument
        ? metaDocument.translations
            // As translations in meta document are weak references, they might be null
            .filter((t) => !!(t.draft || t.published)?._id)
        : [fetched as DocPairFromAdapter]

      const freshSourcePair = allInitialDocuments.find(
        (doc) => doc.lang === sourceDoc.lang.sanity,
      )

      const freshDocToCopy = isDraft(sourceDoc._id)
        ? freshSourcePair?.draft || freshSourcePair?.published
        : freshSourcePair?.published || freshSourcePair?.draft

      if (!freshDocToCopy) {
        throw new Error('Failed fetching fresh source document')
      }

      const langsMissingTranslation = props.targetLangs.flatMap((lang) => {
        if (
          allInitialDocuments.some(
            (doc) =>
              doc.lang === lang.sanity && !!(doc.draft || doc.published)?._id,
          )
        ) {
          return []
        }

        const publishedId = uuid()
        return {
          lang,
          publishedId,
          doc: {
            ...freshDocToCopy,
            _id: draftId(publishedId),
            [languageField]: lang.sanity,
          },
        }
      })

      if (!langsMissingTranslation.length) {
        return allInitialDocuments
      }

      const transaction = props.sanityClient.transaction()

      /**
       * Creates the translated documents for the missing languages
       * @see `handleCreate` at https://github.com/sanity-io/document-internationalization/blob/main/src/components/LanguageOption.tsx#L59
       */
      langsMissingTranslation.forEach(({ doc }) => {
        transaction.create(doc)
      })

      const sourceReference = createTranslationReference(
        sourceDoc.lang.sanity,
        sourceDoc._id,
        sourceDoc._type,
        !weakReferences,
      )
      const newTranslationsReferences = langsMissingTranslation.map((t) =>
        createTranslationReference(
          t.lang.sanity,
          t.publishedId,
          sourceDoc._type,
          !weakReferences,
        ),
      )

      /**
       * Associates the new translations with the source document via the meta document
       * @see `handleCreate` at https://github.com/sanity-io/document-internationalization/blob/main/src/components/LanguageOption.tsx#L98
       */
      if (metaDocument) {
        transaction.patch(metaDocument._id, (patch) =>
          patch
            // First make sure we remove previous translations in the metadata document to prevent duplication
            .unset(
              newTranslationsReferences.map(
                (ref) => `translations[_key == "${ref._key}"]`,
              ),
            )
            .insert('after', 'translations[-1]', newTranslationsReferences),
        )
      } else {
        transaction.create({
          _id: uuid(),
          _type: METADATA_SCHEMA_NAME,
          [TRANSLATIONS_ARRAY_NAME]: [
            sourceReference,
            ...newTranslationsReferences,
          ],
          schemaTypes: [sourceDoc._type],
        })
      }

      const result = await transaction.commit({ returnDocuments: true })

      const finalDocuments: DocPairFromAdapter[] = [
        ...allInitialDocuments,
        ...langsMissingTranslation.map(({ doc, lang }) => {
          // Find the `_rev` from the resulting document so we can use it to
          // lock documents safely with `ifRevisionId` in `lockDocuments`.
          const _rev =
            result.find((d) => d._id === doc._id)?._rev ||
            // If no _rev found, don't use `ifRevisionId`
            (null as any as string)
          return {
            lang: lang.sanity,
            draft: { ...doc, _rev },
            published: null,
          }
        }),
      ]

      return finalDocuments
    },
    langAdapter: {
      toPhrase: (sanityLang) => sanityLang.replace(/_/g, '-'),
      toSanity: (phraseLang) => phraseLang.replace(/-/g, '_'),
    },
    getLangGROQFilter: (lang) => `${languageField} == "${lang}"`,
  }
}

/**
 * Adapted from https://github.com/sanity-io/document-internationalization/blob/main/src/utils/createReference.ts
 */
function createTranslationReference(
  key: string,
  ref: string,
  type: string,
  strengthenOnPublish: boolean = true,
): TranslationReference {
  return {
    _key: key,
    _type: 'internationalizedArrayReferenceValue',
    value: {
      _type: 'reference',
      _ref: undraftId(ref),
      _weak: true,
      // If the user has configured weakReferences, we won't want to strengthen them
      ...(strengthenOnPublish ? { _strengthenOnPublish: { type } } : {}),
    },
  }
}

function parseState({
  hasDraft,
  hasPublished,
}: {
  hasDraft: boolean
  hasPublished: boolean
}): ExistingReference['state'] {
  if (hasDraft && hasPublished) {
    return 'both'
  }

  if (hasDraft) {
    return 'draft'
  }

  return 'published'
}
