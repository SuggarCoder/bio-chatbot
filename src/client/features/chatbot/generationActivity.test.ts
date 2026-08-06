/// <reference types="node" />

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createGenerationActivity,
  getToolActivityLabel,
  reduceGenerationActivity,
} from './generationActivity'

test('generation activity follows start and first-token phases', () => {
  const generationId = crypto.randomUUID()
  const queued = createGenerationActivity(generationId)
  const thinking = reduceGenerationActivity(queued, {
    type: 'generation-start',
    generationId,
  })
  const responding = reduceGenerationActivity(thinking, {
    type: 'text-delta',
    generationId,
  })

  assert.equal(queued.phase, 'queued')
  assert.deepEqual(queued.steps.map((step) => step.id), ['request', 'queue'])
  assert.equal(thinking?.phase, 'thinking')
  assert.equal(responding?.phase, 'responding')
})

test('server progress steps are ordered, idempotent, and drive the phase', () => {
  const generationId = crypto.randomUUID()
  const activity = createGenerationActivity(generationId)
  const reasoning = reduceGenerationActivity(activity, {
    type: 'progress-step',
    generationId,
    step: {
      id: 'reasoning:1',
      kind: 'reasoning',
      label: '分析并组织回答',
      status: 'active',
    },
  })
  const completed = reduceGenerationActivity(reasoning, {
    type: 'progress-step',
    generationId,
    step: {
      id: 'reasoning:1',
      kind: 'reasoning',
      label: '分析并组织回答',
      status: 'completed',
    },
  })
  const response = reduceGenerationActivity(completed, {
    type: 'progress-step',
    generationId,
    step: {
      id: 'response',
      kind: 'response',
      label: '生成回答',
      status: 'active',
    },
  })

  assert.equal(reasoning?.phase, 'thinking')
  assert.equal(completed?.steps.filter((step) => step.id === 'reasoning:1').length, 1)
  assert.equal(completed?.steps.at(-1)?.status, 'completed')
  assert.equal(response?.phase, 'responding')
  assert.equal(response?.steps.at(-1)?.id, 'response')
})

test('tool and reconnect phases restore an honest visible state', () => {
  const generationId = crypto.randomUUID()
  const tool = reduceGenerationActivity(
    createGenerationActivity(generationId),
    {
      type: 'tool-start',
      generationId,
      toolName: 'database_query',
    },
  )
  const thinking = reduceGenerationActivity(tool, {
    type: 'tool-result',
    generationId,
  })
  const reconnecting = reduceGenerationActivity(thinking, {
    type: 'reconnecting',
    generationId,
  })
  const responding = reduceGenerationActivity(reconnecting, {
    type: 'connected',
    generationId,
    hasContent: true,
  })

  assert.equal(tool?.toolLabel, '正在查询数据')
  assert.equal(thinking?.phase, 'thinking')
  assert.equal(reconnecting?.phase, 'reconnecting')
  assert.equal(reconnecting?.steps.at(-1)?.id, 'transport')
  assert.equal(responding?.phase, 'responding')
  assert.equal(responding?.steps.at(-1)?.status, 'completed')
  assert.equal(getToolActivityLabel('internal-secret'), '正在调用工具')
})

test('stale generation actions and terminal events are isolated', () => {
  const generationId = crypto.randomUUID()
  const activity = createGenerationActivity(generationId)
  const stale = reduceGenerationActivity(activity, {
    type: 'text-delta',
    generationId: crypto.randomUUID(),
  })
  const terminal = reduceGenerationActivity(activity, {
    type: 'terminal',
    generationId,
  })

  assert.deepEqual(stale, activity)
  assert.equal(terminal, undefined)
})
