import { createSignal, onCleanup } from 'solid-js'
import type { GpasUploadBatch, SampleKey } from '../../../server/gpasContracts'
import {
  createPairingSession,
  pairingBlockers,
  screenFiles,
  type PairingResult,
} from './fastqPairing'
import { fetchUploadSampleTypes } from '../chatbot/chatApi'
import { invalidateGpasPollingGate } from './gpasUploadApi'
import {
  UploadSession,
  browserUploadEnvironment,
  unitsFromPairing,
  type UploadOutcome,
  type UploadSnapshot,
} from './uploadEngine'

export type UploadPhase = 'idle' | 'uploading' | 'failed'

/** Message text used when the user sends files without typing anything. */
export function uploadFallbackContent(batch: GpasUploadBatch): string {
  return `已上传 ${batch.items.length} 个测序文件`
}

/**
 * Composer-scoped upload state: selection, incremental pairing, upload run and
 * the decision after partial failures. `start` hands the batch to `onReady`
 * only once every file is settled, so the message is sent after the upload.
 */
export function createGpasUploadController(options: {
  currentUser: () => { userName: string | null; externalTeamId: string | null } | undefined
  /** Sample types the team may upload; defaults to the project status endpoint. */
  loadSampleTypes?: () => Promise<{ types: SampleKey[] }>
}) {
  const loadSampleTypes = options.loadSampleTypes ?? fetchUploadSampleTypes
  const pairingSession = createPairingSession()
  const [files, setFiles] = createSignal<File[]>([])
  const [results, setResults] = createSignal<PairingResult<File>[]>([])
  const [validating, setValidating] = createSignal(false)
  const [confirmedSingles, setConfirmedSingles] = createSignal<ReadonlySet<File>>(new Set())
  const [sampleType, setSampleType] = createSignal<SampleKey | null>(null)
  const [availableTypes, setAvailableTypes] = createSignal<SampleKey[] | null>(null)
  const [typesLoading, setTypesLoading] = createSignal(false)
  const [typesError, setTypesError] = createSignal<string | null>(null)
  const [notices, setNotices] = createSignal<string[]>([])
  const [overLimit, setOverLimit] = createSignal(false)
  const [phase, setPhase] = createSignal<UploadPhase>('idle')
  const [snapshot, setSnapshot] = createSignal<UploadSnapshot<File> | null>(null)
  const [failure, setFailure] = createSignal<{ outcome: UploadOutcome; message: string } | null>(null)

  let validationRun = 0
  let session: UploadSession<File> | undefined
  let controller: AbortController | undefined
  let onReady: ((batch: GpasUploadBatch) => void) | undefined
  let frame: number | undefined
  let latest: UploadSnapshot<File> | undefined

  const revalidate = async () => {
    const run = ++validationRun
    const current = files()
    if (current.length === 0) {
      setResults([])
      setValidating(false)
      return
    }
    setValidating(true)
    const detected = await pairingSession.detect(current)
    // A newer selection supersedes this run.
    if (run !== validationRun) return
    setResults(detected)
    setValidating(false)
  }

  const blockers = () => pairingBlockers(results(), confirmedSingles())

  let typesRun = 0
  const loadTypes = async () => {
    if (typesLoading()) return
    const run = ++typesRun
    setTypesLoading(true)
    setTypesError(null)
    try {
      const { types } = await loadSampleTypes()
      if (run !== typesRun) return
      setAvailableTypes(types)
      const current = sampleType()
      if (current && !types.includes(current)) setSampleType(null)
      if (types.length === 1) setSampleType(types[0])
    } catch (error) {
      if (run === typesRun) setTypesError(error instanceof Error && error.message ? error.message : '查询项目样本类型失败')
    } finally {
      if (run === typesRun) setTypesLoading(false)
    }
  }

  /** Why the batch cannot be sent yet, or null when it can. */
  const blockReason = (): string | null => {
    if (files().length === 0) return null
    if (phase() === 'uploading') return '正在上传'
    if (phase() === 'failed') return '请先处理上传失败的文件'
    if (validating() || results().length !== files().length) return '正在校验单双端'
    const types = availableTypes()
    if (types === null) return typesError() ? '样本类型查询失败，请重试' : '正在查询项目样本类型'
    if (types.length === 0) return '项目计划中没有可共同上传的样本类型'
    const type = sampleType()
    if (type === null || !types.includes(type)) return '请先选择样本类型'
    return blockers()[0] ?? null
  }

  const scheduleSnapshot = (next: UploadSnapshot<File>) => {
    latest = next
    if (frame !== undefined) return
    frame = requestAnimationFrame(() => {
      frame = undefined
      if (latest) setSnapshot(latest)
    })
  }

  const beforeUnload = (event: BeforeUnloadEvent) => {
    event.preventDefault()
    event.returnValue = ''
  }

  const finish = (outcome: UploadOutcome) => {
    const type = sampleType()!
    const ready = onReady
    reset()
    ready?.({ sampleType: type, items: outcome.items })
  }

  const runSession = async () => {
    if (!session) return
    controller = new AbortController()
    setFailure(null)
    setPhase('uploading')
    setSnapshot(session.snapshot())
    window.addEventListener('beforeunload', beforeUnload)
    let outcome: UploadOutcome
    try {
      outcome = await session.run(controller.signal)
    } finally {
      window.removeEventListener('beforeunload', beforeUnload)
      controller = undefined
    }
    setSnapshot(session.snapshot())
    if (outcome.items.some(item => item.status === 'uploaded')) {
      const user = options.currentUser()
      invalidateGpasPollingGate(user?.userName, user?.externalTeamId)
    }
    if (outcome.cancelled) {
      // Keep the selection and the typed text; nothing is sent.
      session = undefined
      setPhase('idle')
      setSnapshot(null)
      return
    }
    if (outcome.allUploaded) return finish(outcome)
    setFailure({
      outcome,
      message: outcome.authFailed
        ? '登录已失效，上传已停止。请重新登录后再试。'
        : '部分文件上传失败。可以重试失败的文件，或跳过它们直接发送。',
    })
    setPhase('failed')
  }

  const reset = () => {
    controller?.abort()
    validationRun++
    typesRun++
    session = undefined
    onReady = undefined
    setFiles([])
    setResults([])
    setValidating(false)
    setConfirmedSingles(new Set<File>())
    setSampleType(null)
    // Re-read next time: the project plan may change between batches.
    setAvailableTypes(null)
    setTypesLoading(false)
    setTypesError(null)
    setNotices([])
    setOverLimit(false)
    setPhase('idle')
    setSnapshot(null)
    setFailure(null)
  }

  onCleanup(() => {
    controller?.abort()
    if (frame !== undefined) cancelAnimationFrame(frame)
    window.removeEventListener('beforeunload', beforeUnload)
  })

  return {
    files,
    results,
    validating,
    sampleType,
    setSampleType,
    availableTypes,
    typesLoading,
    typesError,
    retrySampleTypes: () => void loadTypes(),
    blockReason,
    confirmedSingles,
    notices,
    overLimit,
    phase,
    snapshot,
    failure,
    blockers,
    hasFiles: () => files().length > 0,
    busy: () => phase() !== 'idle',
    canStart: () => files().length > 0 && blockReason() === null,

    addFiles(incoming: File[]) {
      if (phase() !== 'idle') return
      const screened = screenFiles(files(), incoming)
      setOverLimit(screened.overLimit)
      setNotices(screened.rejected)
      if (screened.accepted.length === 0) return
      setFiles([...files(), ...screened.accepted])
      void revalidate()
      if (availableTypes() === null && !typesLoading()) void loadTypes()
    },

    removeFile(file: File) {
      if (phase() !== 'idle') return
      pairingSession.forget(file)
      setFiles(files().filter(item => item !== file))
      const next = new Set(confirmedSingles())
      next.delete(file)
      setConfirmedSingles(next)
      setOverLimit(false)
      void revalidate()
    },

    confirmSingle(file: File, confirmed: boolean) {
      const next = new Set(confirmedSingles())
      if (confirmed) next.add(file)
      else next.delete(file)
      setConfirmedSingles(next)
    },

    /** Uploads the batch; `ready` receives the results once every file settled. */
    start(ready: (batch: GpasUploadBatch) => void) {
      const type = sampleType()
      if (!type || blockReason() !== null) return
      onReady = ready
      session = new UploadSession(unitsFromPairing(results()), type, browserUploadEnvironment(), {}, scheduleSnapshot)
      void runSession()
    },

    retryFailed() {
      if (phase() === 'failed' && !failure()?.outcome.authFailed) void runSession()
    },

    sendWithFailures() {
      const current = failure()
      if (phase() === 'failed' && current && !current.outcome.authFailed) finish(current.outcome)
    },

    cancel() {
      if (phase() === 'uploading') controller?.abort()
      else if (phase() === 'failed') {
        session = undefined
        onReady = undefined
        setPhase('idle')
        setSnapshot(null)
        setFailure(null)
      }
    },

    reset,
  }
}

export type GpasUploadController = ReturnType<typeof createGpasUploadController>
