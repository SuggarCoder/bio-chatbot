import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  Show,
  untrack,
  type JSX,
} from 'solid-js'

import { recordStreamOperation } from './streamMetrics'
import {
  highlightCodeWithShiki,
  normalizeCodeLanguage,
  plainHighlightedCode,
  STATIC_HIGHLIGHT_MAX_CHARS,
  STREAMING_HIGHLIGHT_MAX_CHARS,
  type CodeToken,
  type HighlightedCode,
} from './codeHighlight'

const WRAP_STORAGE_KEY = 'bio-chatbot:code-word-wrap'

function initialWordWrap() {
  if (typeof window === 'undefined') return true
  return window.localStorage.getItem(WRAP_STORAGE_KEY) !== 'false'
}

const [globalWordWrap, setGlobalWordWrap] = createSignal(initialWordWrap())

export type CodeBlockProps = {
  code: string
  language?: string
  filename?: string
  generationId?: string
  isStreaming?: boolean
  showLineNumbers?: boolean
  wrap?: boolean
  class?: string
}

function tokenStyle(token: CodeToken): JSX.CSSProperties {
  const fontStyle = token.fontStyle ?? 0
  const decorations = [
    fontStyle & 4 ? 'underline' : '',
    fontStyle & 8 ? 'line-through' : '',
  ].filter(Boolean).join(' ')
  return {
    color: token.color,
    'background-color': token.bgColor,
    'font-style': fontStyle & 1 ? 'italic' : undefined,
    'font-weight': fontStyle & 2 ? '700' : undefined,
    'text-decoration': decorations || undefined,
  }
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.style.cssText = 'position:fixed;left:-9999px;top:0'
  document.body.append(textarea)
  textarea.select()
  document.execCommand('copy')
  textarea.remove()
}

function sourceFileMimeType(filename: string): string | undefined {
  const normalized = filename.toLowerCase()
  if (normalized.endsWith('.py')) return 'text/x-python;charset=utf-8'
  if (normalized.endsWith('.js')) return 'text/javascript;charset=utf-8'
  if (normalized.endsWith('.css')) return 'text/css;charset=utf-8'
  return undefined
}

