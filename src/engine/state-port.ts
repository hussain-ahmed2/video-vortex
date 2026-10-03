// Owns the four state operations the engine needs and the keys they live under, so
// the engine never calls storage. The worker fills the port with session storage and
// tests fill it with a Map, which is the whole reason the port exists: the merge, the
// cap and the identity rules are then provable with no browser at all.

import type { TabMedia } from './types'

/** One record per tab. The index key below is the only way to enumerate them. */
export function recordKey(tabId: number): string {
  return `vv:tab:${tabId}`
}

/**
 * The live tab ids.
 *
 * Maintained by the worker inside the same storage operation as the record it belongs
 * to, so it cannot drift from the records it lists. Enumerating storage instead would
 * mean reading every record on every read, which is the cost this key exists to avoid.
 */
export const TABS_INDEX_KEY = 'vv:tabs'

export interface StateStore {
  /** Whatever is stored, already validated by the caller. Null when there is none. */
  load(tabId: number): Promise<TabMedia | null>
  save(record: TabMedia): Promise<void>
  /** On tab close, and when a read finds a record whose page the user has left. */
  remove(tabId: number): Promise<void>
  tabs(): Promise<number[]>
}

/**
 * The in memory store the engine's own tests use.
 *
 * Deliberately not a fake: it is the second implementation the port asks for, and it
 * stores values by reference, so a test that round trips a record is asserting the
 * engine's behaviour rather than a fake's copy semantics.
 */
export function createMemoryStateStore(seed: TabMedia[] = []): StateStore {
  const records = new Map<number, TabMedia>()
  for (const record of seed) records.set(record.tabId, record)

  return {
    async load(tabId) {
      return records.get(tabId) ?? null
    },

    async save(record) {
      records.set(record.tabId, record)
    },

    async remove(tabId) {
      records.delete(tabId)
    },

    async tabs() {
      return [...records.keys()]
    },
  }
}
