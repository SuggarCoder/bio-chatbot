import assert from 'node:assert/strict'
import test from 'node:test'
import { UploadError, cancelledError, type SliceRequest, type UploadTransport } from './gpasUploadApi'
import { UploadSession, unitsFromPairing, type UploadEnvironment, type UploadUnit } from './uploadEngine'

const CHUNK = 10
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const bytes = (name: string, size: number) => new File([new Uint8Array(size)], name)

type Harness = {
  env: UploadEnvironment
  slices: SliceRequest[]
  sleeps: number[]
  singleTasks: number
  dualTasks: number
  maxInFlight: number
  onlineWaits: number
}

function harness(options: {
  slice?: (request: SliceRequest, call: number) => Promise<void> | void
  onStart?: (request: SliceRequest) => void
  dualTask?: UploadTransport['createDualTask']
  online?: () => boolean
} = {}): Harness {
  let inFlight = 0
  const h: Harness = { env: undefined!, slices: [], sleeps: [], singleTasks: 0, dualTasks: 0, maxInFlight: 0, onlineWaits: 0 }
  const transport: UploadTransport = {
    async createSingleTask() { return `upload-${++h.singleTasks}` },
    createDualTask: options.dualTask ?? (async (input) => {
      h.dualTasks++
      return {
        groupId: `group-${h.dualTasks}`,
        // Reversed order on purpose: mapping must use names.
        fileList: [...input.files].reverse().map((file, index) => ({ fileId: `${file.name}-id-${h.dualTasks}`, name: file.name, endType: String(index) })),
      }
    }),
    async uploadSlice(request) {
      const call = h.slices.push(request)
      options.onStart?.(request)
      inFlight++
      h.maxInFlight = Math.max(h.maxInFlight, inFlight)
      try {
        if (request.signal.aborted) throw cancelledError()
        await tick()
        request.onProgress(Math.floor(request.chunk.size / 2))
        await tick()
        if (request.signal.aborted) throw cancelledError()
        await options.slice?.(request, call)
        request.onProgress(request.chunk.size)
      } finally {
        inFlight--
      }
    },
  }
  h.env = {
    transport,
    hash: async () => 'hash',
    fileMN: async () => 'mn',
    sleep: async (ms, signal) => {
      h.sleeps.push(ms)
      if (signal.aborted) throw cancelledError()
    },
    random: () => 0.5,
    isOnline: options.online ?? (() => true),
    waitOnline: async () => { h.onlineWaits++ },
  }
  return h
}

const session = <F extends File>(units: UploadUnit<F>[], h: Harness, onChange?: () => void) =>
  new UploadSession(units, 'clinic', h.env, { chunkSize: CHUNK, concurrency: 3, maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 1000 }, onChange)

test('single file: pieces from the one chunk size, every chunk acknowledged', async () => {
  const h = harness()
  const f = bytes('a.fq', 25)
  const s = session([{ kind: 'single', file: f }], h)
  assert.equal(s.totalPieces(f), 3)
  const outcome = await s.run(new AbortController().signal)
  assert.equal(outcome.allUploaded, true)
  assert.deepEqual(h.slices.map(slice => slice.no).sort(), [0, 1, 2])
  assert.deepEqual(h.slices.map(slice => slice.chunk.size).sort(), [10, 10, 5])
  assert.equal(outcome.items[0].fileId, 'upload-1')
  const snapshot = s.snapshot()
  assert.equal(snapshot.sentBytes, snapshot.totalBytes)
})

test('one pool across files: concurrency is global and R1/R2 interleave', async () => {
  const h = harness()
  const r1 = bytes('s_R1.fq', 60)
  const r2 = bytes('s_R2.fq', 60)
  const extra = bytes('x.fq', 60)
  const outcome = await session([{ kind: 'paired', r1, r2 }, { kind: 'single', file: extra }], h).run(new AbortController().signal)
  assert.equal(outcome.allUploaded, true)
  assert.ok(h.maxInFlight <= 3)
  const firstR2 = h.slices.findIndex(slice => slice.fileName === 's_R2.fq')
  const lastR1 = h.slices.map(slice => slice.fileName).lastIndexOf('s_R1.fq')
  assert.ok(firstR2 < lastR1, 'R2 does not wait for R1 to finish')
  assert.ok(h.slices.every(slice => slice.channel === (slice.fileName === 'x.fq' ? 'single' : 'dual')))
  const [i1, i2] = outcome.items
  assert.equal(i1.fileId, 's_R1.fq-id-1')
  assert.equal(i2.fileId, 's_R2.fq-id-1')
  assert.equal(i1.pairKey, 'P1')
  assert.equal(i1.groupId, 'group-1')
})

