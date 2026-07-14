const STREAM_STEP_MS = 90

function sleep(duration: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('The operation was aborted', 'AbortError'))
      return
    }

    let timeoutId = 0
    const cleanup = () => signal.removeEventListener('abort', handleAbort)
    const handleAbort = () => {
      window.clearTimeout(timeoutId)
      cleanup()
      reject(new DOMException('The operation was aborted', 'AbortError'))
    }

    timeoutId = window.setTimeout(() => {
      cleanup()
      resolve()
    }, duration)

    signal.addEventListener('abort', handleAbort, { once: true })
  })
}

function chunkText(content: string, chunkSize: number) {
  const chunks: string[] = []

  for (let index = 0; index < content.length; index += chunkSize) {
    chunks.push(content.slice(index, index + chunkSize))
  }

  return chunks
}

function buildAssistantReply(prompt: string) {
  const normalized = prompt.trim()

  return [
    `已收到你的问题：“${normalized}”。`,
    '我会先提取核心目标，再把当前上下文整理成可继续追问的结果。',
    '如果你希望，我下一步可以继续展开成更详细的分析、步骤建议或结论摘要。',
  ].join('')
}

export async function* streamAssistantReply(prompt: string, signal: AbortSignal) {
  const response = buildAssistantReply(prompt)

  for (const chunk of chunkText(response, 10)) {
    await sleep(STREAM_STEP_MS, signal)
    signal.throwIfAborted()
    yield chunk
  }
}
