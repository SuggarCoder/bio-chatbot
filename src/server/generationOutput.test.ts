import assert from 'node:assert/strict'
import test from 'node:test'

import { ArtifactServiceError } from './artifacts/service.js'
import {
  AGENT_EMPTY_ANSWER_FALLBACK,
  agentAnswerFallback,
  agentRoundTools,
  assertPersistableGenerationOutput,
} from './generation.js'

test('generation completion accepts persisted text or an Artifact', () => {
  assert.doesNotThrow(() => assertPersistableGenerationOutput('answer', 0, 0))
  assert.doesNotThrow(() => assertPersistableGenerationOutput('', 1, 1))
})

test('Artifact-only generation fails when no Artifact was persisted', () => {
  assert.throws(
    () => assertPersistableGenerationOutput('', 1, 0),
    (error) => error instanceof ArtifactServiceError &&
      error.code === 'ARTIFACT_STORAGE_FAILED',
  )
})

test('empty model output cannot be marked completed', () => {
  assert.throws(
    () => assertPersistableGenerationOutput('  ', 0, 0),
    /Qwen returned an empty response/,
  )
})

test('the last agent round is offered no tools at all', () => {
  const tools = [{ type: 'function' as const, name: 'file__result', parameters: {}, strict: false }]
  assert.deepEqual(agentRoundTools(tools, false), { tools, tool_choice: 'auto' })
  assert.deepEqual(agentRoundTools(tools, true), {})
  assert.deepEqual(agentRoundTools(undefined, false), {})
})

test('an agent run that queried data answers with a fallback instead of failing empty', () => {
  assert.equal(agentAnswerFallback(4, ''), AGENT_EMPTY_ANSWER_FALLBACK)
  assert.equal(agentAnswerFallback(1, '  \n'), AGENT_EMPTY_ANSWER_FALLBACK)
  assert.equal(agentAnswerFallback(4, '最高风险为 4 级。'), null)
  // Without any tool call an empty reply still fails as before.
  assert.equal(agentAnswerFallback(0, ''), null)
  assert.doesNotThrow(() => assertPersistableGenerationOutput(AGENT_EMPTY_ANSWER_FALLBACK, 0, 0))
})
