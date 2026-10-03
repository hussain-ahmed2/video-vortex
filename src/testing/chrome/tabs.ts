// Fakes `chrome.tabs`: tab lookups, and delivering a message to the content script
// on a tab including the two ways that can fail.
//
// `sendMessage` rejects when no content script is listening, which is how the
// engine's "this page cannot be read" path gets exercised. When one is listening it
// answers through the listener the test named.
//
// That listener has to be named rather than found, and the reason is worth stating. In
// Chrome a tab message reaches the content scripts in that tab and nothing else: not the
// worker's own `runtime.onMessage`, which is why the worker never sees the request it
// forwards, and not another tab's. Every extension context shares one listener registry in
// this fake, so the fake cannot tell a content script's listener from the worker's, and
// delivering to the whole registry would hand the worker its own message back. A test that
// drives the real content script names that one listener; a test standing in for a content
// script does the same.

import { deliver, NO_RECEIVING_END, splitCallback } from './dual'
import type {
  FakeCallback,
  FakeErrorChannel,
  FakeEvent,
  FakeTab,
  FakeTabsWithControl,
  MessageListener,
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
  const sent: { tabId: number; message: unknown }[] = []
  let contentScriptListening = true
  let contentScriptListener: MessageListener | undefined

  const tabsApi: FakeTabsWithControl = {
    onRemoved,
    control: {
      setTab(tab) {
        if (tab.id !== undefined) tabs.set(tab.id, tab)
      },
      setContentScriptListening(listening) {
        contentScriptListening = listening
      },
      setContentScriptListener(listener) {
        contentScriptListener = listener
      },
      sentMessages() {
        return [...sent]
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
      const { callback, rest } = splitCallback(args)
      const tabId = rest[0] as number
      const message = rest[1]
      sent.push({ tabId, message })

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

      // Chrome answers with the first listener that responds and keeps the channel
      // open only when that listener returned true, which is the same rule the
      // runtime fake follows. Mirrored here so a listener written once behaves the
      // same whichever channel it is hung on.
      const listeners: MessageListener[] = []
      if (contentScriptListener) listeners.push(contentScriptListener)

      let answered = false
      let response: unknown
      let resolveHeld: ((value: unknown) => void) | undefined
      const sendResponse = (value?: unknown): void => {
        response = value
        answered = true
        resolveHeld?.(value)
      }

      for (const listener of listeners) {
        response = undefined
        // Chrome puts the target tab on the sender, and the content script reads it: a
        // message sent with `tabs.sendMessage` has one, and a message the popup sent with
        // `runtime.sendMessage` does not. That is the only thing telling the two apart, and
        // getting it wrong would have every content script in every tab relay a message that
        // was addressed to the worker.
        const keptOpen = listener(message, { tab: { id: tabId } }, sendResponse)
        if (answered) {
          if (keptOpen === true) break
          continue
        }
        if (keptOpen === true) {
          // The listener said it will answer later, so the call waits for it rather than
          // resolving with nothing. Chrome keeps the channel open for exactly this long, and
          // a fake that resolved early would answer the worker before the page had been
          // asked, which is the whole of the assembly path.
          if (callback) {
            resolveHeld = (value) => callback(value as never)
            return undefined
          }
          const held = new Promise<unknown>((resolve) => {
            resolveHeld = resolve
          })
          return held
        }
      }

      return deliver(answered ? response : undefined, callback)
    },
  }

  return tabsApi
}
