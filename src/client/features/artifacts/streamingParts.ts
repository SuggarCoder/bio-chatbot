import type { ArtifactDraftClientState } from './types'

export type StreamingArtifactMessagePart =
  | {
      type: 'text'
      key: string
      text: string
    }
  | {
      type: 'artifact'
      key: string
      draft: ArtifactDraftClientState
    }

export type InlineArtifactRenderMode = 'markdown' | 'text' | 'source' | 'unsupported'

export function getInlineArtifactRenderMode(
  type: string,
): InlineArtifactRenderMode {
  if (type === 'text/markdown') return 'markdown'
  if (type === 'text/plain') return 'text'
  if (
    type === 'text/html' ||
    type === 'image/svg+xml' ||
    type === 'application/vnd.artifact.code' ||
    type === 'application/vnd.artifact.mermaid'
  ) return 'source'
  return 'unsupported'
}

export function shouldRevealCommittedArtifact(input: {
  visibleConversationId: string | null
  draftConversationId: string
  panelInteractionRevision: number
  panelRevisionAtStart: number
}) {
  return input.visibleConversationId === input.draftConversationId &&
    input.panelInteractionRevision === input.panelRevisionAtStart
}
export function projectStreamingArtifactParts(
  text: string,
  drafts: ArtifactDraftClientState[],
): StreamingArtifactMessagePart[] {
  const orderedDrafts = [...drafts].sort((left, right) =>
    left.textStartIndex - right.textStartIndex ||
    left.partOrder - right.partOrder ||
    left.streamId.localeCompare(right.streamId))
  const parts: StreamingArtifactMessagePart[] = []
  let textCursor = 0

  for (const draft of orderedDrafts) {
    if (draft.textStartIndex > text.length) break
    const boundary = Math.max(textCursor, Math.min(draft.textStartIndex, text.length))
    const leadingText = text.slice(textCursor, boundary)
    if (leadingText) {
      parts.push({
        type: 'text',
        key: `text-before-${draft.streamId}`,
        text: leadingText,
      })
    }
    parts.push({
      type: 'artifact',
      key: `artifact-${draft.streamId}`,
      draft,
    })
    textCursor = boundary
  }

  const trailingText = text.slice(textCursor)
  if (trailingText) {
    parts.push({
      type: 'text',
      key: 'text-after-artifacts',
      text: trailingText,
    })
  }

  return parts
}
