import { SanityClient } from 'sanity'
import { MainDocTranslationMetadata, SanityTMD } from '../types'
import { TMD_TYPE, comesFromSanity, draftId, undraftId } from '../utils'
import { tPathInMainDoc } from '../utils/paths'
import {
  ProjectDeletedWebhook,
  ProjectStatusChangedWebhook,
} from './handlePhraseWebhook'

export default async function updateTMDFromProjectWebhook({
  sanityClient,
  payload,
}: {
  sanityClient: SanityClient
  payload: ProjectDeletedWebhook | ProjectStatusChangedWebhook
}) {
  const { project } = payload
  if (!comesFromSanity(project)) {
    return {
      status: 200,
      body: { message: "Project isn't generated by Sanity" },
    } as const
  }

  const TMD = await sanityClient.fetch<SanityTMD | null>(
    `*[_type == "${TMD_TYPE}" && phraseProjectUid == $phraseProjectUid][0]`,
    {
      phraseProjectUid: project.uid,
    },
  )

  if (!TMD) {
    return {
      status: 404,
      body: { error: "Couldn't find matching translation for project" },
    } as const
  }

  const mainDocIds = [
    TMD.sourceDoc._ref,
    ...TMD.targets.map((t) => t.targetDoc._ref),
  ]
  const docsToPatch = await sanityClient.fetch<string[]>('*[_id in $ids]._id', {
    ids: mainDocIds.flatMap((id) => (id ? [undraftId(id), draftId(id)] : [])),
  })

  const newStatus: MainDocTranslationMetadata['status'] =
    payload.event === 'PROJECT_DELETED' ? 'DELETED' : payload.project.status
  const tx = sanityClient.transaction()
  docsToPatch.forEach((id) => {
    tx.patch(id, (patch) =>
      patch.set({
        [`${tPathInMainDoc(TMD.translationKey)}.status`]: newStatus,
      }),
    )
  })

  try {
    await tx.commit({ returnDocuments: false })
    return {
      status: 200,
      body: {
        message: `Updated ${docsToPatch.length} documents with status ${newStatus}`,
      },
    }
  } catch (error) {
    return {
      status: 500,
      body: { error: "Couldn't update statuses", attemptedTx: tx.toJSON() },
    } as const
  }
}