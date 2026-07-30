import {
  generationUrl,
  parseApiError,
  streamUrl,
  type ChatMessageDto,
} from './chatApi'

export type ChatStreamEvent =
  | {
      type: 'start'
      generationId: string
      streamId: string
      userMessage: ChatMessageDto
    }
  | {
      type: 'text-delta'
      delta: string
    }
  | {
      type: 'done'
      generationId: string
      assistantMessage: ChatMessageDto
    }
  | {
      type: 'error'
      generationId: string
      code: string
      message: string
    }

export class StreamCompletedError extends Error {
  constructor() {
    super('Generation is already complete')
    this.name = 'StreamCompletedError'
  }
}

type StreamRequest = {
  chatId: string
  content: string
  clientMessageId: string
  existingStreamId?: string
  signal: AbortSignal
  onEvent: (event: ChatStreamEvent) => void
  onStreamId: (streamId: string) => void
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

  if (!data) {
    return null
  }

  return JSON.parse(data) as ChatStreamEvent
}

async function consumeSse(
  response: Response,
  state: {
    buffer: string
    receivedCharacters: number
  },
  onEvent: (event: ChatStreamEvent) => void,
): Promise<boolean> {
  if (!response.body) {
    throw new Error('Streaming response has no body')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let finished = false

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

      if (event) {
        onEvent(event)
        finished = event.type === 'done' || event.type === 'error'
      }
    }
  }

  return finished
}

export async function runChatStream(request: StreamRequest): Promise<void> {
  const state = {
    buffer: '',
    receivedCharacters: 0,
  }
  let streamId = request.existingStreamId
  let initialRequest = !streamId
  let retries = 0

  while (!request.signal.aborted) {
    let response: Response

    try {
      response = await fetch(
        initialRequest
          ? generationUrl(request.chatId)
          : streamUrl(streamId as string, state.receivedCharacters),
        {
          method: initialRequest ? 'POST' : 'GET',
          credentials: 'include',
          headers: initialRequest
            ? {
                'content-type': 'application/json',
              }
            : undefined,
          body: initialRequest
            ? JSON.stringify({
                content: request.content,
                clientMessageId: request.clientMessageId,
              })
            : undefined,
          signal: request.signal,
        },
      )
    } catch (error) {
      if (request.signal.aborted) {
        throw error
      }

      if (!streamId || retries >= 5) {
        throw error
      }

      retries += 1
      await sleep(Math.min(500 * 2 ** retries, 5_000), request.signal)
      initialRequest = false
      continue
    }

    if (response.status === 410) {
      throw new StreamCompletedError()
    }

    if (!response.ok) {
      throw await parseApiError(response)
    }

    const responseStreamId = response.headers.get('x-stream-id')

    if (responseStreamId) {
      streamId = responseStreamId
      request.onStreamId(responseStreamId)
    }

    let finished: boolean

    try {
      finished = await consumeSse(
        response,
        state,
        request.onEvent,
      )
    } catch (error) {
      if (request.signal.aborted) {
        throw error
      }

      if (!streamId || retries >= 5) {
        throw error
      }

      retries += 1
      initialRequest = false
      await sleep(
        Math.min(500 * 2 ** retries, 5_000),
        request.signal,
      )
      continue
    }

    if (finished) {
      return
    }

    if (!streamId) {
      throw new Error('Stream ended before a stream ID was assigned')
    }

    initialRequest = false
    retries += 1

    if (retries > 5) {
      throw new Error('Stream connection was interrupted')
    }

    await sleep(Math.min(500 * 2 ** retries, 5_000), request.signal)
  }
}
