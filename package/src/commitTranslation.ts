import { SanityClient } from 'sanity'
import { getMergePTDTransaction } from './mergePTD'
import { SanityMainDoc, SanityPTD, SanityTMD } from './types'
import { draftId, undraftId } from './utils'

export default async function commitTranslation({
  sanityClient,
  TMD,
}: {
  sanityClient: SanityClient
  TMD: SanityTMD
}) {
  const transaction = sanityClient.transaction()

  const mainDocIds = [
    TMD.sourceDoc._id,
    ...TMD.targets.map((t) => t.targetDoc._ref),
  ]
  const PTDIds = TMD.targets.flatMap((t) => t.ptd?._ref || [])
  const { mainDocs, PTDs, fetchError } = await sanityClient
    .fetch<{
      mainDocs: SanityMainDoc[]
      PTDs: SanityPTD[]
      fetchError: undefined
    }>(
      /* groq */ `{
      "mainDocs": *[_id in $mainIds],
      "PTDs": *[_id in $PTDIds]
    }`,
      {
        mainIds: mainDocIds.flatMap((id) =>
          id ? [undraftId(id), draftId(id)] : [],
        ),
        PTDIds,
      },
    )
    .catch((e) => ({ mainDocs: [], PTDs: [], fetchError: e }))

  if (fetchError) {
    return { error: fetchError }
  }

  // 1. Modify status of translation to `COMMITTED`
  transaction.patch(TMD._id, (patch) =>
    patch.set({ status: 'COMMITTED' } as SanityTMD<'COMMITTED'>),
  )

  // 2. Merge PTDs into targets
  PTDs.forEach((PTD) => {
    const targetDocs = mainDocs.filter(
      (doc) =>
        undraftId(PTD.phraseMetadata.targetDoc._ref) === undraftId(doc._id),
    )
    getMergePTDTransaction({
      initialTx: transaction,
      PTD,
      targetDocs,
      TMD,
    })
  })

  // 3. Delete PTDs
  PTDs.forEach((PTD) => {
    transaction.delete(PTD._id)
  })

  try {
    await transaction.commit({ returnDocuments: false })
    return {
      success: true,
      modifiedDocs: mainDocs.map((d) => d._id),
      deletedPTDs: PTDs.map((d) => d._id),
    }
  } catch (error) {
    return {
      error,
    }
  }
}
