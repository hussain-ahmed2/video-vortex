// Fakes `chrome.storage`: three areas over one in memory map each.
//
// A write is visible to the next read and the stored value comes back by
// reference, with no deep copy, because a test that round trips a record is
// asserting the engine's behaviour rather than the fake's.

import { deliver, splitCallback } from './dual'
import type { FakeStorage, FakeStorageArea } from './types'

function readItems(
  store: Map<string, unknown>,
  keys: unknown,
  defaultValue: unknown
): unknown {
  if (keys === null || keys === undefined) {
    return Object.fromEntries(store)
  }
  if (typeof keys === 'string') {
    return store.has(keys) ? store.get(keys) : defaultValue
  }
  if (Array.isArray(keys)) {
    const found: Record<string, unknown> = {}
    for (const key of keys) {
      found[key] = store.has(key) ? store.get(key) : defaultValue
    }
    return found
  }
  if (typeof keys === 'object') {
    // An object of defaults, merged over what is stored.
    const merged: Record<string, unknown> = { ...(keys as Record<string, unknown>) }
    for (const [key, fallback] of Object.entries(merged)) {
      if (store.has(key)) merged[key] = store.get(key)
      else if (fallback === undefined) merged[key] = defaultValue
    }
    return merged
  }
  return defaultValue
}

function createStorageArea(): FakeStorageArea {
  const store = new Map<string, unknown>()

  const area: FakeStorageArea = {
    get(...args: unknown[]): unknown {
      const { callback, rest } = splitCallback(args)
      return deliver(readItems(store, rest[0], rest[1]), callback)
    },

    set(...args: unknown[]): unknown {
      const { callback, rest } = splitCallback(args)
      const items = (rest[0] ?? {}) as Record<string, unknown>
      for (const [key, value] of Object.entries(items)) store.set(key, value)
      return deliver(undefined, callback)
    },

    remove(...args: unknown[]): unknown {
      const { callback, rest } = splitCallback(args)
      const keys = rest[0]
      if (typeof keys === 'string') store.delete(keys)
      else if (Array.isArray(keys)) for (const key of keys) store.delete(key)
      return deliver(undefined, callback)
    },

    clear(...args: unknown[]): unknown {
      const { callback } = splitCallback(args)
      store.clear()
      return deliver(undefined, callback)
    },
  }

  return area
}

export function createFakeStorage(): FakeStorage {
  return {
    session: createStorageArea(),
    local: createStorageArea(),
    sync: createStorageArea(),
  }
}
