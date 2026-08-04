import assert from 'node:assert/strict'
import test from 'node:test'

import { ArtifactServiceError } from './artifacts/service.js'
import { assertPersistableGenerationOutput } from './generation.js'

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
