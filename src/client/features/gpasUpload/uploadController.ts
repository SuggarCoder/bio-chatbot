import { createSignal } from 'solid-js'
import type { SampleKey } from '../../../server/gpasContracts'
import {
  createPairingSession,
  pairingBlockers,
  screenFiles,
  type PairingResult,
} from './fastqPairing'
import { fetchUploadSampleTypes } from '../chatbot/chatApi'
import type { UploadSelection } from './uploadJobs'

/** Message text used when the user sends files without typing anything. */
export function uploadFallbackContent(fileCount: number): string {
  return `已上传 ${fileCount} 个测序文件`
}

/**
 * Composer-scoped selection state: files, incremental pairing and sample type.
 * `take` hands a validated selection over for upload and clears the composer;
 * the upload itself runs in `uploadJobs`, outside the component, so it
 * survives navigation.
 */
export function createGpasUploadController(options: {
  /** Sample types the team may upload; defaults to the project status endpoint. */
  loadSampleTypes?: () => Promise<{ types: SampleKey[] }>
} = {}) {
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

  let validationRun = 0

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
    if (validating() || results().length !== files().length) return '正在校验单双端'
    const types = availableTypes()
    if (types === null) return typesError() ? '样本类型查询失败，请重试' : '正在查询项目样本类型'
    if (types.length === 0) return '项目计划中没有可共同上传的样本类型'
    const type = sampleType()
    if (type === null || !types.includes(type)) return '请先选择样本类型'
    return blockers()[0] ?? null
  }

  const reset = () => {
    validationRun++
    typesRun++
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
  }

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
    blockers,
    hasFiles: () => files().length > 0,
    canStart: () => files().length > 0 && blockReason() === null,

    addFiles(incoming: File[]) {
      const screened = screenFiles(files(), incoming)
      setOverLimit(screened.overLimit)
      setNotices(screened.rejected)
      if (screened.accepted.length === 0) return
      setFiles([...files(), ...screened.accepted])
      void revalidate()
      if (availableTypes() === null && !typesLoading()) void loadTypes()
    },

    removeFile(file: File) {
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

    /** Hands the selection over for upload and clears the composer; null when it cannot be sent. */
    take(): UploadSelection | null {
      const type = sampleType()
      if (!type || blockReason() !== null) return null
      const selection = { files: files(), results: results(), confirmedSingles: confirmedSingles(), sampleType: type }
      reset()
      return selection
    },

    /** Puts back a selection whose upload was cancelled. */
    restore(selection: UploadSelection) {
      reset()
      setFiles(selection.files)
      setConfirmedSingles(selection.confirmedSingles)
      setSampleType(selection.sampleType)
      void revalidate()
      void loadTypes()
    },

    reset,
  }
}

export type GpasUploadController = ReturnType<typeof createGpasUploadController>
