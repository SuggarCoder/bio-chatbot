import assert from 'node:assert/strict'
import test from 'node:test'

import { drizzle } from 'drizzle-orm/node-postgres'

import type { Database } from './db.js'
import * as schema from './db/schema.js'
import { buildBudgetedChatContext } from './conversationMemory.js'
import { CharacterTokenCounter } from './tokenBudget.js'

test('budgeted context supersession filter selects a scalar from its own query', async () => {
  const queries: string[] = []
  const client = {
    async query(config: { text: string }) {
      queries.push(config.text)

      if (config.text.includes('from "Chat"')) {
        return { rows: [[1n]] }
      }

      if (config.text.includes('from "Message"')) {
        return { rows: [[1n, 'user', 'hello']] }
      }

      throw new Error(`Unexpected query: ${config.text}`)
    },
  }
  const database = drizzle(client as never, { schema }) as unknown as Database

  const context = await buildBudgetedChatContext(database, {
    userId: '00000000-0000-0000-0000-000000000001',
    chatId: '00000000-0000-0000-0000-000000000002',
    contextMaxSeq: 1,
    historyTokenBudget: 100,
    summaryTokenBudget: 20,
    tokenCounter: new CharacterTokenCounter(),
  })

  assert.deepEqual(context?.messages, [{ role: 'user', content: 'hello' }])
  assert.match(
    queries[1],
    /not exists \(select 1 from "Generation" "context_original"/,
  )
})
