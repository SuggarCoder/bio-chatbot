import {
  parseApiError,
  streamUrl,
  type ChatMessageDto,
} from './chatApi'
import {
  fullJitterDelay,
  isTransientStatus,
  jitter,
  sleep,
} from './backoff'
import { isCurrentGeneration } from './generationIdentity'
import {
  browserSessionStorage,
  isStreamEventId,
  readStreamResume,
  StreamResumeWriter,
} from './streamResume'

type StreamIdentity = {
  generationId: string
  streamId: string
  messageId: string
  eventId: number
}

export type ChatStreamEvent =
  | StreamIdentity & {
      type: 'message.start'
      userMessage: ChatMessageDto
    }
  | StreamIdentity & {
      type: 'message.delta'
      sequence: number
      startIndex: number
      delta: string
    }
  | StreamIdentity & {
      type: 'artifact.start'
      artifactStreamId: string
      logicalId: string
      operation: 'create' | 'replace'
      artifactType: string
      title: string
      baseVersion: number | null
      language: string | null
      textStartIndex: number
      partOrder: number
    }
  | StreamIdentity & {
      type: 'artifact.delta'
      artifactStreamId: string
      sequence: number
      delta: string
    }
  | StreamIdentity & {
      type: 'artifact.commit'
      artifactStreamId: string
      artifactId: string
      logicalId: string
      version: number
      sha256: string
      byteLength: number
    }
  | StreamIdentity & {
      type: 'artifact.error'
      artifactStreamId?: string
      code: string
      message: string
      recoverable: boolean
    }
  | StreamIdentity & {
      type: 'tool.start'
      toolRunId: string
      toolName: string
    }
  | StreamIdentity & {
      type: 'tool.result'
      toolRunId: string
      toolName: string
    }
  | StreamIdentity & {
      type: 'progress.step'
      step: ChatMessageDto['executionSteps'][number]
    }
  | StreamIdentity & {
      type: 'message.finish'
      finishReason: 'stop' | 'cancelled' | 'error' | 'length'
      assistantMessage: ChatMessageDto | null
      error?: { code: string; message: string }
    }

export class StreamCompletedError extends Error {
  constructor() {
    super('Generation is already complete')
    this.name = 'StreamCompletedError'
  }
}

type StreamRequest = {
  userId: string
  conversationId: string
  generationId: string
  streamId: string
  signal: AbortSignal
  onEvent: (event: ChatStreamEvent) => void
  onConnectionState?: (
    state: 'connected' | 'reconnecting',
  ) => void
  onRestore?: (content: string) => void
}

/** Connection drops: 1, 2, 4, 5, 5 s, each spread over [0.5, 1.5). */
const MAX_RECONNECTS = 5
/** 502/503/504 (deploys, Redis outages): full jitter from 1 s up to 16 s. */
const MAX_TRANSIENT_RETRIES = 6

export function reconnectDelay(retry: number, random: () => number = Math.random) {
  return jitter(Math.min(500 * 2 ** retry, 5_000), random)
}

export function transientRetryDelay(
  retry: number,
  retryAfterMs: number | undefined,
  random: () => number = Math.random,
) {
  const backoff = fullJitterDelay(retry, { baseMs: 1_000, capMs: 16_000, random })
  return retryAfterMs === undefined ? backoff : Math.max(retryAfterMs, backoff)
}

function parseEventBlock(
  block: string,
): { id: string | null; event: ChatStreamEvent | null } {
  const id = block
    .split('\n')
    .find((line) => line.startsWith('id:'))
    ?.slice(3)
    .trim() ?? null
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')

  return {
    id,
    event: data ? JSON.parse(data) as ChatStreamEvent : null,
  }
}

