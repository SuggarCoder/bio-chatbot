/**
 * Chunked GPAS upload engine, independent of UI.
 *
 * - One chunk size drives both `totalPieces` and slicing.
 * - One concurrency pool is shared by every chunk of every file; R1 and R2 of
 *   a pair upload side by side.
 * - Abort scopes: batch → unit (single file or pair) → chunk. When a chunk runs
 *   out of attempts the rest of its unit is aborted and awaited before the unit
 *   is marked failed, so no request outlives its file.
 * - Every retryable failure spends an attempt (bounded, exponential backoff with
 *   jitter); only a browser-reported offline state waits without spending one.
 * - A file is uploaded only when every chunk number has been acknowledged.
 * - `run()` can be called again: uploaded units are skipped and failed ones
 *   resume on their existing task, recreating it if GPAS rejects the resume.
 */
import type { GpasUploadItem, SampleKey } from '../../../server/gpasContracts'
import {
  CHUNK_SIZE,
  UploadError,
  buildFileMN,
  cancelledError,
  gpasUploadTransport,
  isUploadError,
  sha256Hex,
  type UploadChannel,
  type UploadTransport,
} from './gpasUploadApi'

export type UploadFile = Blob & { readonly name: string }

export type UploadUnit<F extends UploadFile> =
  | { kind: 'single'; file: F }
  | { kind: 'paired'; r1: F; r2: F }

export type FileStatus = 'pending' | 'preparing' | 'uploading' | 'uploaded' | 'failed' | 'cancelled'

export type FileProgress = {
  status: FileStatus
  sentBytes: number
  totalBytes: number
  error?: string
}

export type UploadSnapshot<F extends UploadFile> = {
  files: ReadonlyMap<F, FileProgress>
  sentBytes: number
  totalBytes: number
}

export type UploadOutcome = {
  items: GpasUploadItem[]
  allUploaded: boolean
  /** The session expired: the whole batch stopped and the user must log in again. */
  authFailed: boolean
  cancelled: boolean
}

export type UploadEnvironment = {
  transport: UploadTransport
  hash: (chunk: Blob) => Promise<string>
  fileMN: (file: Blob) => Promise<string>
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
  random: () => number
  isOnline: () => boolean
  waitOnline: (signal: AbortSignal) => Promise<void>
}

export type UploadOptions = {
  chunkSize: number
  concurrency: number
  /** Attempts per chunk (and per task creation), including the first. */
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
  stallTimeoutMs: number
  responseTimeoutMs: number
}

