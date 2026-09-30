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

/** Chrome's callback shape. Never invoked by hand, only by a fake. */
export type FakeCallback = (...args: never[]) => void

export type MessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response?: unknown) => void
) => boolean | undefined

/**
 * The add/remove/has shape every `chrome.*` event object has.
 *
 * `fire` is the one test side member, and it is why the fake's event type is not
 * simply the browser's: Chrome fires these itself, while a fake has to be told,
 * so a test needs a way to trigger the event at all.
 */
export interface FakeEvent<L extends FakeCallback> {
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
  /** Whether a content script is listening, as the real API sees it. */
  setContentScriptListening(listening: boolean): void
}

export interface FakeTabsWithControl extends FakeTabs {
  control: FakeTabsControl
}

export interface FakeRuntime {
  lastError: { message: string } | undefined
  onMessage: FakeEvent<MessageListener>
  sendMessage(message: unknown, callback?: FakeCallback): unknown
}

export interface FakeChrome {
  storage: FakeStorage
  runtime: FakeRuntime
  downloads: FakeDownloads
  tabs: FakeTabsWithControl
}
