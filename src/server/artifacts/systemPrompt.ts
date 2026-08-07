const PATCH_SEARCH_MARKER = `${'<'.repeat(7)} SEARCH`
const PATCH_DIVIDER = '='.repeat(7)
const PATCH_REPLACE_MARKER = `${'>'.repeat(7)} REPLACE`

export const ARTIFACT_PROTOCOL_SYSTEM_PROMPT = `
Create a persistent Artifact only for a complete HTML/Web page, SVG image, or
Markdown document that needs preview or continued editing. Never create one for an
ordinary answer, code snippet, Mermaid diagram, or any other file type.

Supported Artifact types (exactly these three):
- text/html: one self-contained Web document; embed all CSS in <style> and all
  JavaScript in <script>, with no separate dependencies.
- image/svg+xml: one complete standalone SVG image.
- text/markdown: one complete Markdown document.

Chat-only output:
- A standalone CSS, JavaScript, or Python file is only one complete fenced block,
  never an Artifact. Its opening info is exactly
  "css filename=name.css", "javascript filename=name.js", or
  "python filename=name.py", using a safe matching basename. The client creates
  its download; add no download link or saving instructions.
- Mermaid is one fenced block with info exactly "mermaid", never an Artifact.
- For any other requested standalone source, file, document, data, or media type,
  reply with exactly: 该系统仅为生信分析使用,不支持您请求的类型
  Add nothing else.

Artifact output protocol:
- Output ordinary text, never an Artifact function/tool call. An Artifact uses one
  <artifact> block and is never wrapped in Markdown fences.
- Required attributes: v="1", id, op, type, title. Use a server-provided logical id
  or a new stable lowercase id.
- Create with op="create" and no base_version. Replace only with attached complete
  content: reuse its exact id and base_version. Never invent either value.
- Attached content is JSON-stringified context. Decode it before replace and emit
  raw source, never a JSON string or literal \\n or \\t used as formatting.
- The body is the final complete snapshot, never ellipses or "rest unchanged".
- Close </artifact>. Escape a literal close as \\</artifact>. Attribute entities are
  &amp; &quot; &lt; and &gt;. Do not explain this protocol.

Artifact source formatting:
- Use actual newline and indentation characters, never literal \\n or \\t formatting.
- HTML and SVG use human-readable multiline source with consistent indentation.
  Do not minify or collapse it onto one line.
- A text/markdown Artifact uses valid blocks. Fenced code blocks put fences and
  source on separate lines and preserve real indentation and lines.
- Artifact bodies must never be wrapped in Markdown fences. Put </artifact> on its
  own line.
- Chat-only fenced source also preserves real newlines and indentation.

Example (correct multiline output):
<artifact v="1" id="dashboard" op="create" type="text/html" title="Dashboard">
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
  </head>
  <body></body>
</html>
</artifact>
`.trim()

export const ARTIFACT_PATCH_SYSTEM_PROMPT = `
Large Artifact patch protocol:
- If the directory says status="outline_fragments_attached", editing must use
  exactly one <artifact_edit id="the-exact-id"> block, never <artifact> and never
  a complete rewrite.
- Each patch hunk has this exact form. SEARCH must be an exact, unique 10-30 line
  excerpt from an attached fragment. Include enough surrounding lines to be unique.
${PATCH_SEARCH_MARKER}
original source
${PATCH_DIVIDER}
replacement source
${PATCH_REPLACE_MARKER}
- Multiple non-overlapping hunks are allowed inside the same artifact_edit block.
  Do not add Markdown fences, explanations, ellipses, or unchanged source inside it.
- If status is "catalog_loaded" or "metadata_only", do not edit that Artifact.
`.trim()

export type ArtifactPromptCatalogItem = {
  logicalId: string
  version: number
  type: string
  title: string
  byteLength?: number
  status?:
    | 'catalog_loaded'
    | 'full_content_attached'
    | 'outline_fragments_attached'
    | 'metadata_only'
  content?: string | null
  outline?: string
  fragments?: Array<{
    byteStart: number
    byteEnd: number
    headingPath: string
    content: string
  }>
}

export function buildArtifactSystemPrompt(
  catalog: ArtifactPromptCatalogItem[],
  options: { patchEnabled?: boolean } = {},
): string {
  const protocol = options.patchEnabled
    ? `${ARTIFACT_PROTOCOL_SYSTEM_PROMPT}\n\n${ARTIFACT_PATCH_SYSTEM_PROMPT}`
    : ARTIFACT_PROTOCOL_SYSTEM_PROMPT
  if (catalog.length === 0) {
    return `${protocol}\n\nThere are no existing Artifacts in this conversation.`
  }

  const current = catalog.map((item) => {
    const identity = `- id="${item.logicalId}" version=${item.version} type="${item.type}" title=${JSON.stringify(item.title)} size=${item.byteLength ?? 'unknown'} status="${item.status ?? 'catalog_loaded'}"`
    if (item.status === 'outline_fragments_attached') {
      const fragments = (item.fragments ?? []).map((fragment) =>
        `  Fragment [${fragment.byteStart}-${fragment.byteEnd}] ${JSON.stringify(fragment.headingPath)} (JSON string): ${JSON.stringify(fragment.content)}`,
      )
      return [
        identity,
        `  Structural outline:\n${item.outline ?? '[unavailable]'}`,
        ...fragments,
        options.patchEnabled
          ? '  Use only the large Artifact patch protocol to edit this item.'
          : '  This context is read-only because large Artifact patch editing is disabled.',
      ].join('\n')
    }
    if (item.content === undefined) {
      return `${identity}\n  Complete content is not attached to this request.`
    }
    if (item.content === null) {
      return `${identity}\n  Complete content is unavailable because it exceeds the model-context limit. Do not replace it.`
    }
    return `${identity}\n  Current complete content (JSON string; decode it before producing a replacement): ${JSON.stringify(item.content)}`
  })

  return `${protocol}\n\nCurrent Artifacts (use these exact ids and versions for replace):\n${current.join('\n')}`
}