export const defaultUploadOptions: UploadOptions = {
  chunkSize: CHUNK_SIZE,
  concurrency: 3,
  maxAttempts: 6,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  stallTimeoutMs: 30_000,
  responseTimeoutMs: 60_000,
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(cancelledError())
    const onAbort = () => {
      clearTimeout(timer)
      reject(cancelledError())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function waitForOnline(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(cancelledError())
    if (navigator.onLine) return resolve()
    const cleanup = () => {
      window.removeEventListener('online', onOnline)
      signal.removeEventListener('abort', onAbort)
    }
    const onOnline = () => { cleanup(); resolve() }
    const onAbort = () => { cleanup(); reject(cancelledError()) }
    window.addEventListener('online', onOnline)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export const browserUploadEnvironment = (): UploadEnvironment => ({
  transport: gpasUploadTransport,
  hash: sha256Hex,
  fileMN: buildFileMN,
  sleep: abortableSleep,
  random: Math.random,
  isOnline: () => navigator.onLine,
  waitOnline: waitForOnline,
})

/** FIFO limiter whose waiters leave the queue when their signal aborts. */
class Pool {
  private active = 0
  private waiters: Array<{ grant: () => void }> = []

  constructor(private readonly limit: number) {}

  async run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    await this.acquire(signal)
    try {
      return await task()
    } finally {
      this.release()
    }
  }

  private acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(cancelledError())
    if (this.active < this.limit) {
      this.active++
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        grant: () => {
          signal.removeEventListener('abort', onAbort)
          this.active++
          resolve()
        },
      }
      const onAbort = () => {
        this.waiters = this.waiters.filter(item => item !== waiter)
        reject(cancelledError())
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  private release() {
    this.active--
    this.waiters.shift()?.grant()
  }
}

/** Child controller that follows its parent; dispose to drop the listener. */
function childController(parent: AbortSignal) {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (parent.aborted) controller.abort()
  else parent.addEventListener('abort', onAbort, { once: true })
  return { controller, dispose: () => parent.removeEventListener('abort', onAbort) }
}

type FileState = {
  status: FileStatus
  totalPieces: number
  acked: Set<number>
  ackedBytes: number
  inflight: Map<number, number>
  /** GPAS id for chunk uploads: uploadId (single) or per-file fileId (pair). */
  taskId?: string
  error?: string
}

type UnitState = { groupId?: string; taskReady: boolean }

const opaqueIdPattern = /^[\w.:-]{1,128}$/
const terminal = (status: FileStatus) => status === 'uploaded' || status === 'failed' || status === 'cancelled'

export class UploadSession<F extends UploadFile> {
  private readonly options: UploadOptions
  private readonly files = new Map<F, FileState>()
  private readonly unitStates = new Map<UploadUnit<F>, UnitState>()
  private authFailed = false
  private cancelled = false
  private running = false

  constructor(
    private readonly units: readonly UploadUnit<F>[],
    private readonly sampleType: SampleKey,
    private readonly env: UploadEnvironment = browserUploadEnvironment(),
    options: Partial<UploadOptions> = {},
    private readonly onChange: (snapshot: UploadSnapshot<F>) => void = () => {},
  ) {
    this.options = { ...defaultUploadOptions, ...options }
    for (const unit of units) {
      this.unitStates.set(unit, { taskReady: false })
      for (const file of unitFiles(unit)) {
        this.files.set(file, {
          status: 'pending',
          totalPieces: Math.max(1, Math.ceil(file.size / this.options.chunkSize)),
          acked: new Set(),
          ackedBytes: 0,
          inflight: new Map(),
        })
      }
    }
  }

  totalPieces(file: F): number {
    return this.state(file).totalPieces
  }

  snapshot(): UploadSnapshot<F> {
    const files = new Map<F, FileProgress>()
    let sentBytes = 0
    let totalBytes = 0
    for (const [file, state] of this.files) {
      let inflight = 0
      for (const bytes of state.inflight.values()) inflight += bytes
      const sent = Math.min(file.size, state.ackedBytes + inflight)
      files.set(file, { status: state.status, sentBytes: sent, totalBytes: file.size, error: state.error })
      sentBytes += sent
      totalBytes += file.size
    }
    return { files, sentBytes, totalBytes }
  }

  /** Uploads every unit that is not uploaded yet. Not re-entrant. */
  async run(signal: AbortSignal): Promise<UploadOutcome> {
    if (this.running) throw new Error('Upload session is already running')
    this.running = true
    this.authFailed = false
    this.cancelled = false
    const batch = childController(signal)
    const pool = new Pool(this.options.concurrency)
    const pending = this.units.filter(unit => unitFiles(unit).some(file => this.state(file).status !== 'uploaded'))
    for (const unit of pending) {
      for (const file of unitFiles(unit)) this.update(file, { status: 'pending', error: undefined })
    }
    try {
      await Promise.all(pending.map(unit => this.runUnit(unit, pool, batch.controller)))
    } finally {
      batch.dispose()
      this.running = false
    }
    this.cancelled = signal.aborted
    return this.outcome()
  }

  outcome(): UploadOutcome {
    let pairIndex = 0
    const items = this.units.flatMap((unit): GpasUploadItem[] => {
      if (unit.kind === 'single') return [this.item(unit.file, { layout: 'single' })]
      const pairKey = `P${++pairIndex}`
      const groupId = this.unitStates.get(unit)!.groupId
      return [
        this.item(unit.r1, { layout: 'paired', role: 'R1', pairKey, groupId }),
        this.item(unit.r2, { layout: 'paired', role: 'R2', pairKey, groupId }),
      ]
    })
    return {
      items,
      allUploaded: items.every(item => item.status === 'uploaded'),
      authFailed: this.authFailed,
      cancelled: this.cancelled,
    }
  }

  private item(file: F, extra: Pick<GpasUploadItem, 'layout' | 'role' | 'pairKey' | 'groupId'>): GpasUploadItem {
    const state = this.state(file)
    const status = state.status === 'uploaded' ? 'uploaded' : state.status === 'failed' ? 'failed' : 'cancelled'
    const item: GpasUploadItem = { name: file.name, sizeBytes: file.size, status, layout: extra.layout }
    if (extra.role) item.role = extra.role
    if (extra.pairKey) item.pairKey = extra.pairKey
    // Server-side schema accepts only plain identifiers; drop anything else.
    if (extra.groupId && opaqueIdPattern.test(extra.groupId)) item.groupId = extra.groupId
    if (state.taskId && opaqueIdPattern.test(state.taskId)) item.fileId = state.taskId
    if (status === 'failed' && state.error) item.error = state.error.slice(0, 500)
    return item
  }

  private async runUnit(unit: UploadUnit<F>, pool: Pool, batch: AbortController): Promise<void> {
    const files = unitFiles(unit)
    const resuming = this.unitStates.get(unit)!.taskReady
    try {
      let recreated = false
      for (;;) {
        // A fresh scope per attempt: a failed attempt aborts its own scope.
        const scope = childController(batch.signal)
        try {
          if (!this.unitStates.get(unit)!.taskReady) await this.createTask(unit, scope.controller.signal)
          for (const file of files) this.update(file, { status: 'uploading' })
          await this.uploadUnitChunks(unit, pool, scope.controller, batch)
          for (const file of files) this.update(file, { status: 'uploaded' })
          return
        } catch (error) {
          const failure = this.normalize(error, scope.controller.signal)
          // A resumed task GPAS no longer accepts: start over once with a new task.
          if (resuming && !recreated && (failure.kind === 'client' || failure.kind === 'business') && !batch.signal.aborted) {
            recreated = true
            this.resetUnit(unit)
            continue
          }
          throw failure
        } finally {
          scope.dispose()
        }
      }
    } catch (error) {
      const failure = this.normalize(error, batch.signal)
      if (failure.kind === 'auth') {
        this.authFailed = true
        batch.abort()
      }
      for (const file of files) {
        if (failure.kind === 'cancelled') {
          this.update(file, this.authFailed
            ? { status: 'failed', error: '登录已失效，请重新登录后再试。' }
            : { status: 'cancelled', error: undefined })
        } else this.update(file, { status: 'failed', error: failure.message })
      }
    }
  }

  private async createTask(unit: UploadUnit<F>, signal: AbortSignal): Promise<void> {
    const unitState = this.unitStates.get(unit)!
    const files = unitFiles(unit)
    for (const file of files) this.update(file, { status: 'preparing' })
    const metas = await Promise.all(files.map(async file => ({
      name: file.name,
      size: file.size,
      totalPieces: this.state(file).totalPieces,
      fileMN: await this.env.fileMN(file),
    })))

    if (unit.kind === 'single') {
      const uploadId = await this.withRetry(signal, () => this.env.transport.createSingleTask({ ...metas[0], sampleType: this.sampleType }, signal))
      this.state(unit.file).taskId = uploadId
    } else {
      const task = await this.withRetry(signal, () => this.env.transport.createDualTask({ files: [metas[0], metas[1]], sampleType: this.sampleType }, signal))
      // Map strictly by name; never fall back to response order.
      const r1 = task.fileList.filter(entry => entry.name === unit.r1.name)
      const r2 = task.fileList.filter(entry => entry.name === unit.r2.name)
      if (r1.length !== 1 || r2.length !== 1 || r1[0].fileId === r2[0].fileId) {
        throw new UploadError('mapping', '双端任务返回的文件与提交的文件名不一致，已停止上传该组。')
      }
      const endTypes = [r1[0].endType, r2[0].endType]
      if (endTypes.every(value => value !== undefined && value !== null && value !== '') && String(endTypes[0]) === String(endTypes[1])) {
        throw new UploadError('mapping', '双端任务返回的两个文件端类型相同，已停止上传该组。')
      }
      this.state(unit.r1).taskId = r1[0].fileId
      this.state(unit.r2).taskId = r2[0].fileId
      unitState.groupId = task.groupId
    }
    unitState.taskReady = true
  }

  private async uploadUnitChunks(unit: UploadUnit<F>, pool: Pool, scope: AbortController, batch: AbortController): Promise<void> {
    const channel: UploadChannel = unit.kind === 'paired' ? 'dual' : 'single'
    let firstFailure: unknown
    const queues = unitFiles(unit).map(file => {
      const state = this.state(file)
      const missing: number[] = []
      for (let no = 0; no < state.totalPieces; no++) if (!state.acked.has(no)) missing.push(no)
      return { file, missing }
    })
    // Interleave R1/R2 chunks so both files of a pair progress together.
    const order: Array<{ file: F; no: number }> = []
    for (let index = 0; queues.some(queue => index < queue.missing.length); index++) {
      for (const queue of queues) if (index < queue.missing.length) order.push({ file: queue.file, no: queue.missing[index] })
    }
    // Runs while the failing chunk still holds its slot, so no sibling starts
    // in the gap. Keeps the real cause; aborted siblings report "cancelled".
    const onFatal = (failure: UploadError) => {
      if (firstFailure !== undefined) return
      firstFailure = failure
      if (failure.kind === 'auth') {
        // Flag before aborting so other units report the login failure, not "cancelled".
        this.authFailed = true
        batch.abort()
      }
      scope.abort()
    }
    const jobs = order.map(({ file, no }) => this.uploadChunk(file, no, channel, pool, scope.signal, onFatal).catch(error => {
      if (firstFailure === undefined) {
        firstFailure = error
        scope.abort()
      }
    }))
    // Wait for every chunk of the unit to stop before deciding its status.
    await Promise.all(jobs)
    if (firstFailure !== undefined) throw firstFailure
    for (const file of unitFiles(unit)) {
      const state = this.state(file)
      if (state.acked.size !== state.totalPieces) throw new UploadError('server', '部分分片未确认，上传未完成。')
    }
  }

  private async uploadChunk(
    file: F,
    no: number,
    channel: UploadChannel,
    pool: Pool,
    signal: AbortSignal,
    onFatal: (failure: UploadError) => void,
  ): Promise<void> {
    const state = this.state(file)
    const start = no * this.options.chunkSize
    const chunk = file.slice(start, Math.min(start + this.options.chunkSize, file.size))
    let hash: string | undefined
    await this.withRetry(signal, (attempts) => pool.run(signal, async () => {
      try {
        if (signal.aborted) throw cancelledError()
        // Hash inside the slot so at most `concurrency` chunks are in memory.
        hash ??= await this.env.hash(chunk)
        await this.env.transport.uploadSlice({
            channel,
            uploadId: state.taskId!,
            fileName: file.name,
            no,
            chunk,
            hash,
            signal,
            stallTimeoutMs: this.options.stallTimeoutMs,
            responseTimeoutMs: this.options.responseTimeoutMs,
          onProgress: (loaded) => {
            if (signal.aborted || terminal(state.status) || state.acked.has(no)) return
            state.inflight.set(no, Math.min(loaded, chunk.size))
            this.emit()
          },
        })
      } catch (error) {
        state.inflight.delete(no)
        this.emit()
        const failure = this.normalize(error, signal)
        if (failure.kind !== 'cancelled' && this.retryDecision(failure, attempts) === 'final') onFatal(failure)
        throw failure
      }
    }))
    state.inflight.delete(no)
    if (!state.acked.has(no)) {
      state.acked.add(no)
      state.ackedBytes += chunk.size
    }
    this.emit()
  }

  /** `attempts` counts failed attempts before this one. */
  private retryDecision(failure: UploadError, attempts: number): 'final' | 'wait_online' | 'retry' {
    if (failure.kind === 'cancelled') return 'final'
    if (failure.kind === 'offline' || (failure.kind === 'network' && !this.env.isOnline())) return 'wait_online'
    return failure.retryable && attempts + 1 < this.options.maxAttempts ? 'retry' : 'final'
  }

  private async withRetry<T>(signal: AbortSignal, operation: (attempts: number) => Promise<T>): Promise<T> {
    let attempts = 0
    for (;;) {
      if (signal.aborted) throw cancelledError()
      try {
        return await operation(attempts)
      } catch (error) {
        const failure = this.normalize(error, signal)
        const decision = this.retryDecision(failure, attempts)
        if (decision === 'final') throw failure
        if (decision === 'wait_online') {
          await this.env.waitOnline(signal)
          continue
        }
        attempts++
        await this.env.sleep(this.backoff(attempts), signal)
      }
    }
  }

  /** Exponential backoff with equal jitter: [cap/2, cap). */
  backoff(attempt: number): number {
    const cap = Math.min(this.options.maxDelayMs, this.options.baseDelayMs * 2 ** (attempt - 1))
    return Math.round(cap / 2 + this.env.random() * cap / 2)
  }

  private normalize(error: unknown, signal: AbortSignal): UploadError {
    if (isUploadError(error)) return error
    if (signal.aborted) return cancelledError()
    return new UploadError('network', error instanceof Error ? error.message : '上传失败')
  }

  private resetUnit(unit: UploadUnit<F>) {
    this.unitStates.set(unit, { taskReady: false })
    for (const file of unitFiles(unit)) {
      const state = this.state(file)
      state.acked.clear()
      state.ackedBytes = 0
      state.inflight.clear()
      state.taskId = undefined
    }
    this.emit()
  }

  private state(file: F): FileState {
    const state = this.files.get(file)
    if (!state) throw new Error('Unknown upload file')
    return state
  }

  private update(file: F, patch: Partial<Pick<FileState, 'status' | 'error'>>) {
    const state = this.state(file)
    Object.assign(state, patch)
    if (terminal(state.status)) state.inflight.clear()
    this.emit()
  }

  private emit() {
    this.onChange(this.snapshot())
  }
}

export function unitFiles<F extends UploadFile>(unit: UploadUnit<F>): F[] {
  return unit.kind === 'single' ? [unit.file] : [unit.r1, unit.r2]
}

/** Builds upload units from a pairing that has no blockers. */
export function unitsFromPairing<F extends UploadFile>(
  results: readonly { file: F; status: string; readType: 1 | 2 | null; pairGroupId: string | null }[],
): UploadUnit<F>[] {
  const units: UploadUnit<F>[] = []
  const seenGroups = new Set<string>()
  for (const result of results) {
    if (result.status !== 'paired' || !result.pairGroupId) {
      units.push({ kind: 'single', file: result.file })
      continue
    }
    if (seenGroups.has(result.pairGroupId)) continue
    seenGroups.add(result.pairGroupId)
    const members = results.filter(other => other.pairGroupId === result.pairGroupId)
    const r1 = members.find(member => member.readType === 1)
    const r2 = members.find(member => member.readType === 2)
    if (members.length !== 2 || !r1 || !r2) throw new Error('Invalid pairing group')
    units.push({ kind: 'paired', r1: r1.file, r2: r2.file })
  }
  return units
}
