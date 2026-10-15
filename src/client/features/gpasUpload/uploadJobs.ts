import { createSignal } from 'solid-js'
import { createStore, produce } from 'solid-js/store'
import type { GpasUploadBatch, SampleKey } from '../../../server/gpasContracts'
import type { PairingResult } from './fastqPairing'
import { invalidateGpasPollingGate } from './gpasUploadApi'
import {
  UploadSession,
  browserUploadEnvironment,
  unitsFromPairing,
  type UploadOutcome,
  type UploadSnapshot,
} from './uploadEngine'

/** A validated composer selection, handed over when the user sends. */
export type UploadSelection = {
  files: File[]
  results: PairingResult<File>[]
  confirmedSingles: ReadonlySet<File>
  sampleType: SampleKey
}

export type UploadJobState = {
  conversationId: string
  phase: 'uploading' | 'failed'
  snapshot: UploadSnapshot<File>
  failure?: { message: string; authFailed: boolean }
}

type Job = {
  conversationId: string
  selection: UploadSelection
  session: UploadSession<File>
  currentUser: () => { userName: string | null; externalTeamId: string | null } | undefined
  /** Receives the results once every file settled (or the user skipped failures). */
  onReady: (batch: GpasUploadBatch) => void
  /** The user cancelled; nothing was sent. */
  onCancel: () => void
  controller?: AbortController
  outcome?: UploadOutcome
  frame?: number
  latest?: UploadSnapshot<File>
}

/*
 * Upload jobs live at module level, outside any component, so an upload keeps
 * running while the user moves between the home page and conversations. A job
 * is keyed by the client id of the message waiting for it.
 */
const jobs = new Map<string, Job>()
const [jobStates, setJobStates] = createStore<Record<string, UploadJobState>>({})

/** Selections returned by a cancelled upload, per conversation, for its composer to take back. */
const restored = new Map<string, UploadSelection>()
const [restoredVersion, setRestoredVersion] = createSignal(0)

const beforeUnload = (event: BeforeUnloadEvent) => {
  event.preventDefault()
  event.returnValue = ''
}

const syncUnloadGuard = () => {
  window.removeEventListener('beforeunload', beforeUnload)
  if (jobs.size > 0) window.addEventListener('beforeunload', beforeUnload)
}

const drop = (id: string) => {
  const job = jobs.get(id)
  if (!job) return
  if (job.frame !== undefined) cancelAnimationFrame(job.frame)
  jobs.delete(id)
  setJobStates(produce((states) => { delete states[id] }))
  syncUnloadGuard()
}

const settle = (id: string, job: Job, outcome: UploadOutcome) => {
  drop(id)
  job.onReady({ sampleType: job.selection.sampleType, items: outcome.items })
}

const giveBack = (id: string, job: Job) => {
  drop(id)
  restored.set(job.conversationId, job.selection)
  setRestoredVersion((version) => version + 1)
  job.onCancel()
}

const run = async (id: string) => {
  const job = jobs.get(id)
  if (!job) return
  const controller = new AbortController()
  job.controller = controller
  job.outcome = undefined
  setJobStates(id, { phase: 'uploading', failure: undefined, snapshot: job.session.snapshot() })
  let outcome: UploadOutcome
  try {
    outcome = await job.session.run(controller.signal)
  } finally {
    job.controller = undefined
  }
  // Discarded meanwhile, e.g. its conversation was deleted.
  if (jobs.get(id) !== job) return
  setJobStates(id, 'snapshot', job.session.snapshot())
  if (outcome.items.some((item) => item.status === 'uploaded')) {
    const user = job.currentUser()
    invalidateGpasPollingGate(user?.userName, user?.externalTeamId)
  }
  if (outcome.cancelled) return giveBack(id, job)
  if (outcome.allUploaded) return settle(id, job, outcome)
  job.outcome = outcome
  setJobStates(id, {
    phase: 'failed',
    failure: {
      authFailed: outcome.authFailed,
      message: outcome.authFailed
        ? '登录已失效，上传已停止。请重新登录后再试。'
        : '部分文件上传失败。可以重试失败的文件，或跳过它们直接发送。',
    },
  })
}

export function startUploadJob(
  id: string,
  input: Pick<Job, 'conversationId' | 'selection' | 'currentUser' | 'onReady' | 'onCancel'>,
) {
  const job: Job = {
    ...input,
    session: new UploadSession(
      unitsFromPairing(input.selection.results),
      input.selection.sampleType,
      browserUploadEnvironment(),
      {},
      (snapshot) => {
        // Progress events are frequent; publish at most once per frame.
        job.latest = snapshot
        if (job.frame !== undefined) return
        job.frame = requestAnimationFrame(() => {
          job.frame = undefined
          if (job.latest && jobs.get(id) === job) setJobStates(id, 'snapshot', job.latest)
        })
      },
    ),
  }
  jobs.set(id, job)
  setJobStates(id, { conversationId: input.conversationId, phase: 'uploading', snapshot: job.session.snapshot() })
  syncUnloadGuard()
  void run(id)
}

export const uploadJob = (id: string): UploadJobState | undefined => jobStates[id]

export const conversationHasUpload = (conversationId: string) =>
  Object.values(jobStates).some((state) => state.conversationId === conversationId)

export function retryUploadJob(id: string) {
  const job = jobs.get(id)
  if (job?.outcome && !job.outcome.authFailed) void run(id)
}

export function sendUploadJobWithFailures(id: string) {
  const job = jobs.get(id)
  if (job?.outcome && !job.outcome.authFailed) settle(id, job, job.outcome)
}

export function cancelUploadJob(id: string) {
  const job = jobs.get(id)
  if (!job) return
  if (job.controller) job.controller.abort()
  else giveBack(id, job)
}

/** Stops every upload of a conversation that is going away; no callbacks run. */
export function discardConversationUploads(conversationId: string) {
  for (const [id, job] of [...jobs]) {
    if (job.conversationId !== conversationId) continue
    drop(id)
    job.controller?.abort()
  }
  restored.delete(conversationId)
}

/** Takes back the selection of a cancelled upload, once. Reactive. */
export function takeRestoredSelection(conversationId: string): UploadSelection | undefined {
  restoredVersion()
  const selection = restored.get(conversationId)
  restored.delete(conversationId)
  return selection
}
