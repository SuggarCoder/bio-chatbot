/** A small least-recently-used map: reads and writes make an entry the newest. */
export class LruCache<K, V> {
  private readonly entries = new Map<K, V>()

  constructor(readonly limit: number) {}

  get size() {
    return this.entries.size
  }

  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined
    const value = this.entries.get(key) as V
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }

  set(key: K, value: V) {
    this.entries.delete(key)
    this.entries.set(key, value)
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value as K
      this.entries.delete(oldest)
    }
  }

  delete(key: K) {
    return this.entries.delete(key)
  }

  clear() {
    this.entries.clear()
  }
}

/** FNV-1a (32-bit) of a string, for cache keys; callers compare the source on a hit. */
export function hashString(value: string) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

/** Moves `id` to the front of a most-recent-first list. */
export function touchRecent(order: readonly string[], id: string): string[] {
  return [id, ...order.filter((item) => item !== id)]
}

/**
 * Entries beyond the first `keep` of a most-recent-first list that may be
 * evicted now. Pinned entries (`canEvict` false) stay and are reconsidered
 * on the next call.
 */
export function selectEvictions(
  order: readonly string[],
  keep: number,
  canEvict: (id: string) => boolean,
): string[] {
  return order.slice(Math.max(0, keep)).filter(canEvict)
}
