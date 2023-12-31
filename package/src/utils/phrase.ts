import { DocumentStore, createHookFromObservableFactory } from 'sanity'
import {
  PhraseDatacenterRegion,
  getPhraseBaseUrl,
} from '../clients/createPhraseClient'
import {
  CrossSystemLangCode,
  METADATA_KEY,
  Phrase,
  PhraseJobInfo,
  PtdPhraseMetadata,
  SanityDocumentWithPhraseMetadata,
  SanityMainDoc,
  SanityPTD,
  SanityTMD,
} from '../types'
import { FILENAME_PREFIX } from './constants'
import { isPtdId } from './ids'
import { langsAreTheSame } from './langs'

export function jobsMetadataExtractor(jobs: PhraseJobInfo[]) {
  const earlyStepsFirst = sortJobsByWorkflowLevel(jobs).reverse()
  const lastJob = earlyStepsFirst[earlyStepsFirst.length - 1]
  const furthestOngoingJob =
    earlyStepsFirst.find((job) => jobIsOngoing(job)) || lastJob

  return {
    stepName: furthestOngoingJob?.workflowStep?.name || 'Ongoing',
    stepStatus: furthestOngoingJob?.status || 'NEW',
    due: lastJob?.dateDue,
    activeJobUid: furthestOngoingJob?.uid,
  }
}

export function getProjectURL(
  projectUid: string,
  region: PhraseDatacenterRegion,
) {
  return `${getPhraseBaseUrl(region)}/project2/show/${projectUid}`
}

export function getJobEditorURL(
  jobUid: string,
  region: PhraseDatacenterRegion,
) {
  return `${getPhraseBaseUrl(region)}/job/${jobUid}/translate/`
}

export const usePtdState = createHookFromObservableFactory<
  PtdPhraseMetadata,
  {
    documentStore: DocumentStore
    /** published version */
    ptdId: SanityPTD['_id']
  }
>((props) => {
  return props.documentStore.listenQuery(
    /* groq */ `*[_id == $id][0].${METADATA_KEY}`,
    { id: props.ptdId },
    {
      apiVersion: '2023-05-22',
      throttleTime: 3500,
      perspective: 'previewDrafts',
    },
  )
})

const cancelledStatuses: PhraseJobInfo['status'][] = [
  'CANCELLED',
  'DECLINED',
  'REJECTED',
]

export function jobIsCancelled(job: Pick<PhraseJobInfo, 'status'>) {
  return cancelledStatuses.includes(job.status)
}

export function jobIsComplete(job: Pick<PhraseJobInfo, 'status'>) {
  return job.status === 'COMPLETED' || job.status === 'COMPLETED_BY_LINGUIST'
}

function jobIsOngoing(job: Pick<PhraseJobInfo, 'status'>) {
  return !jobIsCancelled(job) && !jobIsComplete(job)
}

export function getLastValidJobInWorkflow(jobs: PhraseJobInfo[]) {
  return sortJobsByWorkflowLevel(jobs).filter((j) => !jobIsCancelled(j))[0] as
    | PhraseJobInfo
    | undefined
}

/** Later steps come first */
export function sortJobsByWorkflowLevel(jobs: PhraseJobInfo[]) {
  return jobs.sort((a, b) => {
    if (typeof a.workflowLevel !== 'number') return 1
    if (typeof b.workflowLevel !== 'number') return -1

    return b.workflowLevel - a.workflowLevel
  })
}

export function isPTDDoc(
  doc: SanityDocumentWithPhraseMetadata,
): doc is SanityPTD {
  return isPtdId(doc._id) && doc.phraseMetadata?._type === 'phrase.ptd.meta'
}

export function isMainDoc(
  doc: SanityDocumentWithPhraseMetadata,
): doc is SanityMainDoc {
  return !isPtdId(doc._id)
}

export function hasTranslationsUnfinished(TMDs: SanityTMD[]) {
  return TMDs.some((t) => !isTranslationCommitted(t))
}

export function langInTMDs(TMDs: SanityTMD[], lang: CrossSystemLangCode) {
  return TMDs.some(
    (TMD) =>
      'targets' in TMD &&
      TMD.targets.some((t) => langsAreTheSame(t.lang, lang)),
  )
}

/**
 * All `targetLangs` are ongoing.
 */
export function allTranslationsUnfinished(
  TMDs: SanityTMD[],
  targetLangs: CrossSystemLangCode[],
) {
  return (
    hasTranslationsUnfinished(TMDs) &&
    targetLangs.every((l) =>
      TMDs.some(
        (t) =>
          !isTranslationCommitted(t) &&
          'targets' in t &&
          t.targets.some(({ lang }) => langsAreTheSame(l, lang)),
      ),
    )
  )
}

export function isTranslationCommitted(
  translation: SanityTMD,
): translation is SanityTMD<'COMMITTED'> {
  return translation.status === 'COMMITTED'
}

export function isTranslationCancelled(
  translation: SanityTMD,
): translation is SanityTMD<'DELETED'> | SanityTMD<'CANCELLED'> {
  return translation.status === 'DELETED' || translation.status === 'CANCELLED'
}

export function isTranslationReadyToCommit(
  translation: SanityTMD,
): translation is SanityTMD<'COMPLETED'> {
  return translation.status === 'COMPLETED'
}

export function isTranslationFailedPersisting(
  translation: SanityTMD,
): translation is SanityTMD<'FAILED_PERSISTING'> {
  return translation.status === 'FAILED_PERSISTING'
}

export function isTranslationCreating(
  translation: SanityTMD,
): translation is SanityTMD<'CREATING'> {
  return translation.status === 'CREATING'
}

export function phraseDatetimeToJSDate<D extends string | undefined>(
  phraseDate?: D,
) {
  if (!phraseDate) return undefined as D extends undefined ? undefined : Date

  try {
    return new Date(phraseDate) as D extends undefined ? undefined : Date
  } catch (error) {
    return new Date(phraseDate.split('+')[0]) as D extends undefined
      ? undefined
      : Date
  }
}

export function comesFromSanity(
  entity:
    | Pick<Phrase['JobPart'], 'filename'>
    | Pick<Phrase['JobInWebhook'], 'fileName'>
    | Pick<Phrase['CreatedProject'], 'name'>,
) {
  const name = (() => {
    if ('filename' in entity) return entity.filename

    if ('fileName' in entity) return entity.fileName

    if ('name' in entity) return entity.name

    return undefined
  })()

  return name && name.startsWith(FILENAME_PREFIX)
}

export function getTranslationSnapshot(doc: SanityDocumentWithPhraseMetadata) {
  return JSON.stringify({
    ...doc,
    [METADATA_KEY]: undefined,
  }) as SanityTMD['sourceSnapshot']
}

export function parseTranslationSnapshot(
  doc: SanityTMD['sourceSnapshot'] | SanityDocumentWithPhraseMetadata,
) {
  if (typeof doc === 'object') return doc

  try {
    return JSON.parse(doc) as SanityDocumentWithPhraseMetadata
  } catch (error) {
    return undefined
  }
}
