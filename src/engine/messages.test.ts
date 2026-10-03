import { describe, expect, it } from 'vitest'

import { CONTRACT_VERSION } from './types'
import {
  DownloadMediaRequestSchema,
  EntriesReportedRequestSchema,
  GetTabMediaRequestSchema,
  parseMessage,
  request,
  StreamAssembleRequestSchema,
  StreamAssembleResponseSchema,
  TabMediaUpdatedMessageSchema,
  totalBytesOrNull,
} from './messages'

// Spec 0004 AC-5: every message that crosses a runtime boundary is one of the five
// named in `messages.ts`, is parsed before use, and every request carries the contract
// version. A schema nobody parses is decoration, so each one is proved to bite by
// handing it a payload that is wrong in a specific way.

function report(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    contractVersion: CONTRACT_VERSION,
    pageUrl: 'https://example.com/watch',
    pageTitle: 'Documentary Stream',
    status: 'ready',
    entries: [],
    ...overrides,
  }
}

describe('the report the content script sends', () => {
  it('accepts a title only report, which is all this slice sends', () => {
    expect(EntriesReportedRequestSchema.safeParse(report()).success).toBe(true)
  })

  it('rejects a report from a build whose contract version differs', () => {
    // The one case the version check can actually fire: a page left running a
    // content script from the build before an extension reload.
    const parsed = EntriesReportedRequestSchema.safeParse(
      report({ contractVersion: CONTRACT_VERSION + 1 })
    )

    expect(parsed.success).toBe(false)
  })

  it('rejects a report that names a status the engine does not define', () => {
    expect(EntriesReportedRequestSchema.safeParse(report({ status: 'blocked-by-nobody' })).success).toBe(
      false
    )
  })

  it('rejects an entry with no kind, because the two popup lists are built on it', () => {
    const parsed = EntriesReportedRequestSchema.safeParse(
      report({
        entries: [{ url: 'https://example.com/a.mp4', container: 'mp4', quality: 'unknown' }],
      })
    )

    expect(parsed.success).toBe(false)
  })
})

describe('the popup requests', () => {
  it('stamps the contract version so no call site can forget it', () => {
    expect(request('GET_TAB_MEDIA', { tabId: 3 }).payload.contractVersion).toBe(CONTRACT_VERSION)
  })

  it('reads a tab id of zero, which is a real tab id and not a missing one', () => {
    expect(GetTabMediaRequestSchema.safeParse(request('GET_TAB_MEDIA', { tabId: 0 }).payload).success).toBe(
      true
    )
  })

  it('takes a download by url and never by a file name', () => {
    // The worker derives the name, so the popup cannot disagree with it about what a
    // file is called.
    const payload = request('DOWNLOAD_MEDIA', { url: 'https://example.com/a.mp4' }).payload

    expect(DownloadMediaRequestSchema.safeParse(payload).success).toBe(true)
    expect(Object.keys(payload)).not.toContain('filename')
  })
})

describe('parsing a message that arrived from another runtime', () => {
  it('accepts each of the five and reports which one it was', () => {
    const names = [
      ['ENTRIES_REPORTED', report()],
      ['GET_TAB_MEDIA', request('GET_TAB_MEDIA', { tabId: 1 }).payload],
      ['TAB_MEDIA_UPDATED', { tabId: 1 }],
      ['DOWNLOAD_MEDIA', request('DOWNLOAD_MEDIA', { url: 'https://example.com/a.mp4' }).payload],
      [
        'DOWNLOAD_PROGRESS',
        { downloadId: 1, url: 'u', bytesReceived: 0, totalBytes: null, state: 'in_progress' },
      ],
    ] as const

    for (const [name, payload] of names) {
      expect(parseMessage({ name, payload })?.name).toBe(name)
    }
  })

  it('drops an unrecognised name rather than guessing', () => {
    expect(parseMessage({ name: 'FETCH_YOUTUBE_DATA', payload: {} })).toBeNull()
  })

  it('drops a payload that fails its schema', () => {
    expect(parseMessage({ name: 'DOWNLOAD_PROGRESS', payload: { downloadId: 1 } })).toBeNull()
  })

  it('drops a request whose contract version does not match', () => {
    const payload = { ...request('GET_TAB_MEDIA', { tabId: 1 }).payload, contractVersion: 99 }

    expect(parseMessage({ name: 'GET_TAB_MEDIA', payload })).toBeNull()
  })

  it('drops anything that is not an object at all', () => {
    expect(parseMessage(undefined)).toBeNull()
    expect(parseMessage('GET_TAB_MEDIA')).toBeNull()
  })

  it('lets a broadcast through without a version, because the popup is not a requester', () => {
    // A version check on a broadcast would stop an open popup ever hearing about an
    // update, which is the opposite of what a version check is for.
    expect(TabMediaUpdatedMessageSchema.safeParse({ tabId: 4 }).success).toBe(true)
  })
})

