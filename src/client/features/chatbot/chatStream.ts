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
  generationId: string
  streamId: string
  signal: AbortSignal
  onEvent: (event: ChatStreamEvent) => void
  onConnectionState?: (
    state: 'connected' | 'reconnecting',
  ) => void
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

function parseEventBlock(block: string): ChatStreamEvent | null {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')

  return data ? JSON.parse(data) as ChatStreamEvent : null
}

async function consumeSse(
  response: Response,
  state: { buffer: string; receivedCharacters: number; seenEventIds: Set<number> },
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
      state.receivedCharacters += tail.length
      state.buffer += tail
      break
    }

    const text = decoder.decode(result.value, { stream: true })
    state.receivedCharacters += text.length
    state.buffer += text

    while (true) {
      const boundary = state.buffer.indexOf('\n\n')

      if (boundary < 0) {
        break
      }

      const block = state.buffer.slice(0, boundary)
      state.buffer = state.buffer.slice(boundary + 2)
      const event = parseEventBlock(block)

      if (
        !event ||
        !isCurrentGeneration(request.generationId, event.generationId)
      ) {
        continue
      }

      if (state.seenEventIds.has(event.eventId)) continue
      state.seenEventIds.add(event.eventId)

      request.onEvent(event)
      terminal = event.type === 'message.finish'
    }
  }

  return terminal
}

export async function runChatStream(request: StreamRequest): Promise<void> {
  const state = {
    buffer: '',
    receivedCharacters: 0,
    seenEventIds: new Set<number>(),
  }
  let retries = 0

  while (!request.signal.aborted) {
    let response: Response

    try {
      response = await fetch(
        streamUrl(request.generationId, state.receivedCharacters),
        {
          credentials: 'include',
          signal: request.signal,
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

    try {
      if (await consumeSse(response, state, request)) {
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
