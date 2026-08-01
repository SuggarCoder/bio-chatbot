import type { ChatMessageDto } from './chatApi'
import {
  recordStreamArrival,
  recordStreamFrame,
  recordStreamOperation,
  recordStreamTerminal,
  type StreamTerminalKind,
} from './streamMetrics'

export type StreamTerminal = {
  kind: StreamTerminalKind
  message?: ChatMessageDto | null
  errorMessage?: string
}

export type StreamObserver = {
  append: (text: string) => void
  replace: (text: string) => void
  progress?: () => void
  complete?: (terminal: StreamTerminal, text: string) => void
}

type FrameScheduler = {
  request: (callback: FrameRequestCallback) => number
  cancel: (handle: number) => void
  now: () => number
}

type StreamSessionOptions = {
  scheduler?: FrameScheduler
  reducedMotion?: boolean
  onTerminal: (terminal: StreamTerminal, text: string) => void
}

const ratePoints: Array<[number, number]> = [
  [0, 38],
  [5, 44],
  [16, 64],
  [40, 96],
  [80, 148],
  [160, 220],
  [320, 300],
]

export function getAdaptiveRate(backlog: number) {
  const normalized = Math.max(0, backlog)

  for (let index = 1; index < ratePoints.length; index += 1) {
    const [rightBacklog, rightRate] = ratePoints[index]

    if (normalized <= rightBacklog) {
      const [leftBacklog, leftRate] = ratePoints[index - 1]
      const progress =
        (normalized - leftBacklog) / (rightBacklog - leftBacklog)
      return leftRate + (rightRate - leftRate) * progress
    }
  }

  return 300
}

function defaultScheduler(): FrameScheduler {
  return {
    request: (callback) => window.requestAnimationFrame(callback),
    cancel: (handle) => window.cancelAnimationFrame(handle),
    now: () => performance.now(),
  }
}

const segmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : undefined

export function splitGraphemes(text: string) {
  if (!text) return []

  if (segmenter) {
    return [...segmenter.segment(text)].map((entry) => entry.segment)
  }

  const result: string[] = []

  for (const codePoint of text) {
    if (
      result.length > 0 &&
      (/\p{Mark}/u.test(codePoint) || codePoint === '\u200d')
    ) {
      result[result.length - 1] += codePoint
    } else {
      result.push(codePoint)
    }
  }

  return result
}

class GraphemeQueue {
  private values: string[] = []
  private head = 0
  private carry = ''

  get length() {
    return this.values.length - this.head
  }

  push(text: string) {
    let candidate = this.carry + text
    this.carry = ''
    const lastUnit = candidate.charCodeAt(candidate.length - 1)

    if (
      (lastUnit >= 0xd800 && lastUnit <= 0xdbff) ||
      candidate.endsWith('\u200d')
    ) {
      this.carry = candidate.slice(-1)
      candidate = candidate.slice(0, -1)
    }

    // Re-segment the pending tail with the new delta. This preserves emoji
    // and combining sequences even when the network splits their code units.
    if (this.length > 0) {
      candidate = this.values.pop() + candidate
    }

    this.values.push(...splitGraphemes(candidate))
  }

  replace(text: string) {
    this.values = splitGraphemes(text)
    this.head = 0
    this.carry = ''
  }

  take(count: number) {
    const available = Math.min(Math.max(count, 0), this.length)

    if (available === 0) return ''
    const text = this.values
      .slice(this.head, this.head + available)
      .join('')
    this.head += available

    if (this.head > 1024 && this.head * 2 > this.values.length) {
      this.values = this.values.slice(this.head)
      this.head = 0
    }

    return text
  }
}

export class AdaptiveStreamSession {
  readonly generationId: string
  private readonly scheduler: FrameScheduler
  private readonly reducedMotion: boolean
  private readonly onTerminal: StreamSessionOptions['onTerminal']
  private readonly queue = new GraphemeQueue()
  private readonly observers = new Set<StreamObserver>()
  private receivedText = ''
  private visibleText = ''
  private accepting = true
  private terminal?: StreamTerminal
  private completed = false
  private replacementRequired = false
  private firstArrivalAt?: number
  private frame?: number
  private lastFrameAt?: number
  private budget = 0

  constructor(generationId: string, options: StreamSessionOptions) {
    this.generationId = generationId
    this.scheduler = options.scheduler ?? defaultScheduler()
    this.reducedMotion = options.reducedMotion ?? (
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    )
    this.onTerminal = options.onTerminal
  }

  get canonicalText() {
    return this.receivedText
  }

  get visibleLength() {
    return this.visibleText.length
  }

  get backlog() {
    return this.queue.length
  }

  push(startIndex: number, delta: string) {
    if (!this.accepting || !delta) return
    const overlap = this.receivedText.length - startIndex

    if (overlap >= delta.length) return
    const appended = delta.slice(Math.max(0, overlap))

    if (!appended) return
    this.receivedText += appended
    this.queue.push(appended)
    const now = this.scheduler.now()
    this.firstArrivalAt ??= now
    recordStreamArrival(
      this.generationId,
      appended.length,
      this.queue.length,
      now,
    )

    if (this.reducedMotion) {
      this.flushReducedMotion()
    } else {
      this.schedule()
    }
  }