describe('the total a download reports', () => {
  it('maps Chrome minus one to null, so nothing downstream reads the sentinel', () => {
    expect(totalBytesOrNull(-1)).toBeNull()
  })

  it('leaves a real total alone', () => {
    expect(totalBytesOrNull(1024)).toBe(1024)
  })
})

describe('the assembly request, which has two hops under one name', () => {
  const URL_UNDER_TEST = 'vortex-stream:https%3A%2F%2Fexample%2Ecom%2Fwatch#1'

  // covers: AC-17
  it('parses the popup hop, which sends a url and no name', () => {
    const parsed = parseMessage(request('STREAM_ASSEMBLE', { url: URL_UNDER_TEST }))
    expect(parsed?.name).toBe('STREAM_ASSEMBLE')
  })

  // covers: AC-17
  it('carries a name the worker added on the way through', () => {
    // The load bearing part of one schema serving both hops: if the field were
    // required the popup could not send the first message, and if the schema did not
    // declare it zod would strip it here and the page would be handed a nameless file.
    const parsed = StreamAssembleRequestSchema.safeParse({
      contractVersion: CONTRACT_VERSION,
      url: URL_UNDER_TEST,
      filename: 'Documentary Stream.mp4',
    })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.filename).toBe('Documentary Stream.mp4')
  })

  // covers: AC-17
  it('keeps the name through a parse and revalidation, rather than dropping it as unknown', () => {
    const forwarded = {
      contractVersion: CONTRACT_VERSION,
      url: URL_UNDER_TEST,
      filename: 'Documentary Stream.mp4',
    }
    expect(StreamAssembleRequestSchema.parse(StreamAssembleRequestSchema.parse(forwarded))).toEqual(
      forwarded
    )
  })

  // covers: AC-17
  it('refuses a request from a build whose contract version differs', () => {
    expect(
      parseMessage({
        name: 'STREAM_ASSEMBLE',
        payload: { contractVersion: CONTRACT_VERSION + 1, url: URL_UNDER_TEST },
      })
    ).toBeNull()
  })

  // covers: AC-17
  it('refuses a request with no url, since there is nothing to assemble', () => {
    expect(
      parseMessage({ name: 'STREAM_ASSEMBLE', payload: { contractVersion: CONTRACT_VERSION } })
    ).toBeNull()
  })

  // covers: AC-2
  it('refuses a name this extension has never written', () => {
    expect(parseMessage({ name: 'STREAM_ASSEMBLE_V2', payload: {} })).toBeNull()
  })

  // covers: AC-10, AC-12
  it.each(['not_listed', 'already_running', 'no_bytes', 'page_refused'] as const)(
    'accepts %s as a refusal a row can explain',
    (error) => {
      expect(StreamAssembleResponseSchema.safeParse({ ok: false, error }).success).toBe(true)
    }
  )

  // covers: AC-10, AC-12
  it('refuses a refusal it has no sentence for, rather than storing one', () => {
    expect(StreamAssembleResponseSchema.safeParse({ ok: false, error: 'mystery' }).success).toBe(
      false
    )
  })

  // covers: AC-11
  it('accepts a success carrying no error', () => {
    expect(StreamAssembleResponseSchema.safeParse({ ok: true }).success).toBe(true)
  })
})
