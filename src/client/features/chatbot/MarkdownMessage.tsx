import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from 'solid-js'

import { getAdaptiveStreamSession } from './adaptiveStream'
import {
  highlightCode,
  parseStreamingMarkdownTail,
  renderMarkdown,
  stableMarkdownPrefixLength,
  type StreamingMarkdownTail,
} from './markdown'

export function StaticMarkdown(props: { text: string }) {
  const html = createMemo(() => renderMarkdown(props.text))

  return <div class="markdown-message" innerHTML={html()} />
}

function StreamingCodeBlock(props: {
  code: string
  generationId: string
  language?: string
  showCaret: boolean
}) {
  let highlightTimer: number | undefined
  let latestCode = ''
  let latestLanguage: string | undefined
  const [highlightedCode, setHighlightedCode] = createSignal('')
  const [highlightedLanguage, setHighlightedLanguage] = createSignal<
    string | undefined
  >()
  const [highlightedHtml, setHighlightedHtml] = createSignal('')

  const scheduleHighlight = () => {
    if (highlightTimer !== undefined) return
    highlightTimer = window.setTimeout(() => {
      highlightTimer = undefined
      const code = latestCode
      const language = latestLanguage
      const highlighted = highlightCode(
        code,
        language,
        props.generationId,
      )
      setHighlightedCode(code)
      setHighlightedLanguage(language)
      setHighlightedHtml(highlighted.html)

      if (latestCode !== code || latestLanguage !== language) {
        scheduleHighlight()
      }
    }, 80)
  }

  createEffect(() => {
    latestCode = props.code
    latestLanguage = props.language
    scheduleHighlight()
  })

  onCleanup(() => {
    if (highlightTimer !== undefined) window.clearTimeout(highlightTimer)
  })

  const canReuseHighlight = () => (
    highlightedLanguage() === props.language &&
    props.code.startsWith(highlightedCode())
  )
  const pendingCode = () => canReuseHighlight()
    ? props.code.slice(highlightedCode().length)
    : props.code

  return (
    <pre>
      <code class="hljs">
        <Show when={canReuseHighlight()}>
          <span innerHTML={highlightedHtml()} />
        </Show>
        <span>{pendingCode()}</span>
        <Show when={props.showCaret}>
          <span aria-hidden="true" class="generation-output-caret" />
        </Show>
      </code>
    </pre>
  )
}

export function StreamingMarkdown(props: {
  generationId: string
  onComplete: () => void
  onVisibleProgress: () => void
}) {
  let committedRef: HTMLDivElement | undefined
  let activeSource = ''
  const [hasVisibleText, setHasVisibleText] = createSignal(false)
  const [activeTail, setActiveTail] = createSignal<StreamingMarkdownTail>(
    parseStreamingMarkdownTail(''),
  )

  const syncActiveTail = () => {
    setActiveTail(parseStreamingMarkdownTail(activeSource))
  }

  const appendCommittedHtml = (source: string) => {
    if (!source || !committedRef) return
    const template = document.createElement('template')
    template.innerHTML = renderMarkdown(source, props.generationId)
    committedRef.append(template.content)
  }

  const commitStableBlocks = () => {
    const stableLength = stableMarkdownPrefixLength(activeSource)

    if (stableLength === 0) return
    appendCommittedHtml(activeSource.slice(0, stableLength))
    activeSource = activeSource.slice(stableLength)
    syncActiveTail()
  }

  const commitAll = () => {
    if (!activeSource) return
    appendCommittedHtml(activeSource)
    activeSource = ''
    syncActiveTail()
  }

  const replace = (text: string) => {
    if (committedRef) committedRef.textContent = ''
    activeSource = text
    setHasVisibleText(Boolean(text))
    commitStableBlocks()
    syncActiveTail()
  }

  onMount(() => {
    const session = getAdaptiveStreamSession(props.generationId)

    if (!session) {
      props.onComplete()
      return
    }

    const unsubscribe = session.subscribe({
      append: (text) => {
        const completesBlankLine =
          text.includes('\n\n') ||
          (activeSource.endsWith('\n') && text.startsWith('\n'))
        activeSource += text
        if (!hasVisibleText()) setHasVisibleText(true)

        if (
          text.includes('\n') &&
          (
            completesBlankLine ||
            /(?:^|\n)\s{0,3}(?:`{3,}|~{3,})\s*\n?$/.test(activeSource) ||
            /^\s{0,3}#{1,6}\s+.*\n$/.test(activeSource)
          )
        ) {
          commitStableBlocks()
        } else {
          syncActiveTail()
        }
      },
      replace,
      progress: props.onVisibleProgress,
      complete: () => {
        commitAll()
        props.onComplete()
      },
    })
    onCleanup(unsubscribe)
  })

  return (
    <div class="markdown-message">
      <div ref={committedRef} />
      <Show when={!hasVisibleText()}>
        <span class="text-slate-400">正在生成回复...</span>
      </Show>
      <Show
        when={
          activeTail().kind === 'code'
            ? activeTail() as Extract<StreamingMarkdownTail, { kind: 'code' }>
            : undefined
        }
        fallback={
          <>
            <span class="whitespace-pre-wrap">
              {(activeTail() as Extract<
                StreamingMarkdownTail,
                { kind: 'text' }
              >).source}
            </span>
            <span aria-hidden="true" class="generation-output-caret" />
          </>
        }
      >
        {(tail) => (
          <>
            <StreamingCodeBlock
              code={tail().code}
              generationId={props.generationId}
              language={tail().language}
              showCaret={!tail().remainder}
            />
            <Show when={tail().remainder}>
              <span class="whitespace-pre-wrap">{tail().remainder}</span>
              <span aria-hidden="true" class="generation-output-caret" />
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}