test('retryable failures back off with bounded jitter, then succeed', async () => {
  let failures = 0
  const h = harness({ slice: () => { if (failures++ < 2) throw new UploadError('server', 'HTTP 503', 503) } })
  const outcome = await session([{ kind: 'single', file: bytes('a.fq', 5) }], h).run(new AbortController().signal)
  assert.equal(outcome.allUploaded, true)
  assert.deepEqual(h.sleeps, [75, 150]) // cap/2 + 0.5 * cap/2 for caps 100, 200
})

test('attempts are bounded for network failures', async () => {
  const h = harness({ slice: () => { throw new UploadError('network', 'down') } })
  const outcome = await session([{ kind: 'single', file: bytes('a.fq', 5) }], h).run(new AbortController().signal)
  assert.equal(outcome.allUploaded, false)
  assert.equal(h.slices.length, 4)
  assert.equal(outcome.items[0].status, 'failed')
  assert.equal(outcome.items[0].error, 'down')
})

test('offline waits for connectivity without spending attempts', async () => {
  let offline = 6
  const h = harness({ slice: () => { if (offline-- > 0) throw new UploadError('offline', 'offline') } })
  const outcome = await session([{ kind: 'single', file: bytes('a.fq', 5) }], h).run(new AbortController().signal)
  assert.equal(outcome.allUploaded, true)
  assert.equal(h.onlineWaits, 6)
  assert.deepEqual(h.sleeps, [])
})

test('a fatal chunk aborts its siblings, freezes progress and leaves other units alone', async () => {
  let failed = false
  let startedAfterFailure = 0
  const h = harness({
    onStart: (request) => { if (failed && request.fileName === 'bad.fq') startedAfterFailure++ },
    slice: (request) => {
      if (request.fileName === 'bad.fq' && request.no === 1) {
        failed = true
        throw new UploadError('client', 'HTTP 413', 413)
      }
    },
  })
  const bad = bytes('bad.fq', 50)
  const good = bytes('good.fq', 30)
  const s = session([{ kind: 'single', file: bad }, { kind: 'single', file: good }], h)
  const outcome = await s.run(new AbortController().signal)
  const [badItem, goodItem] = outcome.items
  assert.equal(badItem.status, 'failed')
  assert.match(badItem.error!, /413/)
  assert.equal(goodItem.status, 'uploaded')
  // Nothing of bad.fq starts after the failure, and every request it made has stopped.
  assert.equal(startedAfterFailure, 0)
  assert.ok(h.slices.filter(slice => slice.fileName === 'bad.fq').every(slice => slice.signal.aborted))
  const before = s.snapshot().files.get(bad)!.sentBytes
  await tick(); await tick()
  assert.equal(s.snapshot().files.get(bad)!.sentBytes, before)
  assert.notEqual(outcome.allUploaded, true)
  assert.ok(s.snapshot().sentBytes < s.snapshot().totalBytes, 'a failed batch never reports 100%')
})

test('business codes are final unless whitelisted', async () => {
  const h = harness({ slice: () => { throw new UploadError('business', '类型不符', undefined, 5001) } })
  const outcome = await session([{ kind: 'single', file: bytes('a.fq', 5) }], h).run(new AbortController().signal)
  assert.equal(h.slices.length, 1)
  assert.equal(outcome.items[0].status, 'failed')
})

test('an expired session stops the whole batch', async () => {
  const h = harness({ slice: (request) => {
    if (request.fileName === 'a.fq') throw new UploadError('auth', '登录已失效', 401)
    return new Promise<void>((_, reject) => request.signal.addEventListener('abort', () => reject(cancelledError())))
  } })
  const outcome = await session([{ kind: 'single', file: bytes('a.fq', 5) }, { kind: 'single', file: bytes('b.fq', 5) }], h)
    .run(new AbortController().signal)
  assert.equal(outcome.authFailed, true)
  assert.ok(outcome.items.every(item => item.status === 'failed'))
  assert.match(outcome.items[1].error!, /登录/)
})

