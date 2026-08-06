import { createEffect, createSignal, onCleanup, type Component } from 'solid-js'
import { MarkdownContent } from '../chatbot/MarkdownContent'
import { sanitizeArtifactSvg } from './sanitizeSvg'
import type { ArtifactMimeType } from './types'

export { sanitizeArtifactSvg } from './sanitizeSvg'

export const HTML_ARTIFACT_SANDBOX = [
  'allow-scripts',
  'allow-modals',
  'allow-downloads',
  'allow-forms',
].join(' ')

export type ArtifactRendererProps = {
  artifactId: string
  version: number
  type: ArtifactMimeType
  title: string
  content: string
  language?: string
  isStreaming: boolean
}

export type ArtifactRendererDefinition = {
  type: ArtifactMimeType
  canPreview: boolean
  canEdit: boolean
  canExecute: boolean
  render: Component<ArtifactRendererProps>
}

const MarkdownRenderer: Component<ArtifactRendererProps> = (props) => {
  return <MarkdownContent source={props.content} class="p-5" />
}

export function buildHtmlSandboxDocument(content: string): string {
  const policy = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    "connect-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ')
  return `<meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer">${content}`
}

const HtmlRenderer: Component<ArtifactRendererProps> = (props) => {
  let timer: number | undefined
  const [document, setDocument] = createSignal(buildHtmlSandboxDocument(props.content))
  createEffect(() => {
    const next = props.content
    if (!props.isStreaming) {
      setDocument(buildHtmlSandboxDocument(next))
      return
    }
    if (timer !== undefined) window.clearTimeout(timer)
    timer = window.setTimeout(() => setDocument(buildHtmlSandboxDocument(next)), 180)
  })
  onCleanup(() => timer !== undefined && window.clearTimeout(timer))
  return (
    <iframe
      title={props.title}
      class="h-full min-h-96 w-full border-0 bg-white"
      sandbox={HTML_ARTIFACT_SANDBOX}
      referrerPolicy="no-referrer"
      srcdoc={document()}
    />
  )
}

const SvgRenderer: Component<ArtifactRendererProps> = (props) => {
  const [url, setUrl] = createSignal('')
  let currentUrl = ''
  createEffect(() => {
    const next = URL.createObjectURL(new Blob(
      [sanitizeArtifactSvg(props.content)],
      { type: 'image/svg+xml' },
    ))
    const previous = currentUrl
    currentUrl = next
    setUrl(next)
    if (previous) URL.revokeObjectURL(previous)
  })
  onCleanup(() => currentUrl && URL.revokeObjectURL(currentUrl))
  return <img class="h-full w-full object-contain p-5" src={url()} alt={props.title} />
}

export const artifactRenderers: Record<ArtifactMimeType, ArtifactRendererDefinition> = {
  'text/markdown': { type: 'text/markdown', canPreview: true, canEdit: false, canExecute: false, render: MarkdownRenderer },
  'text/html': { type: 'text/html', canPreview: true, canEdit: false, canExecute: true, render: HtmlRenderer },
  'image/svg+xml': { type: 'image/svg+xml', canPreview: true, canEdit: false, canExecute: false, render: SvgRenderer },
}

export const UnsupportedArtifactRenderer: Component<{ type: string }> = () => (
  <div class="grid min-h-64 place-items-center p-6 text-sm text-slate-500">
    该系统仅为生信分析使用,不支持您请求的类型
  </div>
)
