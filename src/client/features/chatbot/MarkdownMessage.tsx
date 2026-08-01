import {
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from 'solid-js'

import { getAdaptiveStreamSession } from './adaptiveStream'
import { renderMarkdown, stableMarkdownPrefixLength } from './markdown'

export function StaticMarkdown(props: { text: string }) {
  const html = createMemo(() => renderMarkdown(props.text))

  return <div class="markdown-message" innerHTML={html()} />
}

export function StreamingMarkdown(props: {
  generationId: string
  onComplete: () => void
  onVisibleProgress: () => void
}) {
  let committedRef: HTMLDivElement | undefined
  let activeNode: Text | undefined
  let activeSource = ''
  const [hasVisibleText, setHasVisibleText] = createSignal(false)

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
    if (activeNode) activeNode.data = activeSource
  }

  const commitAll = () => {
    if (!activeSource) return
    appendCommittedHtml(activeSource)
    activeSource = ''
    if (activeNode) activeNode.data = ''
  }

  const replace = (text: string) => {
    if (committedRef) committedRef.textContent = ''
    activeSource = text
    if (activeNode) activeNode.data = text
    setHasVisibleText(Boolean(text))
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
        activeNode?.appendData(text)
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
      <span
        class="whitespace-pre-wrap"
        ref={(element) => {
          activeNode = document.createTextNode(activeSource)
          element.append(activeNode)
        }}
      />
      <span aria-hidden="true" class="generation-output-caret" />
    </div>
  )
}