test('dual tasks map strictly by name', async () => {
  const unit = { kind: 'paired' as const, r1: bytes('m_R1.fq', 5), r2: bytes('m_R2.fq', 5) }
  const renamed = harness({ dualTask: async () => ({ groupId: 'g', fileList: [{ fileId: '1', name: 'M_R1.FQ' }, { fileId: '2', name: 'M_R2.FQ' }] }) })
  let outcome = await session([unit], renamed).run(new AbortController().signal)
  assert.equal(outcome.items[0].status, 'failed')
  assert.equal(renamed.slices.length, 0)

  const sameId = harness({ dualTask: async () => ({ groupId: 'g', fileList: [{ fileId: '1', name: 'm_R1.fq' }, { fileId: '1', name: 'm_R2.fq' }] }) })
  outcome = await session([unit], sameId).run(new AbortController().signal)
  assert.equal(outcome.items[0].status, 'failed')

  const sameEnd = harness({ dualTask: async () => ({ groupId: 'g', fileList: [{ fileId: '1', name: 'm_R1.fq', endType: 'R1' }, { fileId: '2', name: 'm_R2.fq', endType: 'R1' }] }) })
  outcome = await session([unit], sameEnd).run(new AbortController().signal)
  assert.equal(outcome.items[1].status, 'failed')
})

test('cancelling stops every request and nothing runs afterwards', async () => {
  const controller = new AbortController()
  const h = harness({ slice: (_request, call) => { if (call === 2) controller.abort() } })
  const outcome = await session([{ kind: 'single', file: bytes('a.fq', 100) }], h).run(controller.signal)
  assert.equal(outcome.cancelled, true)
  assert.equal(outcome.items[0].status, 'cancelled')
  const count = h.slices.length
  await tick(); await tick()
  assert.equal(h.slices.length, count)
  assert.ok(count < 10)
})

test('a retry resumes missing chunks on the same task', async () => {
  let failOnce = true
  const h = harness({ slice: (request) => {
    if (request.no === 2 && failOnce) { failOnce = false; throw new UploadError('client', 'HTTP 400', 400) }
  } })
  const s = session([{ kind: 'single', file: bytes('a.fq', 30) }], h)
  assert.equal((await s.run(new AbortController().signal)).allUploaded, false)
  const firstRun = h.slices.length
  const outcome = await s.run(new AbortController().signal)
  assert.equal(outcome.allUploaded, true)
  const resumed = h.slices.slice(firstRun)
  assert.ok(resumed.every(slice => slice.uploadId === 'upload-1'))
  assert.ok(resumed.some(slice => slice.no === 2))
  assert.equal(h.singleTasks, 1)
})

test('a rejected resume recreates the task once and re-uploads the whole file', async () => {
  const h = harness({ slice: (request) => {
    if (request.uploadId === 'upload-1' && request.no === 2) throw new UploadError('client', 'HTTP 400', 400)
  } })
  const s = session([{ kind: 'single', file: bytes('a.fq', 30) }], h)
  await s.run(new AbortController().signal)
  const outcome = await s.run(new AbortController().signal)
  assert.equal(outcome.allUploaded, true)
  assert.equal(h.singleTasks, 2)
  const onNewTask = h.slices.filter(slice => slice.uploadId === 'upload-2').map(slice => slice.no).sort()
  assert.deepEqual(onNewTask, [0, 1, 2])
})

test('abort listeners on the caller signal are all removed', async () => {
  const controller = new AbortController()
  let active = 0
  const add = controller.signal.addEventListener.bind(controller.signal)
  const remove = controller.signal.removeEventListener.bind(controller.signal)
  controller.signal.addEventListener = ((...args: Parameters<AbortSignal['addEventListener']>) => { active++; add(...args) }) as AbortSignal['addEventListener']
  controller.signal.removeEventListener = ((...args: Parameters<AbortSignal['removeEventListener']>) => { active--; remove(...args) }) as AbortSignal['removeEventListener']
  let failures = 0
  const h = harness({ slice: () => { if (failures++ < 3) throw new UploadError('server', '503', 503) } })
  await session([{ kind: 'single', file: bytes('a.fq', 40) }], h).run(controller.signal)
  assert.equal(active, 0)
})

test('units come from pairing results with roles by read type', () => {
  const r1 = bytes('p_R1.fq', 1)
  const r2 = bytes('p_R2.fq', 1)
  const single = bytes('s.fq', 1)
  const units = unitsFromPairing([
    { file: r2, status: 'paired', readType: 2, pairGroupId: 'g1' },
    { file: r1, status: 'paired', readType: 1, pairGroupId: 'g1' },
    { file: single, status: 'single', readType: null, pairGroupId: null },
  ])
  assert.deepEqual(units, [{ kind: 'paired', r1, r2 }, { kind: 'single', file: single }])
})
