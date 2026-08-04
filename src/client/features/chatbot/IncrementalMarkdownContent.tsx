import {
  createEffect,
  createSignal,
  For,
  Show,
} from 'solid-js'

import { CodeBlock } from './CodeBlock'
import { MarkdownContent } from './MarkdownContent'
import {
  parseStreamingMarkdownTail,
  stableMarkdownPrefixLength,
  type StreamingMarkdownTail,
} from './markdown'

export function IncrementalMarkdownContent(props: {
  source: string
  isStreaming: boolean
  generationId?: string
  showCaret?: boolean
}) {
  let observedSource = ''
  let activeSource = ''
  const [committedSources, setCommittedSources] = createSignal<string[]>([])
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
  }

  const commitAll = () => {
    appendCommittedSource(activeSource)
    activeSource = ''
  }

  createEffect(() => {
    const source = props.source
    const streaming = props.isStreaming
    let delta = ''
    let replaced = false

    if (!source.startsWith(observedSource)) {
      observedSource = source
      activeSource = source
      setCommittedSources([])
      replaced = true
    } else {
      delta = source.slice(observedSource.length)
      observedSource = source
      activeSource += delta
    }

    if (!streaming) {
      commitAll()
    } else if (replaced) {
      commitStableBlocks()
    } else {
      const completesBlankLine =
        delta.includes('\n\n') ||
        (activeSource.slice(0, -delta.length).endsWith('\n') && delta.startsWith('\n'))
      if (
        delta.includes('\n') &&
        (
          completesBlankLine ||
          /(?:^|\n)\s{0,3}(?:`{3,}|~{3,})\s*\n?$/.test(activeSource) ||
          /^\s{0,3}#{1,6}\s+.*\n$/.test(activeSource)
        )
      ) {
        commitStableBlocks()
      }
    }
    syncActiveTail()
  })

  return (
    <div class="streaming-markdown">
      <For each={committedSources()}>
        {(source) => <MarkdownContent source={source} />}
      </For>
      <Show when={props.source.length === 0}>
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
            <Show when={props.showCaret !== false && props.isStreaming}>
              <span aria-hidden="true" class="generation-output-caret" />
            </Show>
          </>
        }
      >
        {(tail) => (
          <>
            <CodeBlock
              code={tail().code}
              generationId={props.generationId}
              language={tail().language}
              isStreaming={props.isStreaming}
              showLineNumbers
            />
            <Show when={tail().remainder}>
              <span class="whitespace-pre-wrap">{tail().remainder}</span>
            </Show>
            <Show when={props.showCaret !== false && props.isStreaming}>
              <span aria-hidden="true" class="generation-output-caret" />
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}
