import { parse } from 'parse5'

export type ArtifactOutlineSection = {
  ordinal: number
  byteStart: number
  byteEnd: number
  headingPath: string
  preview: string
  embeddingText: string
}

export type ArtifactOutline = {
  outline: string
  sections: ArtifactOutlineSection[]
}

type Anchor = {
  charStart: number
  charEnd: number
  label: string
}

type HtmlNode = {
  nodeName?: string
  tagName?: string
  value?: string
  attrs?: Array<{ name: string; value: string }>
  childNodes?: HtmlNode[]
  sourceCodeLocation?: {
    startOffset?: number
    endOffset?: number
    startTag?: { startOffset?: number; endOffset?: number }
  }
}

function textContent(node: HtmlNode): string {
  if (typeof node.value === 'string') return node.value
  return (node.childNodes ?? []).map(textContent).join('')
}

function utf8Offset(text: string, charOffset: number): number {
  return Buffer.byteLength(text.slice(0, charOffset), 'utf8')
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const lines = text.split('\n')
  const kept: string[] = []
  let bytes = 0
  for (const line of lines) {
    const next = Buffer.byteLength(`${line}\n`, 'utf8')
    if (bytes + next > maxBytes - 32) break
    kept.push(line)
    bytes += next
  }
  kept.push('[大纲已截断]')
  return kept.join('\n')
}

function htmlAnchors(content: string): Anchor[] {
  const errors: unknown[] = []
  const document = parse(content, {
    sourceCodeLocationInfo: true,
    onParseError: (error) => errors.push(error),
  }) as unknown as HtmlNode
  const anchors: Anchor[] = []

  const visit = (node: HtmlNode, headings: string[]) => {
    const tag = node.tagName?.toLowerCase()
    const location = node.sourceCodeLocation
    let nextHeadings = headings
    if (tag && location?.startOffset !== undefined) {
      const attrs = Object.fromEntries((node.attrs ?? []).map((attr) => [attr.name, attr.value]))
      const heading = /^h[1-6]$/.test(tag)
        ? textContent(node).replace(/\s+/g, ' ').trim().slice(0, 160)
        : ''
      if (heading) {
        const level = Number(tag.slice(1))
        nextHeadings = [...headings.slice(0, level - 1), heading]
      }
      if (
        heading ||
        ['title', 'main', 'section', 'article', 'header', 'footer', 'script', 'style'].includes(tag) ||
        (tag === 'div' && (attrs.id || attrs.class))
      ) {
        const identity = attrs.id
          ? `#${attrs.id}`
          : attrs.class
            ? `.${attrs.class.split(/\s+/).filter(Boolean).slice(0, 3).join('.')}`
            : ''
        const firstLine = textContent(node).trim().split(/\r?\n/, 1)[0]
          ?.replace(/\s+/g, ' ').slice(0, 120) ?? ''
        const path = nextHeadings.filter(Boolean).join(' > ')
        const label = [
          `<${tag}${identity}>`,
          path,
          ['script', 'style'].includes(tag) ? firstLine : '',
        ].filter(Boolean).join(' — ')
        anchors.push({
          charStart: location.startOffset,
          charEnd: location.endOffset ?? content.length,
          label,
        })
      }
    }
    for (const child of node.childNodes ?? []) visit(child, nextHeadings)
  }
  visit(document, [])
  anchors.sort((a, b) => a.charStart - b.charStart || b.charEnd - a.charEnd)
  return anchors.filter((anchor, index) => (
    index === 0 || anchor.charStart !== anchors[index - 1].charStart
  ))
}

