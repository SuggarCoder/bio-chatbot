import {
  parseApiError,
  streamUrl,
  type ChatMessageDto,
} from './chatApi'
import { isCurrentGeneration } from './generationIdentity'

type StreamIdentity = {
  generationId: string
  streamId: string
}

export type ChatStreamEvent =
  | StreamIdentity & {
      type: 'generation.start'
      userMessage: ChatMessageDto
    }
  | StreamIdentity & {
      type: 'text.delta'
      startIndex: number
      delta: string
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
      type: 'generation.completed'
      assistantMessage: ChatMessageDto
    }
  | StreamIdentity & {
      type: 'generation.cancelled'
      assistantMessage: ChatMessageDto | null
    }
  | StreamIdentity & {
      type: 'generation.failed'
      code: string
      message: string
      assistantMessage: ChatMessageDto | null
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
  state: { buffer: string; receivedCharacters: number },
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

      request.onEvent(event)
      terminal = [
        'generation.completed',
        'generation.cancelled',
        'generation.failed',
      ].includes(event.type)
    }
  }

  return terminal
}

export async function runChatStream(request: StreamRequest): Promise<void> {
  const state = { buffer: '', receivedCharacters: 0 }
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
      await sleep(Math.min(500 * 2 ** retries, 5_000), request.signal)
      continue
    }

    if (response.status === 410) {
      throw new StreamCompletedError()
    }

    if (!response.ok) {
      throw await parseApiError(response)
    }

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

    await sleep(Math.min(500 * 2 ** retries, 5_000), request.signal)
  }
}
