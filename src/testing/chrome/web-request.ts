// Fakes `chrome.webRequest`: the response observer, which is how the engine sees a
// page's media at all.
//
// A test fires a response rather than making one, so the fields a real event always
// carries are filled in here. That is deliberate: the worker reads `tabId`,
// `statusCode`, `url` and `responseHeaders`, and a fixture that omitted them would
// pass a test the browser would fail.

import type { FakeEvent } from './types'

/** One response header, in the array shape Chrome actually delivers. */
export interface FakeResponseHeader {
  name: string
  value: string
}

/** The subset of a response event the worker reads. */
export interface FakeResponseDetails {
  requestId: string
  url: string
  method: string
  frameId: number
  parentFrameId: number
  documentId: string
  tabId: number
  type: string
  timeStamp: number
  statusCode?: number
  responseHeaders?: FakeResponseHeader[]
  fromCache?: boolean
}

/** What the worker registered, so a test can check the filter it asked for. */
export interface FakeWebRequestRegistration {
  urls: string[] | undefined
  extraInfoSpec: string[] | undefined
}

/**
 * The event, with the two extra arguments `addListener` really takes.
 *
 * The base event type carries only the listener, because that is all the namespaces
 * this harness already faked needed. Response headers are delivered only when
 * `responseHeaders` is in the extra info spec, so a fake that dropped it would let a
 * worker which never asked for them pass.
 */
export interface FakeWebRequestEvent
  extends FakeEvent<(details: FakeResponseDetails) => void> {
  addListener(
    listener: (details: FakeResponseDetails) => void,
    filter?: { urls?: string[]; types?: string[] },
    extraInfoSpec?: string[]
  ): void
}

export interface FakeWebRequestControl {
  /** What the last `addListener` asked for. Null when nothing is listening. */
  registration(): FakeWebRequestRegistration | null
  /**
   * Fires a response event with the boilerplate filled in.
   *
   * The header list is built from `contentType` and `contentLength` because that is
   * how a server states them, so a test is exercising the rule that reads the array
   * rather than its own fixture.
   */
  respond(details: {
    url: string
    tabId: number
    statusCode?: number
    contentType?: string
    contentLength?: string
    contentEncoding?: string
    type?: string
  }): void
}

export interface FakeWebRequest {
  onHeadersReceived: FakeWebRequestEvent
  control: FakeWebRequestControl
}

export function createFakeWebRequest(): FakeWebRequest {
  const listeners = new Set<(details: FakeResponseDetails) => void>()
  let registration: FakeWebRequestRegistration | null = null
  let requestCounter = 0

  const onHeadersReceived: FakeWebRequestEvent = {
    listeners,
    addListener(listener, filter, extraInfoSpec) {
      listeners.add(listener)
      registration = { urls: filter?.urls, extraInfoSpec }
    },
    removeListener(listener) {
      listeners.delete(listener)
    },
    hasListener(listener) {
      return listeners.has(listener)
    },
    fire(details) {
      for (const listener of listeners) listener(details)
    },
  }

  const control: FakeWebRequestControl = {
    registration() {
      return registration
    },

    respond({
      url,
      tabId,
      statusCode = 200,
      contentType,
      contentLength,
      contentEncoding,
      type = 'media',
    }) {
      const responseHeaders: FakeResponseHeader[] = []
      if (contentType) responseHeaders.push({ name: 'Content-Type', value: contentType })
      if (contentLength) responseHeaders.push({ name: 'Content-Length', value: contentLength })
      if (contentEncoding) {
        responseHeaders.push({ name: 'Content-Encoding', value: contentEncoding })
      }

      requestCounter += 1
      onHeadersReceived.fire({
        requestId: `request-${requestCounter}`,
        url,
        method: 'GET',
        frameId: 0,
        parentFrameId: -1,
        documentId: `document-${tabId}`,
        tabId,
        type,
        timeStamp: Date.now(),
        statusCode,
        responseHeaders,
      })
    },
  }

  return { onHeadersReceived, control }
}