function markdownAnchors(content: string): Anchor[] {
  const anchors: Anchor[] = []
  const headings: string[] = []
  const pattern = /^(#{1,6})\s+(.+)$/gm
  for (const match of content.matchAll(pattern)) {
    const level = match[1].length
    headings.splice(level - 1)
    headings[level - 1] = match[2].trim()
    anchors.push({
      charStart: match.index,
      charEnd: content.length,
      label: headings.filter(Boolean).join(' > '),
    })
  }
  return anchors
}

function genericAnchors(content: string): Anchor[] {
  const anchors: Anchor[] = []
  const pattern = /^(?:\s*(?:function|class|interface|type|const|let|var)\s+[^\s({:=]+|\s*(?:subgraph|graph|flowchart|sequenceDiagram|classDiagram)\b|\s*<g\b[^>]*(?:id|class)=["'][^"']+["'])/gmi
  for (const match of content.matchAll(pattern)) {
    anchors.push({
      charStart: match.index,
      charEnd: content.length,
      label: match[0].trim().replace(/\s+/g, ' ').slice(0, 160),
    })
  }
  return anchors
}

function safeChunkEnd(buffer: Buffer, start: number, desired: number): number {
  let end = Math.min(buffer.length, desired)
  if (end >= buffer.length) return buffer.length
  while (end > start && (buffer[end] & 0xc0) === 0x80) end -= 1
  const lineBreak = buffer.lastIndexOf(0x0a, end)
  return lineBreak > start + 1024 ? lineBreak + 1 : end
}

export function extractArtifactOutline(
  content: string,
  mimeType: string,
  maxOutlineBytes = 8 * 1024,
  maxSectionBytes = 16 * 1024,
): ArtifactOutline {
  const buffer = Buffer.from(content, 'utf8')
  let anchors = mimeType === 'text/html'
    ? htmlAnchors(content)
    : mimeType === 'text/markdown'
      ? markdownAnchors(content)
      : genericAnchors(content)
  if (anchors.length === 0) {
    anchors = [{ charStart: 0, charEnd: content.length, label: '文档正文' }]
  }

  const byteAnchors = anchors.map((anchor, index) => ({
    start: utf8Offset(content, anchor.charStart),
    end: utf8Offset(
      content,
      Math.min(
        anchor.charEnd,
        anchors[index + 1]?.charStart ?? content.length,
      ),
    ),
    label: anchor.label,
  })).filter((anchor) => anchor.end > anchor.start)

  const sections: ArtifactOutlineSection[] = []
  for (const anchor of byteAnchors) {
    let start = anchor.start
    while (start < anchor.end) {
      const end = safeChunkEnd(
        buffer,
        start,
        Math.min(anchor.end, start + maxSectionBytes),
      )
      if (end <= start) break
      const text = buffer.subarray(start, end).toString('utf8')
      const preview = text.trim().split(/\r?\n/).filter(Boolean)[0]
        ?.replace(/\s+/g, ' ').slice(0, 240) ?? ''
      sections.push({
        ordinal: sections.length,
        byteStart: start,
        byteEnd: end,
        headingPath: anchor.label,
        preview,
        embeddingText: `${anchor.label}\n${text}`.slice(0, 8_000),
      })
      start = end
    }
  }

  const outline = sections.map((section) => (
    `[${section.byteStart}-${section.byteEnd}B] ${section.headingPath}` +
    (section.preview ? ` — ${section.preview}` : '')
  )).join('\n')
  return {
    outline: truncateUtf8(outline, maxOutlineBytes),
    sections,
  }
}

export function validateArtifactSyntax(content: string, mimeType: string): void {
  if (mimeType === 'text/markdown') {
    const fences = content.match(/^\s*(```|~~~)/gm) ?? []
    if (fences.length % 2 !== 0) {
      throw new Error('Markdown code fence is not closed')
    }
    return
  }
  if (mimeType === 'text/html') {
    const errors: Array<{ code?: string }> = []
    parse(content, {
      sourceCodeLocationInfo: false,
      onParseError: (error) => errors.push(error),
    })
    const fatal = errors.find((error) => [
      'eof-in-element-that-can-contain-only-text',
      'eof-in-script-html-comment-like-text',
      'eof-before-tag-name',
      'missing-end-tag-name',
    ].includes(error.code ?? ''))
    if (fatal) throw new Error(`HTML parse failed: ${fatal.code}`)
  }
}
