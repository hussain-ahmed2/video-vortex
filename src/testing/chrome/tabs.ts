// Fakes `chrome.tabs`: tab lookups plus the two ways a message can fail.
//
// `sendMessage` rejects when no content script is listening, which is how the
// engine's "this page cannot be read" path gets exercised.

import { deliver, NO_RECEIVING_END, splitCallback } from './dual'
import type {
  FakeCallback,
  FakeErrorChannel,
  FakeEvent,
  FakeTab,
  FakeTabsWithControl,
} from './types'

/** Lets the factory be built and used on its own, with nothing to report to. */
const NO_ERRORS: FakeErrorChannel = { clear: () => {}, report: () => {} }

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

export function createFakeTabs(
  initial: FakeTab[] = [],
  errors: FakeErrorChannel = NO_ERRORS
): FakeTabsWithControl {
  const tabs = new Map<number, FakeTab>()
  for (const tab of initial) {
    if (tab.id !== undefined) tabs.set(tab.id, tab)
  }
  const onRemoved = createEvent<(tabId: number) => void>()
  let contentScriptListening = true

  const tabsApi: FakeTabsWithControl = {
    onRemoved,
    control: {
      setTab(tab) {
        if (tab.id !== undefined) tabs.set(tab.id, tab)
      },
      setContentScriptListening(listening) {
        contentScriptListening = listening
      },
    },

    get(...args: unknown[]): unknown {
      const { callback, rest } = splitCallback(args)
      const found = tabs.get(rest[0] as number)
      return deliver(found, callback)
    },

    query(...args: unknown[]): unknown {
      const { callback, rest } = splitCallback(args)
      const info = (rest[0] ?? {}) as { active?: boolean }
      let found = [...tabs.values()]
      if (info.active) found = found.filter((tab) => tab.id !== undefined)
      return deliver(found, callback)
    },

    sendMessage(...args: unknown[]): unknown {
      const { callback } = splitCallback(args)
      // Chrome reports a missing content script through `runtime.lastError`, so
      // the fake has to do the same or a test would take the success branch while
      // the real code takes the error branch.
      errors.clear()
      if (!contentScriptListening) {
        errors.report(NO_RECEIVING_END)
        if (callback) {
          callback(undefined as never)
          return undefined
        }
        return Promise.reject(new Error(NO_RECEIVING_END))
      }
      return deliver(undefined, callback)
    },
  }

  return tabsApi
}
