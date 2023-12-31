import { SanityClient } from 'sanity'
import decodeFromPhrase from './decodeFromPhrase'
import {
  ContentInPhrase,
  PhrasePluginOptions,
  SanityPTDWithExpandedMetadata,
} from './types'
import { applyPatches, dedupeArray, diffToPatch } from './utils'
import {
  injectTranslatedReferences,
  parseAllReferences,
} from './utils/references'
import { keepStaticValues } from './mergeDocs'

export default async function phraseDocumentToSanityDocument({
  contentInPhrase,
  freshPTD,
  sanityClient,
  pluginOptions,
}: {
  contentInPhrase: ContentInPhrase
  freshPTD: SanityPTDWithExpandedMetadata
  sanityClient: SanityClient
  pluginOptions: PhrasePluginOptions
}): Promise<typeof freshPTD> {
  const references = dedupeArray(
    parseAllReferences(contentInPhrase.toTranslate, []).map((ref) => ref._ref),
  )

  const { targetLang } = freshPTD.phraseMetadata
  const TMD = freshPTD.phraseMetadata.expandedTMD
  const target = freshPTD.phraseMetadata.expandedTarget

  if (!TMD || !target) {
    return freshPTD
  }

  const TMDTarget = TMD.targets.find((t) => t._key === targetLang.sanity)

  let referenceMap = TMDTarget?.referenceMap || {}
  const uncachedReferences = references.filter((ref) => !referenceMap[ref])

  if (uncachedReferences.length > 0) {
    const newReferenceMap =
      await pluginOptions.i18nAdapter.getTranslatedReferences({
        references: uncachedReferences,
        sanityClient,
        targetLang: targetLang.sanity,
        translatableTypes: pluginOptions.translatableTypes,
      })
    referenceMap = {
      ...referenceMap,
      ...newReferenceMap,
    }

    if (TMDTarget?._key) {
      try {
        // Cache referenceMap for future requests
        await sanityClient
          .patch(TMD._id, {
            set: {
              [`targets[_key == "${TMDTarget._key}"].referenceMap`]:
                referenceMap,
            },
          })
          .commit({ returnDocuments: false })
      } catch (_error) {
        // No need to act on errors - cache will be skipped
      }
    }
  }

  const patches = contentInPhrase.toTranslate.map((item) => {
    const dataWithReferences = injectTranslatedReferences({
      data: decodeFromPhrase('data' in item ? item.data : undefined),
      referenceMap,
    })

    return diffToPatch(item._diff, dataWithReferences)
  })

  /** Make sure we always apply patches based on the target's original state */
  const originalTargetContent = keepStaticValues(
    freshPTD,
    target as any as typeof freshPTD,
  )

  return applyPatches(originalTargetContent, patches)
}
