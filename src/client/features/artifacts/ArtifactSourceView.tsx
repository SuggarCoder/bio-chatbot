import { createMemo, For, type Component } from 'solid-js'

import { renderMarkdown } from '../chatbot/markdown'
import type { ArtifactMimeType } from './types'

type ArtifactSourceViewProps = {
  type: ArtifactMimeType
  content: string
  language?: string
}

function sourceLanguage(type: ArtifactMimeType, language?: string) {
  const declared = language
    ?.trim()
    .toLowerCase()
    .match(/^[a-z0-9_+-]{1,32}/)?.[0]
  if (declared) return declared
  if (type === 'text/html' || type === 'image/svg+xml') return 'xml'
  if (type === 'text/markdown') return 'markdown'
  return undefined
}

function fencedSource(content: string, language?: string) {
  const longestBacktickRun = Math.max(
    0,
    ...(content.match(/`+/g) ?? []).map((run) => run.length),
  )
  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1))
  const suffix = content.endsWith('\n') ? '' : '\n'
  return `${fence}${language ?? ''}\n${content}${suffix}${fence}`
}

export const ArtifactSourceView: Component<ArtifactSourceViewProps> = (props) => {
  const language = () => sourceLanguage(props.type, props.language)
  const html = createMemo(() => renderMarkdown(
    fencedSource(props.content, language()),
  ))
  const lineNumbers = createMemo(() => Array.from(
    { length: Math.max(1, props.content.split(/\r\n|\r|\n/).length) },
    (_, index) => index + 1,
  ))

  return (
    <div class="artifact-source-view h-full min-h-0 overflow-auto bg-slate-950 text-slate-100">
      <div class="flex min-h-full min-w-max">
        <div
          aria-hidden="true"
          class="sticky left-0 z-10 shrink-0 select-none border-r border-slate-800 bg-slate-950/95 py-5 text-right font-mono text-xs text-slate-500 shadow-[6px_0_12px_rgba(2,6,23,0.18)]"
        >
          <For each={lineNumbers()}>
            {(lineNumber) => (
              <span
                class="block h-6 min-w-12 px-3 leading-6"
                data-line-number={lineNumber}
              >
                {lineNumber}
              </span>
            )}
          </For>
        </div>
        <div
          class="artifact-source-markdown min-w-0 flex-1 py-5 pl-4 pr-6"
          innerHTML={html()}
        />
      </div>
    </div>
  )
}
