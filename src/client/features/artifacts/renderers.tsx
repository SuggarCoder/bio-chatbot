import DOMPurify from 'dompurify'
import { createEffect, createSignal, onCleanup, Show, type Component } from 'solid-js'
import { CodeBlock } from '../chatbot/CodeBlock'
import { MarkdownContent } from '../chatbot/MarkdownContent'
import type { ArtifactMimeType } from './types'

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

const TextRenderer: Component<ArtifactRendererProps> = (props) => (
  <pre class="m-0 whitespace-pre-wrap break-words p-5 font-sans text-sm leading-6 text-slate-700">
    {props.content}
  </pre>
)

const CodeRenderer: Component<ArtifactRendererProps> = (props) => {
  return (
    <CodeBlock
      class="min-h-full rounded-none border-0"
      code={props.content}
      language={props.language}
      isStreaming={props.isStreaming}
      showLineNumbers
    />
  )
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
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcdoc={document()}
    />
  )
}

export function sanitizeArtifactSvg(source: string): string {
  const clean = DOMPurify.sanitize(source, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['script', 'foreignObject', 'style', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['style'],
  })
  const document = new DOMParser().parseFromString(String(clean), 'image/svg+xml')
  for (const element of document.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      const value = attribute.value.trim()
      if (name.startsWith('on')) element.removeAttribute(attribute.name)
      if ((name === 'href' || name === 'xlink:href') && !value.startsWith('#')) {
        element.removeAttribute(attribute.name)
      }
      if (/url\s*\(/i.test(value) || /^\s*javascript:/i.test(value)) {
        element.removeAttribute(attribute.name)
      }
    }
  }
  return new XMLSerializer().serializeToString(document.documentElement)
}

const SvgRenderer: Component<ArtifactRendererProps> = (props) => {
  const [url, setUrl] = createSignal('')
  createEffect(() => {
    const next = URL.createObjectURL(new Blob(
      [sanitizeArtifactSvg(props.content)],
      { type: 'image/svg+xml' },
    ))
    const previous = url()
    setUrl(next)
    if (previous) URL.revokeObjectURL(previous)
  })
  onCleanup(() => url() && URL.revokeObjectURL(url()))
  return <img class="h-full w-full object-contain p-5" src={url()} alt={props.title} />
}

const MermaidRenderer: Component<ArtifactRendererProps> = (props) => {
  const [svg, setSvg] = createSignal('')
  const [error, setError] = createSignal('')
  let revision = 0
  createEffect(() => {
    const content = props.content
    const current = ++revision
    setError('')
    void renderStrictMermaid(content, `artifact-mermaid-${current}`).then((result) => {
      if (current === revision) setSvg(result)
    }).catch((reason) => {
      if (current === revision) {
        setError(reason instanceof Error ? reason.message : 'Mermaid render failed')
      }
    })
  })
  return (
    <Show when={!error()} fallback={<p class="p-5 text-sm text-rose-600">{error()}</p>}>
      <div class="gpas-scrollbar scrollbar-fade grid min-h-96 place-items-center overflow-auto p-5" innerHTML={svg()} />
    </Show>
  )
}

export async function renderStrictMermaid(
  content: string,
  id = `artifact-mermaid-${crypto.randomUUID()}`,
): Promise<string> {
  const { default: mermaid } = await import('mermaid')
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
  })
  const result = await mermaid.render(id, content)
  return sanitizeArtifactSvg(result.svg)
}

export const artifactRenderers: Record<ArtifactMimeType, ArtifactRendererDefinition> = {
  'text/markdown': { type: 'text/markdown', canPreview: true, canEdit: false, canExecute: false, render: MarkdownRenderer },
  'text/plain': { type: 'text/plain', canPreview: true, canEdit: false, canExecute: false, render: TextRenderer },
  'text/html': { type: 'text/html', canPreview: true, canEdit: false, canExecute: true, render: HtmlRenderer },
  'image/svg+xml': { type: 'image/svg+xml', canPreview: true, canEdit: false, canExecute: false, render: SvgRenderer },
  'application/vnd.artifact.code': { type: 'application/vnd.artifact.code', canPreview: true, canEdit: false, canExecute: false, render: CodeRenderer },
  'application/vnd.artifact.mermaid': { type: 'application/vnd.artifact.mermaid', canPreview: true, canEdit: false, canExecute: false, render: MermaidRenderer },
}

export const UnsupportedArtifactRenderer: Component<{ type: string }> = (props) => (
  <div class="grid min-h-64 place-items-center p-6 text-sm text-slate-500">
    Unsupported Artifact type: {props.type}
  </div>
)
