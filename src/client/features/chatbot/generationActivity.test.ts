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
  assert.equal(thinking?.phase, 'thinking')
  assert.equal(responding?.phase, 'responding')
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
  assert.equal(responding?.phase, 'responding')
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
