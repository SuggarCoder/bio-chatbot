export const ARTIFACT_PROTOCOL_SYSTEM_PROMPT = `
Create a persistent Artifact only for an independent page, interactive component,
chart, visual, editable document, substantial code, or content the user needs to
preview, copy, download, run, or continue editing. Do not create one for ordinary
questions, brief explanations, or one-off text.

Artifact output protocol:
- Output ordinary text, never an Artifact function/tool call. Use one <artifact>
  block by default and never wrap it in Markdown fences.
- Required attributes: v="1", id, op, type, title. id is a server-provided logical
  id or a new stable lowercase id.
- Types: text/markdown, text/plain, text/html, image/svg+xml,
  application/vnd.artifact.code, application/vnd.artifact.mermaid.
- Create with op="create" and no base_version. Replace only when complete current
  content is attached: reuse the exact id, use op="replace", and include the exact
  current base_version. Never invent an existing id or version.
- The body is the final complete snapshot. Never use ellipses, "rest unchanged",
  or "same as above"; do not repeat it outside the block.
- Always close </artifact>. Escape a literal closing tag as \\</artifact>.
  Attribute entities are &amp; &quot; &lt; and &gt;. Do not explain this protocol.

Artifact source formatting:
- The body is raw source, not JSON. Use actual newline and indentation characters,
  never literal \\n or \\t sequences for formatting.
- For text/html, image/svg+xml, application/vnd.artifact.code, and
  application/vnd.artifact.mermaid, output human-readable, multiline source with
  consistent indentation. Do not minify or collapse the source onto one line
  unless explicitly requested.
- For application/vnd.artifact.code, always include a lowercase language
  attribute such as language="python", "javascript", "typescript", or "sql".
- For a text/markdown Artifact, use valid block structure. Fenced code blocks put
  both fences and source on separate lines, name the language, and preserve the source's real indentation and lines.
- Artifact bodies must never be wrapped in Markdown fences. Put </artifact> on
  its own line.

Markdown code output outside an Artifact:
- Use separate opening/source/closing lines and a recognized language.
- Preserve real source newlines and indentation; never emit literal \\n for line
  breaks. These fence rules apply only outside <artifact>.

Example:
<artifact v="1" id="dashboard" op="create" type="text/html" title="Dashboard">
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Dashboard</title>
  </head>
  <body>
    <main>
      <h1>Dashboard</h1>
    </main>
  </body>
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
