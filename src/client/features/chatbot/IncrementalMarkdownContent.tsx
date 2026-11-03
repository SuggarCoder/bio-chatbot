import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
} from 'solid-js'

import { CodeBlock } from './CodeBlock'
import { MarkdownContent } from './MarkdownContent'
import { MermaidBlock } from './MermaidBlock'
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
  /** Text shown while the source is still empty; false shows nothing. */
  placeholder?: string | false
}) {
  let observedSource = ''
  let activeSource = ''
  const [committedSources, setCommittedSources] = createSignal<string[]>([])
  const [activeTail, setActiveTail] = createSignal<StreamingMarkdownTail>(
    parseStreamingMarkdownTail(''),
  )

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

    let tail = parseStreamingMarkdownTail(activeSource)
    // A fence closed (possibly with more text after it in the same delta,
    // since the server coalesces deltas): commit the block now, so the
    // diagram or code renders once instead of following every later delta.
    if (streaming && tail.kind === 'code' && tail.closed) {
      commitStableBlocks()
      tail = parseStreamingMarkdownTail(activeSource)
    }
    setActiveTail(tail)
  })

  const codeTail = createMemo(() => {
    const tail = activeTail()
    return tail.kind === 'code' ? tail : undefined
  })
  // Primitive memos: children re-run only when these values change, not on
  // every new tail object.
  const isCodeTail = createMemo(() => Boolean(codeTail()))
  const tailCode = createMemo(() => codeTail()?.code ?? '')
  const tailLanguage = createMemo(() => codeTail()?.language)
  const tailFilename = createMemo(() => codeTail()?.filename)
  const tailClosed = createMemo(() => codeTail()?.closed ?? false)
  const tailRemainder = createMemo(() => codeTail()?.remainder ?? '')
  const tailText = createMemo(() => {
    const tail = activeTail()
    return tail.kind === 'text' ? tail.source : ''
  })
  const showCaret = () => props.showCaret !== false && props.isStreaming

  return (
    <div class="streaming-markdown">
      <For each={committedSources()}>
        {(source) => <MarkdownContent source={source} />}
      </For>
      <Show when={props.source.length === 0 && props.placeholder !== false}>
        <span class="text-slate-400">{props.placeholder || '正在生成回复...'}</span>
      </Show>
      <Show
        when={isCodeTail()}
        fallback={
          <>
            <span class="whitespace-pre-wrap">{tailText()}</span>
            <Show when={showCaret()}>
              <span aria-hidden="true" class="generation-output-caret" />
            </Show>
          </>
        }
      >
        <Show
          when={tailLanguage() === 'mermaid'}
          fallback={
            <CodeBlock
              code={tailCode()}
              filename={tailFilename()}
              generationId={props.generationId}
              language={tailLanguage()}
              isStreaming={props.isStreaming}
              showLineNumbers
            />
          }
        >
          <MermaidBlock
            source={tailCode()}
            isStreaming={!tailClosed()}
          />
        </Show>
        <Show when={tailRemainder()}>
          <span class="whitespace-pre-wrap">{tailRemainder()}</span>
        </Show>
        <Show when={showCaret()}>
          <span aria-hidden="true" class="generation-output-caret" />
        </Show>
      </Show>
    </div>
  )
}

