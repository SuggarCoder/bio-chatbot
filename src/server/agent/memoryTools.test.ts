import assert from 'node:assert/strict'
import test from 'node:test'

import type { Database } from '../db/client.js'
import { createMemoryToolRunner } from './memoryTools.js'
import { combineToolRunners, type ToolRunner } from './tools.js'

const context = {
  database: {} as Database,
  userId: '00000000-0000-0000-0000-000000000001',
  chatId: '00000000-0000-0000-0000-000000000002',
}

test('memory tools are offered only for what the run may do', () => {
  assert.equal(createMemoryToolRunner(context, { readMemory: false, editMemory: false, searchChats: false }), null)
  const editOnly = createMemoryToolRunner(context, { readMemory: true, editMemory: true, searchChats: false })!
  assert.deepEqual(editOnly.tools.map((tool) => tool.name), ['memory__save', 'memory__delete'])
  assert.match(editOnly.instructions(), /memory__save/)
  assert.doesNotMatch(editOnly.instructions(), /chat__search/)
  const searchOnly = createMemoryToolRunner(context, { readMemory: false, editMemory: false, searchChats: true })!
  assert.deepEqual(searchOnly.tools.map((tool) => tool.name), ['chat__search', 'chat__recent'])
  assert.doesNotMatch(searchOnly.instructions(), /memory__save/)
})

test('memory tools reject unknown names and invalid arguments without touching the database', async () => {
  const runner = createMemoryToolRunner(context, { readMemory: true, editMemory: true, searchChats: true })!
  const unknown = await runner.execute({ call_id: 'c1', name: 'chat__delete', arguments: '{}' })
  assert.equal(unknown.ok, false)
  const badJson = await runner.execute({ call_id: 'c2', name: 'memory__save', arguments: '{oops' })
  assert.match(badJson.error ?? '', /JSON/)
  const badCategory = await runner.execute({
    call_id: 'c3',
    name: 'memory__save',
    arguments: JSON.stringify({ content: '用户常用 R', category: 'hobby' }),
  })
  assert.equal(badCategory.ok, false)
  assert.equal(badCategory.toolId, 'memory.save')
  const badKey = await runner.execute({
    call_id: 'c4',
    name: 'memory__save',
    arguments: JSON.stringify({ content: '用户常用 R', category: 'preference', key: 'Bad Key' }),
  })
  assert.match(badKey.error ?? '', /snake_case/)
})

test('combined runners route calls to their owner and put instructions in order', async () => {
  const runner = (name: string, text: string): ToolRunner => ({
    tools: [{ type: 'function', name, description: name, parameters: {}, strict: false }],
    has: (candidate) => candidate === name,
    label: () => `label:${name}`,
    instructions: () => text,
    execute: async (call) => ({ ok: true, output: JSON.stringify({ ran: call.name }) }),
  })
  assert.equal(combineToolRunners(null, undefined), null)
  const single = runner('a__one', 'A')
  assert.equal(combineToolRunners(null, single), single)

  const combined = combineToolRunners(runner('a__one', 'A'), runner('b__two', 'B'))!
  assert.deepEqual(combined.tools.map((tool) => tool.name), ['a__one', 'b__two'])
  assert.equal(combined.instructions(), 'A\n\nB')
  assert.equal(combined.label('b__two'), 'label:b__two')
  assert.equal((await combined.execute({ call_id: 'x', name: 'b__two', arguments: '' })).output, '{"ran":"b__two"}')
  assert.equal((await combined.execute({ call_id: 'y', name: 'c__three', arguments: '' })).ok, false)
})
