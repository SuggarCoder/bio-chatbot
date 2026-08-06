import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getInlineArtifactRenderMode,
  projectStreamingArtifactParts,
  shouldRevealCommittedArtifact,
} from './streamingParts'
import type { ArtifactDraftClientState } from './types'

function draft(
  streamId: string,
  textStartIndex: number,
  partOrder: number,
): ArtifactDraftClientState {
  return {
    streamId,
    messageId: 'message-1',
    generationId: 'generation-1',
    conversationId: 'conversation-1',
    logicalId: streamId,
    operation: 'create',
    type: 'text/html',
    title: streamId,
    baseVersion: null,
    textStartIndex,
    partOrder,
    panelRevisionAtStart: 0,
    content: '<main />',
    status: 'streaming',
  }
}

test('projects ordinary text around an Artifact at its stream boundary', () => {
  const result = projectStreamingArtifactParts(
    'Before.After',
    [draft('dashboard', 7, 1)],
  )

  assert.deepEqual(result.map((part) => part.type === 'text'
    ? `text:${part.text}`
    : `artifact:${part.draft.streamId}`), [
    'text:Before.',
    'artifact:dashboard',
    'text:After',
  ])
})

test('does not reveal a Draft before preceding adaptive text is visible', () => {
  assert.deepEqual(
    projectStreamingArtifactParts('Bef', [draft('dashboard', 7, 1)]),
    [{ type: 'text', key: 'text-after-artifacts', text: 'Bef' }],
  )
})

test('orders multiple Artifacts sharing a text boundary by part order', () => {
  const result = projectStreamingArtifactParts('', [
    draft('second', 0, 2),
    draft('first', 0, 1),
  ])
  assert.deepEqual(result.map((part) => part.type === 'artifact'
    ? part.draft.streamId
    : part.text), ['first', 'second'])
})

test('only safe text render modes are used before commit', () => {
  assert.equal(getInlineArtifactRenderMode('text/markdown'), 'markdown')
  assert.equal(getInlineArtifactRenderMode('text/html'), 'source')
  assert.equal(getInlineArtifactRenderMode('image/svg+xml'), 'source')
  assert.equal(getInlineArtifactRenderMode('text/plain'), 'unsupported')
  assert.equal(getInlineArtifactRenderMode('application/vnd.artifact.code'), 'unsupported')
  assert.equal(getInlineArtifactRenderMode('application/vnd.artifact.mermaid'), 'unsupported')
  assert.equal(getInlineArtifactRenderMode('application/javascript'), 'unsupported')
})

test('auto reveal requires the visible conversation and no manual panel action', () => {
  assert.equal(shouldRevealCommittedArtifact({
    visibleConversationId: 'conversation-1',
    draftConversationId: 'conversation-1',
    panelInteractionRevision: 3,
    panelRevisionAtStart: 3,
  }), true)
  assert.equal(shouldRevealCommittedArtifact({
    visibleConversationId: 'conversation-2',
    draftConversationId: 'conversation-1',
    panelInteractionRevision: 3,
    panelRevisionAtStart: 3,
  }), false)
  assert.equal(shouldRevealCommittedArtifact({
    visibleConversationId: 'conversation-1',
    draftConversationId: 'conversation-1',
    panelInteractionRevision: 4,
    panelRevisionAtStart: 3,
  }), false)
})
