import { SanityClient } from 'sanity'
import { mergeDocs } from './mergeDocs'
import { SanityDocumentWithPhraseMetadata, SanityPTD, SanityTMD } from './types'
import { draftId, isPTDDoc, undraftId } from './utils'
import { diffPatch } from 'sanity-diff-patch'

/**
 * Assumes PTD has been already refreshed with Phrase data and is ready to be merged.
 */
export default async function mergePTD({
  sanityClient,
  PTD,
}: {
  sanityClient: SanityClient
  PTD: SanityPTD
}) {
  if (!isPTDDoc(PTD)) {
    return { error: 'Not a valid PTD' }
  }

  const {
    targetDoc: { _ref: targetRef },
  } = PTD.phraseMetadata

  const { targetDocs, TMD } = await sanityClient.fetch<{
    targetDocs: SanityDocumentWithPhraseMetadata[]
    TMD: SanityTMD
  }>(
    `{
      "targetDocs": *[_id in $targetIds],
      "TMD": *[_id == $TMDRef][0]
    }`,
    {
      targetIds: [undraftId(targetRef), draftId(targetRef)],
      TMDRef: PTD.phraseMetadata.tmd._ref,
    },
  )

  const transaction = sanityClient.transaction()
  targetDocs.forEach((freshTargetDoc) => {
    const newTargetDoc = {
      ...mergeDocs({
        originalDoc: freshTargetDoc,
        changedDoc: PTD,
        paths: TMD.paths,
      }),
      phraseMetadata: freshTargetDoc.phraseMetadata,
    }
    const patches = diffPatch(freshTargetDoc, newTargetDoc, {
      // Prevent modifying target doc if its _rev has changed since the function started running
      ifRevisionID: true,
    })
    for (const { patch } of patches) {
      transaction.patch(patch.id, patch)
    }
  })

  try {
    await transaction.commit()
    return {
      success: true,
      modifiedDocs: targetDocs.map((d) => d._id),
    }
  } catch (error) {
    return {
      error,
    }
  }
}