export function CodeBlock(props: CodeBlockProps) {
  let highlightTimer: number | undefined
  let copiedTimer: number | undefined
  let highlighting = false
  let disposed = false
  let latestRequest = {
    source: props.code,
    language: props.language,
    isStreaming: props.isStreaming ?? false,
  }
  const [highlighted, setHighlighted] = createSignal<HighlightedCode>(
    plainHighlightedCode(props.code, props.language),
  )
  const [copied, setCopied] = createSignal(false)
  const shouldWrap = () => props.wrap ?? globalWordWrap()
  const languageLabel = () => normalizeCodeLanguage(props.language) ?? 'text'

  const scheduleHighlight = () => {
    if (disposed || highlighting || highlightTimer !== undefined) return
    const delay = latestRequest.isStreaming ? 150 : 0
    highlightTimer = window.setTimeout(() => {
      highlightTimer = undefined
      highlighting = true
      const request = latestRequest
      const limit = request.isStreaming
        ? STREAMING_HIGHLIGHT_MAX_CHARS
        : STATIC_HIGHLIGHT_MAX_CHARS
      const startedAt = performance.now()
      const pending = request.source.length <= limit && normalizeCodeLanguage(request.language)
        ? highlightCodeWithShiki(request.source, request.language)
        : Promise.resolve(plainHighlightedCode(request.source, request.language))
      void pending.then((result) => {
        const canApply = latestRequest.language === request.language &&
          latestRequest.source.startsWith(request.source)
        if (!disposed && canApply) {
          setHighlighted(result)
          if (props.generationId) {
            recordStreamOperation(props.generationId, {
              type: 'highlight',
              duration: performance.now() - startedAt,
              detail: result.language ?? 'plain',
            })
          }
        }
      }).finally(() => {
        highlighting = false
        if (
          latestRequest.source !== request.source ||
          latestRequest.language !== request.language ||
          latestRequest.isStreaming !== request.isStreaming
        ) {
          scheduleHighlight()
        }
      })
    }, delay)
  }

  createEffect(() => {
    const next = {
      source: props.code,
      language: props.language,
      isStreaming: props.isStreaming ?? false,
    }
    const current = untrack(highlighted)
    latestRequest = next

    if (
      !next.source.startsWith(current.source) ||
      normalizeCodeLanguage(next.language) !== current.language ||
      current.source.length === 0
    ) {
      setHighlighted(plainHighlightedCode(next.source, next.language))
    }
    scheduleHighlight()
  })

  onCleanup(() => {
    disposed = true
    if (highlightTimer !== undefined) window.clearTimeout(highlightTimer)
    if (copiedTimer !== undefined) window.clearTimeout(copiedTimer)
  })

  const toggleWrap = () => {
    const next = !shouldWrap()
    setGlobalWordWrap(next)
    window.localStorage.setItem(WRAP_STORAGE_KEY, String(next))
  }

  const copy = async () => {
    await copyText(props.code)
    setCopied(true)
    if (copiedTimer !== undefined) window.clearTimeout(copiedTimer)
    copiedTimer = window.setTimeout(() => setCopied(false), 1500)
  }

  const downloadSourceFile = () => {
    const filename = props.filename
    const mimeType = filename ? sourceFileMimeType(filename) : undefined
    if (!filename || !mimeType || props.isStreaming) return

    const url = URL.createObjectURL(new Blob([props.code], { type: mimeType }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.rel = 'noopener'
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  return (
    <section
      class={`code-block overflow-hidden rounded-xl border border-teal-700 bg-teal-600 text-slate-100 ${props.class ?? ''}`}
      data-highlighted={highlighted().highlighted ? 'true' : 'false'}
      data-wrap={shouldWrap() ? 'true' : 'false'}
    >
      <Show when={props.filename}>
        {(filename) => (
          <div
            role="note"
            class="flex items-center gap-3 border-b border-teal-700 bg-teal-50 px-3 py-2 text-xs font-medium text-teal-900"
          >
            <span aria-hidden="true" class="i-lucide-file-down h-4 w-4 shrink-0" />
            <span class="min-w-0 flex-1">
              可下载或复制保存为 <strong class="font-mono">{filename()}</strong>
            </span>
            <button
              type="button"
              class="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-teal-600 px-3 font-semibold text-white shadow-sm transition hover:bg-teal-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500 disabled:shadow-none"
              aria-label={`下载 ${filename()}`}
              title={props.isStreaming ? '生成完成后可下载' : `下载 ${filename()}`}
              disabled={props.isStreaming}
              onClick={downloadSourceFile}
            >
              <span aria-hidden="true" class="i-lucide-download h-3.5 w-3.5" />
              下载
            </button>
          </div>
        )}
      </Show>
      <div class="code-block-toolbar flex min-h-9 items-center gap-2 border-b border-teal-700 bg-teal-600 px-3 text-xs text-teal-50">
        <span class="min-w-0 flex-1 truncate font-mono">
          {props.filename ?? languageLabel()}
        </span>
        <button
          type="button"
          class={`grid h-7 w-7 place-items-center rounded-md transition hover:bg-teal-700 hover:text-white ${shouldWrap() ? 'text-teal-200' : ''}`}
          aria-label={shouldWrap() ? 'Disable code wrapping' : 'Enable code wrapping'}
          aria-pressed={shouldWrap()}
          title={shouldWrap() ? 'Disable code wrapping' : 'Enable code wrapping'}
          onClick={toggleWrap}
        >
          <span class="i-lucide-wrap-text h-4 w-4" />
        </button>
        <button
          type="button"
          class="grid h-7 w-7 place-items-center rounded-md transition hover:bg-teal-700 hover:text-white"
          aria-label="Copy code"
          title="Copy code"
          onClick={() => void copy()}
        >
          <span class={copied() ? 'i-lucide-check h-4 w-4 text-teal-300' : 'i-lucide-copy h-4 w-4'} />
        </button>
      </div>
      <div class="code-block-scroll overflow-auto">
        <div class="code-block-lines min-w-full py-3 font-mono text-[13px] leading-6">
          <For each={highlighted().lines}>
            {(line, lineIndex) => (
              <div class="code-block-line">
                <Show when={props.showLineNumbers !== false}>
                  <span
                    aria-hidden="true"
                    class="code-block-line-number"
                    data-line-number={lineIndex() + 1}
                  >
                    {lineIndex() + 1}
                  </span>
                </Show>
                <code class="code-block-line-content">
                  <Show when={line.length > 0} fallback={'\u200b'}>
                    <For each={line}>
                      {(token) => <span style={tokenStyle(token)}>{token.content}</span>}
                    </For>
                  </Show>
                </code>
              </div>
            )}
          </For>
        </div>
      </div>
    </section>
  )
}