async function consumeSse(
  response: Response,
  state: { buffer: string; lastEventId: string; partialText: string },
  request: StreamRequest,
  resume: StreamResumeWriter,
): Promise<boolean> {
  if (!response.body) {
    throw new Error('Streaming response has no body')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let terminal = false

  while (true) {
    const result = await reader.read()

    if (result.done) {
      const tail = decoder.decode()
      state.buffer += tail
      break
    }

    const text = decoder.decode(result.value, { stream: true })
    state.buffer += text

    while (true) {
      const boundary = state.buffer.indexOf('\n\n')

      if (boundary < 0) {
        break
      }

      const block = state.buffer.slice(0, boundary)
      state.buffer = state.buffer.slice(boundary + 2)
      const parsed = parseEventBlock(block)
      const event = parsed.event

      if (
        !event ||
        !isCurrentGeneration(request.generationId, event.generationId)
      ) {
        continue
      }

      if (event.type === 'message.delta') {
        const overlap = state.partialText.length - event.startIndex
        if (overlap < event.delta.length) {
          state.partialText += event.delta.slice(Math.max(0, overlap))
        }
      }

      if (isStreamEventId(parsed.id)) {
        state.lastEventId = parsed.id
        resume.record(parsed.id, state.partialText)
      }

      request.onEvent(event)
      terminal = event.type === 'message.finish'
    }
  }

  return terminal
}

export async function runChatStream(request: StreamRequest): Promise<void> {
  const storage = browserSessionStorage()
  const meta = {
    userId: request.userId,
    conversationId: request.conversationId,
    generationId: request.generationId,
    streamId: request.streamId,
  }
  const restored = readStreamResume(storage, meta)
  const state = {
    buffer: '',
    lastEventId: restored?.cursor ?? '0-0',
    partialText: restored?.text ?? '',
  }
  const resume = new StreamResumeWriter(storage, meta)
  resume.begin(state.lastEventId, state.partialText)
  if (state.partialText) request.onRestore?.(state.partialText)

  // A page that is going away keeps its resume state (flushed now); a stream
  // that ends here for any other reason removes it.
  let leavingPage = false
  const onPageHide = () => {
    leavingPage = true
    resume.flush()
  }
  const onPageShow = () => {
    leavingPage = false
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') resume.flush()
  }
  const hasWindow = typeof window !== 'undefined'
  if (hasWindow) {
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)
    document.addEventListener('visibilitychange', onVisibilityChange)
  }

  try {
    await connect(request, state, resume)
  } finally {
    if (hasWindow) {
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
    resume.close(!leavingPage)
  }
}

async function connect(
  request: StreamRequest,
  state: { buffer: string; lastEventId: string; partialText: string },
  resume: StreamResumeWriter,
): Promise<void> {
  let retries = 0
  let transientRetries = 0

  while (!request.signal.aborted) {
    let response: Response

    try {
      response = await fetch(
        streamUrl(request.generationId),
        {
          credentials: 'include',
          signal: request.signal,
          headers: state.lastEventId === '0-0'
            ? undefined
            : { 'Last-Event-ID': state.lastEventId },
        },
      )
    } catch (error) {
      if (request.signal.aborted || retries >= MAX_RECONNECTS) {
        throw error
      }

      retries += 1
      request.onConnectionState?.('reconnecting')
      await sleep(reconnectDelay(retries), request.signal)
      continue
    }

    if (response.status === 410) {
      throw new StreamCompletedError()
    }

    if (!response.ok) {
      const error = await parseApiError(response)

      if (
        !isTransientStatus(response.status) ||
        transientRetries >= MAX_TRANSIENT_RETRIES
      ) {
        throw error
      }

      request.onConnectionState?.('reconnecting')
      await sleep(
        transientRetryDelay(transientRetries, error.retryAfterMs),
        request.signal,
      )
      transientRetries += 1
      continue
    }

    request.onConnectionState?.('connected')
    state.buffer = ''
    const cursorBefore = state.lastEventId

    try {
      if (await consumeSse(response, state, request, resume)) {
        return
      }
    } catch (error) {
      // A connection that delivered events made progress: the retry budget
      // is for consecutive failures, not for a long stream's reconnects.
      if (state.lastEventId !== cursorBefore) retries = 0
      if (request.signal.aborted || retries >= MAX_RECONNECTS) {
        throw error
      }
    }

    if (state.lastEventId !== cursorBefore) {
      retries = 0
      transientRetries = 0
    }
    retries += 1

    if (retries > MAX_RECONNECTS) {
      throw new Error('Stream connection was interrupted')
    }

    request.onConnectionState?.('reconnecting')
    await sleep(reconnectDelay(retries), request.signal)
  }
}
