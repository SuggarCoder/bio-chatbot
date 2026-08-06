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

export type ArtifactPromptCatalogItem = {
  logicalId: string
  version: number
  type: string
  title: string
  content?: string | null
}

export function buildArtifactSystemPrompt(
  catalog: ArtifactPromptCatalogItem[],
): string {
  if (catalog.length === 0) {
    return `${ARTIFACT_PROTOCOL_SYSTEM_PROMPT}\n\nThere are no existing Artifacts in this conversation.`
  }

  const current = catalog.map((item) => {
    const identity = `- id="${item.logicalId}" version=${item.version} type="${item.type}" title=${JSON.stringify(item.title)}`
    if (item.content === undefined) {
      return `${identity}\n  Complete content is not attached to this request. Do not replace it.`
    }
    if (item.content === null) {
      return `${identity}\n  Complete content is unavailable because it exceeds the model-context limit. Do not replace it.`
    }
    return `${identity}\n  Current complete content (JSON string; decode it before producing a replacement): ${JSON.stringify(item.content)}`
  })

  return `${ARTIFACT_PROTOCOL_SYSTEM_PROMPT}\n\nCurrent Artifacts (use these exact ids and versions for replace):\n${current.join('\n')}`
}
