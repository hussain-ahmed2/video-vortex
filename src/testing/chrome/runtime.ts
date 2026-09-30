// Fakes `chrome.runtime`: the message registry, the broadcast, and `lastError`.
//
// `sendMessage` rejects with Chrome's own wording when nothing is listening,
// which is the case the worker has to swallow: a broadcast with no popup open is
// normal, not an error.

import { deliver, NO_RECEIVING_END, splitCallback } from './dual'
import type { FakeCallback, FakeEvent, FakeRuntime, MessageListener } from './types'

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

export function createFakeRuntime(): FakeRuntime {
  const onMessage = createEvent<MessageListener>()

  const runtime: FakeRuntime = {
    lastError: undefined,
    onMessage,

    sendMessage(...args: unknown[]): unknown {
      const { callback, rest } = splitCallback(args)
      const message = rest[0]

      // Chrome scopes `lastError` to the call that failed, so a previous failure
      // must not leak into this one. Without this, production code checking
      // `if (chrome.runtime.lastError)` after a successful send would branch on a
      // phantom error.
      runtime.lastError = undefined

      if (onMessage.listeners.size === 0) {
        runtime.lastError = { message: NO_RECEIVING_END }
        if (callback) {
          callback(undefined as never)
          return undefined
        }
        return Promise.reject(new Error(NO_RECEIVING_END))
      }

      // Chrome answers with the first listener that responds, and keeps the
      // channel open only when that listener returned true.
      let answered = false
      let response: unknown
      for (const listener of onMessage.listeners) {
        response = undefined
        const keptOpen = listener(message, {}, (value?: unknown) => {
          response = value
        })
        if (response !== undefined) {
          answered = true
          if (keptOpen === true) break
        }
      }

      return deliver(answered ? response : undefined, callback)
    },
  }

  return runtime
}
