// Fakes `chrome.downloads`: real download items a test can drive through their
// states, which is what makes a progress bar testable at all.
//
// State changes only happen when a test calls `control.setState`, so a test never
// has to wait on a real download to finish.

import { deliver, splitCallback } from './dual'
import type {
  FakeCallback,
  FakeDownloadItem,
  FakeDownloads,
  FakeDownloadsControl,
  FakeEvent,
} from './types'

interface StateDeltaListener {
  (delta: {
    id: number
    state?: { current: string }
    bytesReceived?: { current: number }
    totalBytes?: { current: number }
    error?: { current: string }
  }): void
}

function createEvent<L extends FakeCallback>(): FakeEvent<L> & { listeners: Set<L> } {
  const listeners = new Set<L>()
  return {
    listeners,
    addListener(listener: L) {
      listeners.add(listener)
    },
    removeListener(listener: L) {
      listeners.delete(listener)
    },
    hasListener(listener: L) {
      return listeners.has(listener)
    },
    fire(...args: Parameters<L>) {
      listeners.forEach((listener) => listener(...args))
    },
  }
}

export function createFakeDownloads(): FakeDownloads {
  const items = new Map<number, FakeDownloadItem>()
  const onChanged = createEvent<StateDeltaListener>()
  let nextId = 1

  const control: FakeDownloadsControl = {
    setState(id, patch) {
      const item = items.get(id)
      if (!item) return
      Object.assign(item, patch)
      onChanged.fire({
        id,
        state: patch.state ? { current: patch.state } : undefined,
        bytesReceived: patch.bytesReceived ? { current: patch.bytesReceived } : undefined,
        totalBytes: patch.totalBytes ? { current: patch.totalBytes } : undefined,
        error: patch.error ? { current: patch.error } : undefined,
      })
    },
  }

  const downloads: FakeDownloads = {
    control,
    onChanged,

    download(...args: unknown[]): unknown {
      const { callback, rest } = splitCallback(args)
      const options = (rest[0] ?? {}) as { url?: string; filename?: string }
      const id = nextId++
      items.set(id, {
        id,
        url: options.url ?? '',
        filename: options.filename ?? '',
        state: 'in_progress',
        bytesReceived: 0,
        totalBytes: -1,
      })
      return deliver(id, callback)
    },

    search(...args: unknown[]): unknown {
      const { callback, rest } = splitCallback(args)
      const query = (rest[0] ?? {}) as { id?: number; url?: string }
      const found = [...items.values()].filter(
        (item) =>
          (query.id === undefined || item.id === query.id) &&
          (query.url === undefined || item.url === query.url)
      )
      return deliver(found, callback)
    },
  }

  return downloads
}
