import {
  createSignal,
  onCleanup,
  onMount,
} from 'solid-js'

import { getAdaptiveStreamSession } from './adaptiveStream'
import { IncrementalMarkdownContent } from './IncrementalMarkdownContent'
import { MarkdownContent } from './MarkdownContent'

export function StaticMarkdown(props: { text: string }) {
  return <MarkdownContent source={props.text} />
}

export function StreamingMarkdown(props: {
  generationId: string
  onComplete: () => void
  onVisibleProgress: () => void
}) {
  const [visibleSource, setVisibleSource] = createSignal('')
  const [isStreaming, setIsStreaming] = createSignal(true)

  onMount(() => {
    const session = getAdaptiveStreamSession(props.generationId)

    if (!session) {
      props.onComplete()
      return
    }

    const unsubscribe = session.subscribe({
      append: (text) => setVisibleSource((source) => source + text),
      replace: setVisibleSource,
      progress: props.onVisibleProgress,
      complete: () => {
        setIsStreaming(false)
        props.onComplete()
      },
    })
    onCleanup(unsubscribe)
  })

  return <IncrementalMarkdownContent
    source={visibleSource()}
    isStreaming={isStreaming()}
    generationId={props.generationId}
  />
}
