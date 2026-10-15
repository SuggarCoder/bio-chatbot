import {
  parseApiError,
  streamUrl,
  type ChatMessageDto,
} from './chatApi'
import { isCurrentGeneration } from './generationIdentity'

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

function sleep(duration: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('The operation was aborted', 'AbortError'))
      return
    }

    const timeoutId = window.setTimeout(resolve, duration)
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timeoutId)
        reject(new DOMException('The operation was aborted', 'AbortError'))
      },
      { once: true },
    )
  })
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

      if (parsed.id && /^\d+-\d+$/.test(parsed.id)) {
        state.lastEventId = parsed.id
        try {
          sessionStorage.setItem(
            `chat:${request.userId}:generation:${request.generationId}:stream`,
            JSON.stringify({
              userId: request.userId,
              conversationId: request.conversationId,
              generationId: request.generationId,
              streamId: request.streamId,
              lastEventId: parsed.id,
              partialText: state.partialText,
              updatedAt: Date.now(),
            }),
          )
        } catch {
          // Streaming remains functional when browser storage is unavailable.
        }
      }

      request.onEvent(event)
      terminal = event.type === 'message.finish'
    }
  }

  return terminal
}

export async function runChatStream(request: StreamRequest): Promise<void> {
  const storageKey =
    `chat:${request.userId}:generation:${request.generationId}:stream`
  let restoredCursor = '0-0'
  let restoredText = ''
  try {
    const restored = JSON.parse(
      sessionStorage.getItem(storageKey) ?? 'null',
    ) as {
      streamId?: unknown
      lastEventId?: unknown
      partialText?: unknown
    } | null
    if (
      restored?.streamId === request.streamId &&
      typeof restored.lastEventId === 'string' &&
      /^\d+-\d+$/.test(restored.lastEventId)
    ) {
      restoredCursor = restored.lastEventId
      if (typeof restored.partialText === 'string') {
        restoredText = restored.partialText.slice(0, 1_000_000)
      }
    }
  } catch {
    try {
      sessionStorage.removeItem(storageKey)
    } catch {
      // Continue without resumable browser storage.
    }
  }
  const state = {
    buffer: '',
    lastEventId: restoredCursor,
    partialText: restoredText,
  }
  try {
    sessionStorage.setItem(storageKey, JSON.stringify({
      userId: request.userId,
      conversationId: request.conversationId,
      generationId: request.generationId,
      streamId: request.streamId,
      lastEventId: restoredCursor,
      partialText: restoredText,
      updatedAt: Date.now(),
    }))
  } catch {
    // Streaming remains functional when browser storage is unavailable.
  }
  if (restoredText) request.onRestore?.(restoredText)
  let retries = 0

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
      if (request.signal.aborted || retries >= 5) {
        throw error
      }

      retries += 1
      request.onConnectionState?.('reconnecting')
      await sleep(Math.min(500 * 2 ** retries, 5_000), request.signal)
      continue
    }

    if (response.status === 410) {
      throw new StreamCompletedError()
    }

    if (!response.ok) {
      throw await parseApiError(response)
    }

    request.onConnectionState?.('connected')
    state.buffer = ''

    try {
      if (await consumeSse(response, state, request)) {
        try {
          sessionStorage.removeItem(storageKey)
        } catch {
          // Ignore unavailable browser storage after successful completion.
        }
        return
      }
    } catch (error) {
      if (request.signal.aborted || retries >= 5) {
        throw error
      }
    }

    retries += 1

    if (retries > 5) {
      throw new Error('Stream connection was interrupted')
    }

    request.onConnectionState?.('reconnecting')
    await sleep(Math.min(500 * 2 ** retries, 5_000), request.signal)
  }
}
