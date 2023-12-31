import { Effect, pipe } from 'effect'
import {
  ContextWithFreshDocuments,
  SanityDocumentWithPhraseMetadata,
  SanityTMD,
  SanityTranslationDocPair,
  TranslationRequest,
} from '../types'
import { TMD_TYPE } from '../utils'

type StoredError = {
  adapter?: unknown
  known?:
    | 'hasBrokenDoc'
    | 'hasMissingLang'
    | 'sourceDocMissing'
    | 'failedFetchingTMDs'
}

class AdapterFailedQueryingError {
  readonly _tag = 'AdapterFailedQueryingError'

  constructor(readonly error: StoredError) {}
}

export default function getOrCreateTranslatedDocuments(
  request: TranslationRequest,
) {
  return pipe(
    Effect.tryPromise({
      try: () =>
        request.pluginOptions.i18nAdapter.getOrCreateTranslatedDocuments(
          request,
        ),
      catch: (error) => new AdapterFailedQueryingError({ adapter: error }),
    }),
    Effect.tap(() =>
      Effect.logInfo(
        '[getOrCreateTranslatedDocuments] Got fresh documents from Phrase',
      ),
    ),
    Effect.flatMap((freshDocumentsSource) => {
      const docs = Array.isArray(freshDocumentsSource)
        ? freshDocumentsSource
        : []
      const hasBrokenDoc = docs.some(
        (item) =>
          typeof item !== 'object' || !item || (!item.draft && !item.published),
      )
      const hasMissingLang = request.targetLangs.some(
        (lang) => !docs.some((d) => d?.lang === lang.sanity),
      )
      const sourceDocMissing = !docs.some(
        (d) => (d.draft || d.published)?._id === request.sourceDoc._id,
      )

      let knownError: StoredError['known']
      if (hasBrokenDoc) knownError = 'hasBrokenDoc'
      if (hasMissingLang) knownError = 'hasMissingLang'
      if (sourceDocMissing) knownError = 'sourceDocMissing'

      if (knownError) {
        return Effect.fail(
          new AdapterFailedQueryingError({ known: knownError }),
        )
      }

      return Effect.succeed(freshDocumentsSource)
    }),
    Effect.flatMap((freshDocumentsSource) =>
      Effect.tryPromise({
        try: async () => {
          const TMDs = await request.sanityClient.fetch<SanityTMD[]>(
            `*[_type == "${TMD_TYPE}" && references($ids)]`,
            {
              ids: freshDocumentsSource.flatMap(
                (d) =>
                  [d.draft?._id, d.published?._id].filter(Boolean) as string[],
              ),
            },
          )

          return {
            TMDs,
            freshDocumentsSource,
          }
        },
        catch: () =>
          new AdapterFailedQueryingError({ known: 'failedFetchingTMDs' }),
      }),
    ),
    Effect.map(({ freshDocumentsSource, TMDs }) => {
      const freshDocuments = freshDocumentsSource.map(
        (d) =>
          ({
            ...d,
            lang: request.pluginOptions.langAdapter.sanityToCrossSystem(d.lang),
          }) as SanityTranslationDocPair,
      )

      const freshDocumentsById = freshDocuments.reduce(
        (acc, t) => {
          if (t.draft) acc[t.draft._id] = t.draft
          if (t.published) acc[t.published._id] = t.published

          return acc
        },
        {} as Record<string, SanityDocumentWithPhraseMetadata>,
      )

      const freshSourceDoc = freshDocumentsById[request.sourceDoc._id]

      return {
        freshDocumentsById,
        freshDocuments,
        request,
        freshSourceDoc,
        otherTMDs: TMDs,
      } as ContextWithFreshDocuments
    }),
    Effect.withSpan('getOrCreateTranslatedDocuments'),
  )
}
