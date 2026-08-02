import type { Component } from 'solid-js'

import { CodeBlock } from '../chatbot/CodeBlock'
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

export const ArtifactSourceView: Component<ArtifactSourceViewProps> = (props) => {
  const language = () => sourceLanguage(props.type, props.language)

  return (
    <div class="artifact-source-view gpas-scrollbar scrollbar-fade h-full min-h-0 overflow-auto bg-slate-950 text-slate-100">
      <CodeBlock
        class="min-h-full rounded-none border-0"
        code={props.content}
        language={language()}
        showLineNumbers
      />
    </div>
  )
}