  finish(finalText: string, terminal: StreamTerminal) {
    if (this.completed || this.terminal) return
    this.accepting = false
    this.terminal = terminal
    this.receivedText = finalText
    recordStreamTerminal(this.generationId, terminal.kind)

    if (finalText.startsWith(this.visibleText)) {
      this.queue.replace(finalText.slice(this.visibleText.length))
      recordStreamOperation(this.generationId, {
        type: 'reconcile',
        detail: `suffix:${finalText.length - this.visibleText.length}`,
      })
    } else {
      this.queue.replace('')
      this.replacementRequired = true
      recordStreamOperation(this.generationId, {
        type: 'reconcile',
        detail: 'canonical-replacement',
      })
    }

    if (this.observers.size === 0) {
      this.completeNow()
    } else if (this.reducedMotion) {
      this.flushReducedMotion()
    } else {
      this.firstArrivalAt ??= this.scheduler.now() - 48
      this.schedule()
    }
  }

  subscribe(observer: StreamObserver) {
    if (this.completed) {
      observer.replace(this.receivedText)
      if (this.terminal) observer.complete?.(this.terminal, this.receivedText)
      return noop
    }

    this.observers.add(observer)
    if (this.visibleText) observer.replace(this.visibleText)

    if (this.reducedMotion) {
      this.flushReducedMotion()
    } else if (this.queue.length > 0 || this.terminal) {
      this.schedule()
    }

    return () => {
      this.observers.delete(observer)
      if (this.observers.size === 0) {
        this.cancelFrame()
        this.lastFrameAt = undefined
        if (this.terminal) this.completeNow()
      }
    }
  }

  dispose() {
    this.accepting = false
    this.cancelFrame()
    this.observers.clear()
    this.queue.replace('')
  }

  private flushReducedMotion() {
    const text = this.queue.take(this.queue.length)

    if (text) this.appendVisible(text)
    if (this.terminal) this.completeNow()
  }

  private appendVisible(text: string) {
    if (!text) return
    this.visibleText += text

    for (const observer of this.observers) {
      observer.append(text)
      observer.progress?.()
    }
  }

  private schedule() {
    if (this.frame !== undefined || this.observers.size === 0) return
    this.frame = this.scheduler.request(this.tick)
  }

  private tick = (now: number) => {
    this.frame = undefined
    const rawDt = this.lastFrameAt === undefined ? 0 : now - this.lastFrameAt
    const dt = Math.min(Math.max(rawDt, 0), 50)
    this.lastFrameAt = now
    const waitingForBuffer =
      !this.terminal &&
      this.queue.length < 6 &&
      this.firstArrivalAt !== undefined &&
      now - this.firstArrivalAt < 48
    let rate = 0

    if (!waitingForBuffer && this.queue.length > 0) {
      const normalRate = getAdaptiveRate(this.queue.length)
      rate = this.terminal
        ? Math.min(Math.max(normalRate * 1.5, 180), 360)
        : normalRate
      this.budget += rate * dt / 1000
      const count = Math.min(Math.floor(this.budget), 24)

      if (count > 0) {
        this.budget -= count
        this.appendVisible(this.queue.take(count))
      }
    }

    recordStreamFrame(this.generationId, {
      at: now,
      dt: rawDt,
      backlog: this.queue.length,
      visible: this.visibleText.length,
      rate,
    })

    if (this.queue.length > 0 || waitingForBuffer) {
      this.schedule()
    } else if (this.terminal) {
      this.completeNow()
    } else {
      this.lastFrameAt = undefined
      this.budget = 0
      this.firstArrivalAt = undefined
    }
  }

  private completeNow() {
    if (this.completed || !this.terminal) return
    this.completed = true
    this.cancelFrame()

    if (this.replacementRequired || this.visibleText !== this.receivedText) {
      this.visibleText = this.receivedText
      for (const observer of this.observers) {
        observer.replace(this.receivedText)
        observer.progress?.()
      }
    }

    for (const observer of this.observers) {
      observer.complete?.(this.terminal, this.receivedText)
    }
    this.onTerminal(this.terminal, this.receivedText)
  }

  private cancelFrame() {
    if (this.frame !== undefined) {
      this.scheduler.cancel(this.frame)
      this.frame = undefined
    }
  }
}

const sessions = new Map<string, AdaptiveStreamSession>()

export function createAdaptiveStreamSession(
  generationId: string,
  options: StreamSessionOptions,
) {
  sessions.get(generationId)?.dispose()
  const session = new AdaptiveStreamSession(generationId, options)
  sessions.set(generationId, session)
  return session
}

export function getAdaptiveStreamSession(generationId: string) {
  return sessions.get(generationId)
}

export function deleteAdaptiveStreamSession(generationId: string) {
  const session = sessions.get(generationId)
  session?.dispose()
  sessions.delete(generationId)
}

function noop() {}
