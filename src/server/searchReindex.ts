/**
 * Indexes completed turns that have no chunk, or whose vector came from a
 * different embedding model (run after changing EMBEDDING_MODEL).
 *
 *   npm run search:reindex
 */
import 'dotenv/config'
import { and, eq, isNull, ne, or } from 'drizzle-orm'

import { indexChatTurn } from './chatSearch.js'
import { readConfig } from './config.js'
import { closeDatabase, createDatabase } from './db.js'
import { chats, messageChunks, messages } from './db/schema.js'
import { createEmbedder } from './embeddings.js'

const config = readConfig()
const database = createDatabase(config.databaseUrl)
const embedder = createEmbedder(config)
if (!embedder) {
  console.log('CHAT_SEARCH_ENABLED is false; nothing to index')
  process.exit(0)
}

let indexed = 0
let failed = 0
try {
  for (;;) {
    const rows = await database
      .select({ id: messages.id, userId: messages.userId, chatId: messages.chatId })
      .from(messages)
      .innerJoin(chats, eq(chats.id, messages.chatId))
      .leftJoin(messageChunks, eq(messageChunks.assistantMessageId, messages.id))
      .where(and(
        eq(messages.role, 'assistant'),
        eq(messages.status, 'completed'),
        isNull(chats.deletedAt),
        or(
          isNull(messageChunks.id),
          isNull(messageChunks.embeddingModel),
          ne(messageChunks.embeddingModel, embedder.model),
        ),
      ))
      // Turns that failed in this run stay unindexed; skip past them.
      .limit(100)
      .offset(failed)
    if (rows.length === 0) break
    for (const row of rows) {
      try {
        // A stale vector is cleared first so the chunk is embedded again.
        await database
          .update(messageChunks)
          .set({ embedding: null, embeddingModel: null })
          .where(and(eq(messageChunks.assistantMessageId, row.id), ne(messageChunks.embeddingModel, embedder.model)))
        await indexChatTurn(database, embedder, { userId: row.userId, chatId: row.chatId, assistantMessageId: row.id })
        indexed += 1
      } catch (error) {
        failed += 1
        console.warn('Indexing failed', { messageId: row.id, error: error instanceof Error ? error.message : String(error) })
      }
    }
    console.log(`Indexed ${indexed} turns${failed ? `, ${failed} failed` : ''}`)
  }
} finally {
  await closeDatabase(database)
}
console.log(`Done: ${indexed} turns indexed, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
