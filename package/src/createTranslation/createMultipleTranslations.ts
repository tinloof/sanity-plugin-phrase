import { Effect, pipe } from 'effect'
import { CreateMultipleTranslationsInput } from '../types'
import { runEffectWithClients } from './createTranslationHelpers'
import createTranslations from './createTranslations'

export type CreateTranslationsResponse = Awaited<
  ReturnType<typeof createMultipleTranslations>
>

export default function createMultipleTranslations(
  input: CreateMultipleTranslationsInput,
) {
  const { translations } = input
  if (!Array.isArray(translations)) {
    return {
      status: 400,
      body: { error: 'Invalid translations set', errors: [] },
    } as const
  }

  if (translations.length === 0) {
    return {
      status: 200,
      body: { message: 'No translations to create', successes: [] },
    } as const
  }

  const program = pipe(
    Effect.forEach(
      translations,
      (t) =>
        createTranslations({
          ...t,
          sanityClient: input.sanityClient,
          credentials: input.credentials,
          pluginOptions: input.pluginOptions,
        }).pipe(Effect.map((res) => ({ res, t }))),
      { concurrency: 2 },
    ),
    Effect.map((results) => {
      const errors = results.filter((r) => r.res.status !== 200)
      const successes = results.filter((r) => r.res.status === 200)

      if (successes.length === 0) {
        return {
          status: 500,
          body: { error: 'All translations failed', errors },
        } as const
      }

      if (errors.length === 0) {
        return {
          status: 200,
          body: { message: 'All translations created', successes },
        } as const
      }

      return {
        status: 207,
        body: {
          message: `${successes.length} translations created and ${errors.length} failed`,
          successes,
          errors,
        },
      } as const
    }),
  )

  return Effect.runPromise(
    pipe(
      runEffectWithClients(input, program),
      Effect.tapError((error) => Effect.logError(error)),

      Effect.catchTags({
        UnknownPhraseClientError: (error) =>
          Effect.succeed({
            body: { error: error._tag },
            status: 500,
          } as const),
        SanityCreateOrReplaceError: (error) =>
          Effect.succeed({
            body: { error: error._tag },
            status: 500,
          } as const),
        SanityFetchError: (error) =>
          Effect.succeed({
            body: { error: error._tag },
            status: 500,
          } as const),
        InvalidPhraseCredentialsError: (error) =>
          Effect.succeed({
            body: { error: error._tag },
            status: 401,
          } as const),
      }),
    ),
  )
}
