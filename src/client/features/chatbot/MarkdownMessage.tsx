import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from 'solid-js'

import { getAdaptiveStreamSession } from './adaptiveStream'
import { CodeBlock } from './CodeBlock'
import { MarkdownContent } from './MarkdownContent'
import {
  parseStreamingMarkdownTail,
  stableMarkdownPrefixLength,
  type StreamingMarkdownTail,
} from './markdown'

export function StaticMarkdown(props: { text: string }) {
  return <MarkdownContent source={props.text} />
}

export function StreamingMarkdown(props: {
  generationId: string
  onComplete: () => void
  onVisibleProgress: () => void
}) {
  let activeSource = ''
  const [committedSources, setCommittedSources] = createSignal<string[]>([])
  const [hasVisibleText, setHasVisibleText] = createSignal(false)
  const [activeTail, setActiveTail] = createSignal<StreamingMarkdownTail>(
    parseStreamingMarkdownTail(''),
  )

  const syncActiveTail = () => {
    setActiveTail(parseStreamingMarkdownTail(activeSource))
  }

  const appendCommittedSource = (source: string) => {
    if (!source) return
    setCommittedSources((sources) => [...sources, source])
  }

  const commitStableBlocks = () => {
    const stableLength = stableMarkdownPrefixLength(activeSource)

    if (stableLength === 0) return
    appendCommittedSource(activeSource.slice(0, stableLength))
    activeSource = activeSource.slice(stableLength)
    syncActiveTail()
  }

  const commitAll = () => {
    if (!activeSource) return
    appendCommittedSource(activeSource)
    activeSource = ''
    syncActiveTail()
  }

  const replace = (text: string) => {
    setCommittedSources([])
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
    <div class="streaming-markdown">
      <For each={committedSources()}>
        {(source) => <MarkdownContent source={source} />}
      </For>
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
            <CodeBlock
              code={tail().code}
              generationId={props.generationId}
              language={tail().language}
              isStreaming
              showLineNumbers
            />
            <Show when={!tail().remainder}>
              <span aria-hidden="true" class="generation-output-caret" />
            </Show>
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
