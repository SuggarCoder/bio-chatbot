import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
  type Component,
} from 'solid-js'
import { highlightCode, renderMarkdown } from '../chatbot/markdown'
import { ArtifactCard } from './ArtifactCard'
import { getInlineArtifactRenderMode } from './streamingParts'
import type { ArtifactDraftClientState } from './types'

function useDebouncedHtml(
  source: () => string,
  render: (content: string) => string,
  delay = 100,
) {
  const [html, setHtml] = createSignal('')
  let timer: number | undefined

  createEffect(() => {
    const content = source()
    if (timer !== undefined) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      timer = undefined
      setHtml(render(content))
    }, delay)
  })

  onCleanup(() => {
    if (timer !== undefined) window.clearTimeout(timer)
  })
  return html
}

const sourceLanguage = (draft: ArtifactDraftClientState) => {
  if (draft.type === 'text/html') return 'html'
  if (draft.type === 'image/svg+xml') return 'xml'
  if (draft.type === 'application/vnd.artifact.mermaid') return 'mermaid'
  return undefined
}

const statusLabel = (draft: ArtifactDraftClientState) => {
  if (draft.status === 'streaming') return '正在生成并保存'
  if (draft.status === 'aborted') return '生成已中断'
  if (draft.status === 'incomplete') return '生成未完成'
  if (draft.status === 'invalid') return 'Artifact 无效'
  return '已完成'
}

const InlineDraftBody: Component<{ draft: ArtifactDraftClientState }> = (props) => {
  let scrollRef: HTMLDivElement | undefined
  let followTail = true
  const markdownHtml = useDebouncedHtml(
    () => props.draft.content,
    renderMarkdown,
  )
  const highlightedHtml = useDebouncedHtml(
    () => props.draft.content,
    (content) => highlightCode(
      content,
      props.draft.type === 'application/vnd.artifact.code'
        ? props.draft.language
        : sourceLanguage(props.draft),
    ).html,
    80,
  )
  const renderMode = () => getInlineArtifactRenderMode(props.draft.type)

  createEffect(() => {
    props.draft.content.length
    queueMicrotask(() => {
      if (scrollRef && followTail) scrollRef.scrollTop = scrollRef.scrollHeight
    })
  })

  return (
    <div
      ref={scrollRef}
      class="max-h-96 overflow-auto bg-slate-950"
      onScroll={() => {
        if (!scrollRef) return
        followTail = scrollRef.scrollHeight - scrollRef.scrollTop - scrollRef.clientHeight < 40
      }}
    >
      <Show when={renderMode() === 'markdown'}>
        <div class="markdown-message bg-white p-4 text-slate-700" innerHTML={markdownHtml()} />
      </Show>
      <Show when={renderMode() === 'text'}>
        <pre class="m-0 whitespace-pre-wrap break-words bg-white p-4 font-sans text-sm leading-6 text-slate-700">
          {props.draft.content}
        </pre>
      </Show>
      <Show when={renderMode() === 'source'}>
        <pre class="m-0 min-h-24 whitespace-pre-wrap break-words p-4 text-xs leading-5 text-slate-100">
          <code class="hljs" innerHTML={highlightedHtml()} />
        </pre>
      </Show>
      <Show when={renderMode() === 'unsupported'}>
        <p class="m-0 bg-white p-4 text-sm text-slate-500">
          Unsupported Artifact type: {props.draft.type}
        </p>
      </Show>
    </div>
  )
}

export const InlineArtifactDraft: Component<{
  draft: ArtifactDraftClientState
}> = (props) => {
  const committed = createMemo(() => (
    props.draft.status === 'complete' &&
    props.draft.artifactId &&
    props.draft.version
      ? {
          artifactId: props.draft.artifactId,
          version: props.draft.version,
        }
      : undefined
  ))

  return (
    <Show
      when={committed()}
      fallback={
        <section class="my-3 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <header class="flex items-center gap-3 border-b border-slate-200 px-4 py-3">
            <span class="i-lucide-file-code-2 h-5 w-5 shrink-0 text-teal-700" />
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-semibold text-slate-800">{props.draft.title}</p>
              <p class="truncate text-xs text-slate-500">{props.draft.type}</p>
            </div>
            <span
              class={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium ${
                props.draft.status === 'streaming'
                  ? 'bg-teal-50 text-teal-700'
                  : 'bg-amber-50 text-amber-700'
              }`}
              role="status"
              aria-live="polite"
            >
              <Show when={props.draft.status === 'streaming'}>
                <span class="i-lucide-loader-circle h-3 w-3 animate-spin" />
              </Show>
              {statusLabel(props.draft)}
            </span>
          </header>
          <InlineDraftBody draft={props.draft} />
          <Show when={props.draft.error}>
            {(error) => (
              <p class="m-0 border-t border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-800">
                {error()}
              </p>
            )}
          </Show>
        </section>
      }
    >
      {(value) => (
        <ArtifactCard
          artifactId={value().artifactId}
          logicalId={props.draft.logicalId}
          title={props.draft.title}
          type={props.draft.type}
          version={value().version}
        />
      )}
    </Show>
  )
}
