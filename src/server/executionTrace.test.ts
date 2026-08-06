/// <reference types="node" />

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_EXECUTION_DETAIL_LENGTH,
  MAX_EXECUTION_STEPS,
  executionStepsFromMetadata,
  metadataWithExecutionSteps,
  normalizeExecutionSteps,
  settleExecutionSteps,
  upsertExecutionStep,
} from './executionTrace.js'

test('execution trace normalization keeps only bounded public fields', () => {
  const steps = normalizeExecutionSteps(Array.from(
    { length: MAX_EXECUTION_STEPS + 5 },
    (_, index) => ({
      id: `step-${index}`,
      kind: 'tool',
      label: `Tool\n${index}`,
      status: 'completed',
      detail: 'x'.repeat(MAX_EXECUTION_DETAIL_LENGTH + 20),
      prompt: 'must-not-be-returned',
      arguments: { token: 'secret' },
      startedAt: '2026-08-06T00:00:00.000Z',
      completedAt: 'not-a-date',
    }),
  ))

  assert.equal(steps.length, MAX_EXECUTION_STEPS)
  assert.equal(steps[0]?.label, 'Tool 0')
  assert.equal(steps[0]?.detail?.length, MAX_EXECUTION_DETAIL_LENGTH)
  assert.equal(steps[0]?.completedAt, undefined)
  assert.equal('prompt' in (steps[0] ?? {}), false)
  assert.equal('arguments' in (steps[0] ?? {}), false)
})

test('execution trace upserts in place and settles active work', () => {
  const active = upsertExecutionStep([], {
    id: 'context',
    kind: 'context',
    label: '加载会话上下文',
    status: 'active',
  })
  const completed = upsertExecutionStep(active, {
    ...active[0]!,
    status: 'completed',
    detail: '已加载 4 条上下文消息',
  })
  const interrupted = settleExecutionSteps([
    ...completed,
    {
      id: 'response',
      kind: 'response' as const,
      label: '生成回答',
      status: 'active' as const,
    },
  ], false, '2026-08-06T00:00:05.000Z')

  assert.equal(completed.length, 1)
  assert.equal(completed[0]?.status, 'completed')
  assert.equal(interrupted[0]?.status, 'completed')
  assert.equal(interrupted[1]?.status, 'interrupted')
  assert.equal(interrupted[1]?.completedAt, '2026-08-06T00:00:05.000Z')
})

test('execution trace round-trips through generation metadata', () => {
  const metadata = metadataWithExecutionSteps(
    { contextMaxSeq: 12 },
    [{ id: 'response', label: '生成回答', status: 'completed' }],
  )

  assert.equal(metadata.contextMaxSeq, 12)
  assert.deepEqual(executionStepsFromMetadata(metadata), [
    { id: 'response', label: '生成回答', status: 'completed' },
  ])
})
