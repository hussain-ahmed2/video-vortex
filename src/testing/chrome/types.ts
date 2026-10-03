// Own types for the browser API fakes: the narrow surface this extension calls.
//
// The members below are bound to the real browser signatures by one cast per
// namespace, in that namespace's own file. Chrome's overloads (a `get` that is
// both a promise form and three callback forms) cannot be satisfied by a single
// hand written implementation, so signature conformance is not something a fake
// can honestly claim. Signature drift is still caught, by `tsc -b`, because the
// production code that calls these APIs compiles against the same definitions on
// every build. What the fake buys is behaviour: a write is visible to the next
// read, a broadcast to nobody rejects, a failed callback sees `lastError`.

import type { FakeAction } from './action'
import type { FakeScripting } from './scripting'
import type { FakeWebRequest } from './web-request'

/** Chrome's callback shape. Never invoked by hand, only by a fake. */
export type FakeCallback = (...args: never[]) => void

export type MessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response?: unknown) => void
) => boolean | undefined

/**
 * The add/remove/has shape every `chrome.*` event object has, plus the two members a fake
 * needs and the browser does not have.
 *
 * `fire` exists because Chrome fires these events itself while a fake has to be told, so a
 * test needs a way to trigger one at all. `listeners` exists because another fake has to
 * deliver to them: `chrome.tabs.sendMessage` reaches a content script through the very
 * listeners it registered on `runtime.onMessage`, so the tabs fake needs to see them.
 */
export interface FakeEvent<L extends FakeCallback> {
  listeners: Set<L>
  addListener(listener: L): void
  removeListener(listener: L): void
  hasListener(listener: L): boolean
  fire(...args: Parameters<L>): void
}

export interface FakeStorageArea {
  get(keys?: unknown, defaultValue?: unknown): unknown
  set(items: Record<string, unknown>): unknown
  remove(keys: unknown): unknown
  clear(): unknown
}

export interface FakeStorage {
  session: FakeStorageArea
  local: FakeStorageArea
  sync: FakeStorageArea
}

export interface FakeDownloadItem {
  id: number
  url: string
  filename: string
  state: string
  bytesReceived: number
  totalBytes: number
  error?: string
}

/** Test side driver for a download the fake created. Not part of the API. */
export interface FakeDownloadsControl {
  setState(
    id: number,
    patch: Partial<Pick<FakeDownloadItem, 'state' | 'bytesReceived' | 'totalBytes' | 'error'>>
  ): void
}

export interface FakeDownloads {
  download(
    options: { url: string; filename?: string; saveAs?: boolean },
    callback?: FakeCallback
  ): unknown
  search(query: { id?: number; url?: string }, callback?: FakeCallback): unknown
  onChanged: FakeEvent<
    (delta: {
      id: number
      state?: { current: string }
      bytesReceived?: { current: number }
      totalBytes?: { current: number }
      error?: { current: string }
    }) => void
  >
  control: FakeDownloadsControl
}

export interface FakeTab {
  id?: number
  url?: string
  title?: string
}

/**
 * How a namespace fake reports a failed call, so that `runtime.lastError` ends
 * up set the way Chrome sets it. The runtime fake owns that property, and every
 * other namespace reports through this channel rather than holding its own.
 */
export interface FakeErrorChannel {
  /** Called at the start of every call, so a previous failure cannot leak into it. */
  clear(): void
  /** Called when a call fails. */
  report(message: string): void
}

export interface FakeTabs {
  get(tabId: number, callback?: FakeCallback): unknown
  query(info: { active?: boolean; currentWindow?: boolean }, callback?: FakeCallback): unknown
  sendMessage(tabId: number, message: unknown, callback?: FakeCallback): unknown
  onRemoved: FakeEvent<(tabId: number) => void>
}

/** Test side driver for tabs. Not part of the API. */
export interface FakeTabsControl {
  setTab(tab: FakeTab): void
  /**
   * Whether a content script is listening, as the real API sees it.
   *
   * Kept as a separate switch from `setContentScriptListener` because "no content
   * script on this page" and "a content script is there but has not registered a
   * listener" fail the same way to the caller and are worth telling apart in a test.
   */
  setContentScriptListening(listening: boolean): void
  /**
   * The listener a content script on this tab registers.
   *
   * `chrome.tabs.sendMessage` resolves through this rather than always resolving
   * undefined, because the worker's assembly request is answered by the content
   * script and not by anything the worker owns. Without it the only tab message a
   * test could exercise was the failure.
   */
  setContentScriptListener(listener: MessageListener | undefined): void
  /** Every message sent to a tab, in order. */
  sentMessages(): { tabId: number; message: unknown }[]
}

export interface FakeTabsWithControl extends FakeTabs {
  control: FakeTabsControl
}

/** Test side driver for the runtime. Not part of the API. */
export interface FakeRuntimeControl {
  /**
   * Which tab a message sent from a content script appears to come from.
   *
   * Chrome puts the sending tab on `sender.tab`, and the worker needs it: a report from the
   * page is stored against the tab it came from, and a message with no tab behind it is
   * dropped and counted. Without this the only sender a test could produce was an empty one,
   * so no test could ever drive a content script and the worker together.
   */
  setSenderTab(tabId: number | undefined): void
}

export interface FakeRuntime {
  lastError: { message: string } | undefined
  onMessage: FakeEvent<MessageListener>
  sendMessage(message: unknown, callback?: FakeCallback): unknown
  control: FakeRuntimeControl
}

export interface FakeChrome {
  storage: FakeStorage
  runtime: FakeRuntime
  downloads: FakeDownloads
  tabs: FakeTabsWithControl
  action: FakeAction
  webRequest: FakeWebRequest
  scripting: FakeScripting
}
