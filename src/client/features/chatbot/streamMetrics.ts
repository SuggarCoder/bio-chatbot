export type StreamTerminalKind = 'completed' | 'cancelled' | 'failed'

export type StreamArrivalMetric = {
  at: number
  size: number
  backlog: number
}

export type StreamFrameMetric = {
  at: number
  dt: number
  backlog: number
  visible: number
  rate: number
}

export type StreamOperationMetric = {
  at: number
  type: 'markdown' | 'highlight' | 'scroll' | 'store' | 'reconcile'
  duration?: number
  detail?: string
}

export type StreamMetricSnapshot = {
  generationId: string
  arrivals: StreamArrivalMetric[]
  frames: StreamFrameMetric[]
  operations: StreamOperationMetric[]
  framesOver24ms: number
  framesOver50ms: number
  visibleCharacters: number
  backlog: number
  currentRate: number
  markdownParseCount: number
  syntaxHighlightCount: number
  scrollOperationCount: number
  frameworkStateUpdateCount: number
  terminal?: StreamTerminalKind
}

type MutableStreamMetrics = StreamMetricSnapshot

const metrics = new Map<string, MutableStreamMetrics>()
const isDevelopment = typeof import.meta.env !== 'undefined' && import.meta.env.DEV
let detailed = isDevelopment

function trim<T>(values: T[], limit: number) {
  if (values.length > limit) {
    values.splice(0, values.length - limit)
  }
}

function getMetrics(generationId: string) {
  let value = metrics.get(generationId)

  if (!value) {
    value = {
      generationId,
      arrivals: [],
      frames: [],
      operations: [],
      framesOver24ms: 0,
      framesOver50ms: 0,
      visibleCharacters: 0,
      backlog: 0,
      currentRate: 0,
      markdownParseCount: 0,
      syntaxHighlightCount: 0,
      scrollOperationCount: 0,
      frameworkStateUpdateCount: 0,
    }
    metrics.set(generationId, value)
  }

  return value
}

export function recordStreamArrival(
  generationId: string,
  size: number,
  backlog: number,
  at: number,
) {
  if (!isDevelopment) return
  const value = getMetrics(generationId)
  value.backlog = backlog

  if (detailed) {
    value.arrivals.push({ at, size, backlog })
    trim(value.arrivals, 400)
  }
}

export function recordStreamFrame(
  generationId: string,
  metric: StreamFrameMetric,
) {
  if (!isDevelopment) return
  const value = getMetrics(generationId)
  value.visibleCharacters = metric.visible
  value.backlog = metric.backlog
  value.currentRate = metric.rate
  if (metric.dt > 24) value.framesOver24ms += 1
  if (metric.dt > 50) value.framesOver50ms += 1

  if (detailed) {
    value.frames.push(metric)
    trim(value.frames, 600)
  }
}

export function recordStreamOperation(
  generationId: string,
  operation: Omit<StreamOperationMetric, 'at'>,
) {
  if (!isDevelopment) return
  const value = getMetrics(generationId)
  if (operation.type === 'markdown') value.markdownParseCount += 1
  if (operation.type === 'highlight') value.syntaxHighlightCount += 1
  if (operation.type === 'scroll') value.scrollOperationCount += 1
  if (operation.type === 'store') value.frameworkStateUpdateCount += 1
  value.operations.push({
    at: performance.now(),
    ...operation,
  })
  trim(value.operations, 200)
}

export function recordStreamTerminal(
  generationId: string,
  terminal: StreamTerminalKind,
) {
  if (!isDevelopment) return
  getMetrics(generationId).terminal = terminal
}

function snapshot() {
  return [...metrics.values()].map((value) => ({
    ...value,
    arrivals: [...value.arrivals],
    frames: [...value.frames],
    operations: [...value.operations],
  }))
}

declare global {
  interface Window {
    __BIO_CHATBOT_STREAM_METRICS__?: {
      snapshot: () => StreamMetricSnapshot[]
      clear: () => void
      enableDetailed: (enabled?: boolean) => void
    }
  }
}

if (isDevelopment && typeof window !== 'undefined') {
  window.__BIO_CHATBOT_STREAM_METRICS__ = {
    snapshot,
    clear: () => metrics.clear(),
    enableDetailed: (enabled = true) => {
      detailed = enabled
    },
  }
}
