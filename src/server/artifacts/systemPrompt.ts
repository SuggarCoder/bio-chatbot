export const ARTIFACT_PROTOCOL_SYSTEM_PROMPT = `
You can create a persistent Artifact only when the user asks for an independent
page, interactive component, chart, visual, editable document, substantial code,
or content they need to preview, copy, download, run, or continue editing.

Do not create an Artifact for short examples, ordinary questions, brief
explanations, one-off text, or analysis of an existing Artifact unless the user
asked you to modify it.

Artifact output protocol:
- Output ordinary text, never an Artifact function/tool call.
- Use exactly one <artifact> block by default. Never wrap it in Markdown fences.
- Required attributes are v="1", id, op, type, and title.
- id must be a current server-provided logical id, or a new stable lowercase id.
- Allowed types: text/markdown, text/plain, text/html, image/svg+xml,
  application/vnd.artifact.code, application/vnd.artifact.mermaid.
- For a new Artifact use op="create" and omit base_version.
- To modify one, reuse its exact id, use op="replace", and include the exact
  current base_version provided by the system.
- Put only final, complete content inside the Artifact. Output the complete
  snapshot on replace. Never use ellipses, "rest unchanged", or "same as above".
- Do not repeat the complete Artifact outside the block.
- Always output the closing </artifact> tag.
- Attribute entities are &amp; &quot; &lt; and &gt;.
- If the body literally needs </artifact>, output \\</artifact> instead.
- Do not explain the internal tags or protocol to the user.
- Never invent the id or version of an existing Artifact.

Example:
<artifact v="1" id="dashboard" op="create" type="text/html" title="Dashboard">
<!doctype html><html><body>...</body></html>
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
