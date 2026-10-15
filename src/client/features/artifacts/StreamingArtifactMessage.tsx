import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type Component,
} from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import { getAdaptiveStreamSession } from '../chatbot/adaptiveStream'
import { IncrementalMarkdownContent } from '../chatbot/IncrementalMarkdownContent'
import { artifactStore } from './artifactStore'
import { InlineArtifactDraft } from './InlineArtifactDraft'
import { projectStreamingArtifactParts } from './streamingParts'

export const StreamingArtifactMessage: Component<{
  generationId: string
  text?: string
  isStreaming: boolean
  onComplete: () => void
  onVisibleProgress: () => void
}> = (props) => {
  const [visibleText, setVisibleText] = createSignal(props.text ?? '')
  const drafts = createMemo(() => Object.values(
    artifactStore.state.draftsByStreamId,
  ).filter((draft) => draft.generationId === props.generationId))
  const [parts, setParts] = createStore(
    projectStreamingArtifactParts(visibleText(), drafts()),
  )

  createEffect(() => {
    setParts(reconcile(
      projectStreamingArtifactParts(visibleText(), drafts()),
      { key: 'key' },
    ))
  })

  onMount(() => {
    if (!props.isStreaming) return
    const session = getAdaptiveStreamSession(props.generationId)
    if (!session) {
      props.onComplete()
      return
    }
    const unsubscribe = session.subscribe({
      append: (text) => setVisibleText((value) => value + text),
      replace: setVisibleText,
      progress: props.onVisibleProgress,
      complete: () => props.onComplete(),
    })
    onCleanup(unsubscribe)
  })

  let previousArtifactLength = 0
  createEffect(() => {
    const artifactLength = drafts().reduce(
      (total, draft) => total + draft.content.length,
      0,
    )
    if (props.isStreaming && artifactLength > previousArtifactLength) {
      props.onVisibleProgress()
    }
    previousArtifactLength = artifactLength
  })

  return (
    <div>
      <Show when={parts.length > 0} fallback={<span class="text-slate-400">正在生成回复...</span>}>
        <For each={parts}>
          {(part) => part.type === 'text'
            ? (
                <IncrementalMarkdownContent
                  source={part.text}
                  isStreaming={props.isStreaming}
                  generationId={props.generationId}
                  showCaret={false}
                />
              )
            : <InlineArtifactDraft draft={part.draft} />}
        </For>
      </Show>
    </div>
  )
}
