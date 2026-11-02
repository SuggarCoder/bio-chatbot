import { and, eq, lte, sql } from 'drizzle-orm'

import type { DatabaseTransaction } from './backgroundJobs.js'
import type { Database } from './db/client.js'
import { userMemories, type UserMemoryCategory } from './db/schema.js'

/**
 * How long each kind of memory lives, modelled on claude.ai's memory: a
 * durable profile that is updated in place, a "top of mind" layer that
 * follows what the user is working on now, and a short conversation history
 * that fades while the full chats stay searchable.
 *
 * | tier    | categories                           | lifetime                                   |
 * |---------|--------------------------------------|--------------------------------------------|
 * | profile | identity, work, preference, other    | until contradicted, forgotten or its chat  |
 * |         |                                      | is deleted; rewritten by consolidation     |
 * | recent  | current                              | RECENT_TTL_DAYS after it was last seen;    |
 * |         |                                      | promoted to work once it keeps coming back |
 * | episode | episode (one digest per chat)        | injected for EPISODE_INJECT_DAYS, deleted  |
 * |         |                                      | after EPISODE_TTL_DAYS                     |
 */
export const MEMORY_POLICY = {
  /** A recent-focus memory nobody mentions for this long is dropped. */
  recentTtlDays: 30,
  /** A conversation digest is kept this long after the chat was last active. */
  episodeTtlDays: 60,
  /** Only digests of chats active this recently are injected. */
  episodeInjectDays: 14,
  /** At most this many digests are injected, newest first. */
  episodeInjectMax: 5,
  /** A recent-focus memory confirmed by this many chats ... */
  promoteMinReinforcements: 3,
  /** ... over at least this many days becomes a long-term work memory. */
  promoteMinAgeDays: 14,
} as const

export type MemoryTier = 'profile' | 'recent' | 'episode'

export function memoryTier(category: UserMemoryCategory): MemoryTier {
  if (category === 'current') return 'recent'
  if (category === 'episode') return 'episode'
  return 'profile'
}

export function memoryTtlDays(category: UserMemoryCategory): number | null {
  const tier = memoryTier(category)
  if (tier === 'recent') return MEMORY_POLICY.recentTtlDays
  if (tier === 'episode') return MEMORY_POLICY.episodeTtlDays
  return null
}

/** Expiry for a memory last seen at `lastSeenAt`; null means it never ages out. */
export function memoryExpiresAt(category: UserMemoryCategory, lastSeenAt: Date): Date | null {
  const days = memoryTtlDays(category)
  return days === null ? null : new Date(lastSeenAt.getTime() + days * 86_400_000)
}

/** The same rule in SQL, for a row being confirmed now. */
export const expiresAtFromNow = sql`case ${userMemories.category}
  when 'current' then now() + make_interval(days => ${MEMORY_POLICY.recentTtlDays})
  when 'episode' then now() + make_interval(days => ${MEMORY_POLICY.episodeTtlDays})
  else null end`

/** The digest of one chat lives under a key derived from the chat id. */
export function episodeKey(chatId: string): string {
  return `episode_${chatId.replaceAll('-', '').slice(0, 24)}`
}

/** Not expired, for queries that read memories. */
export const memoryIsLive = sql`(${userMemories.expiresAt} is null or ${userMemories.expiresAt} > now())`

/**
 * Recent focus that keeps coming back across chats is part of the user's
 * long-term work; it moves to the profile tier and stops aging.
 */
export async function promoteRecurringMemories(
  executor: Database | DatabaseTransaction,
  userId: string,
): Promise<number> {
  const rows = await executor
    .update(userMemories)
    .set({ category: 'work', expiresAt: null })
    .where(and(
      eq(userMemories.userId, userId),
      eq(userMemories.category, 'current'),
      sql`${userMemories.reinforcedCount} >= ${MEMORY_POLICY.promoteMinReinforcements}`,
      lte(userMemories.createdAt, sql`now() - make_interval(days => ${MEMORY_POLICY.promoteMinAgeDays})`),
      memoryIsLive,
    ))
    .returning({ key: userMemories.key })
  return rows.length
}

/** Deletes aged-out memories of every user; reads already ignore them. */
export async function purgeExpiredMemories(database: Database): Promise<number> {
  const rows = await database
    .delete(userMemories)
    .where(lte(userMemories.expiresAt, sql`now()`))
    .returning({ key: userMemories.key })
  return rows.length
}
