import { describe, expect, it } from 'vitest'

import {
  AssemblePageSchema,
  capWouldBeCrossed,
  PAGE_CHANNEL_SOURCE,
  PAGE_STREAM_BYTE_CAP,
  PageStreamSchema,
  parseHookCommand,
  parseHookReport,
  type PageStream,
} from './page-channel'
import type { StreamSignals } from './types'

// The page channel is the only interface the page hook has, and the page is the one
// sender on this extension that is not us. So these tests are about what the parser
// refuses, not only about what it accepts: a shape that parses is one the content script
// will act on.

function signals(overrides: Partial<StreamSignals> = {}): StreamSignals {
  return {
    streamId: 1,
    origin: 'mse',
    bytes: 2048,
    bufferedBytes: 2048,
    live: false,
    encrypted: false,
    ended: false,
    partialReason: 'none',
    mediaElementName: null,
    ...overrides,
  }
}

function stream(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...signals(), mimeType: 'video/mp4; codecs="avc1.42E01E"', ...overrides }
}

/**
 * The streams inside a parsed report, or null when the message was not one.
 *
 * Narrowed in here rather than at each call site, so each test can say what it is about
 * without four lines of narrowing in front of it.
 */
function streamsIn(data: unknown): PageStream[] | null {
  const parsed = parseHookReport(data)
  return parsed?.type === 'streams' ? parsed.streams : null
}

describe('a stream observation', () => {
  it('carries the engine signals plus the one raw string a container is named from', () => {
    const parsed = PageStreamSchema.safeParse(stream())
    expect(parsed.success).toBe(true)
    expect(parsed.data?.mimeType).toBe('video/mp4; codecs="avc1.42E01E"')
  })

  it('refuses a byte count that is not finite, because a whole record goes with it', () => {
    // The same rule the entry schema follows: a record that fails is discarded rather
    // than repaired, so one unrepresentable number would throw away a tab's whole list.
    expect(PageStreamSchema.safeParse(stream({ bytes: Number.NaN })).success).toBe(false)
    expect(PageStreamSchema.safeParse(stream({ bytes: Number.POSITIVE_INFINITY })).success).toBe(
      false
    )
  })

  it('refuses a negative byte count and a fractional stream id', () => {
    expect(PageStreamSchema.safeParse(stream({ bytes: -1 })).success).toBe(false)
    expect(PageStreamSchema.safeParse(stream({ streamId: 1.5 })).success).toBe(false)
  })

  it('refuses an origin it does not model, so a fourth mechanism cannot arrive unnamed', () => {
    expect(PageStreamSchema.safeParse(stream({ origin: 'websocket' })).success).toBe(false)
  })

  it('refuses a partial reason outside the three causes it can latch', () => {
    expect(PageStreamSchema.safeParse(stream({ partialReason: 'full' })).success).toBe(false)
  })
})

describe('the hook report', () => {
  const report = (overrides: Record<string, unknown> = {}) => ({
    source: PAGE_CHANNEL_SOURCE,
    type: 'streams',
    token: 'token-1',
    pageUrl: 'https://example.com/watch',
    streams: [stream()],
    ...overrides,
  })

  it('parses a snapshot carrying one stream', () => {
    expect(streamsIn(report())).toHaveLength(1)
  })

  it('parses an empty snapshot, because a page that holds nothing still has to say so', () => {
    expect(streamsIn(report({ streams: [] }))).toEqual([])
  })

  it('parses the assembly answer, which is how the row returns to its control', () => {
    const parsed = parseHookReport({
      source: PAGE_CHANNEL_SOURCE,
      type: 'assembled',
      token: 'token-1',
      streamId: 1,
      ok: false,
      error: 'already_running',
    })
    expect(parsed?.type).toBe('assembled')
  })

  it('refuses an answer with a failure it does not model', () => {
    const parsed = parseHookReport({
      source: PAGE_CHANNEL_SOURCE,
      type: 'assembled',
      token: 'token-1',
      streamId: 1,
      ok: false,
      error: 'the_page_said_no',
    })
    expect(parsed).toBeNull()
  })

  it('refuses a report with no token, because an untraceable one is not evidence', () => {
    expect(parseHookReport(report({ token: '' }))).toBeNull()
  })

  it('refuses a report whose source is another script on the page', () => {
    expect(parseHookReport(report({ source: 'some-other-extension' }))).toBeNull()
  })

  it('refuses a stream that fails inside an otherwise good snapshot', () => {
    // The whole snapshot is refused rather than the one bad stream dropped: a snapshot
    // that is missing an entry is a claim that the stream is gone, and half a snapshot
    // would delete a live row.
    expect(parseHookReport(report({ streams: [stream(), stream({ bytes: -5 })] }))).toBeNull()
  })

  it('ignores the page own postMessage traffic', () => {
    expect(parseHookReport({ type: 'webpackHotUpdate', data: [1, 2, 3] })).toBeNull()
    expect(parseHookReport(undefined)).toBeNull()
    expect(parseHookReport('a string')).toBeNull()
  })

  it('refuses a command, because this parser is the page to worker direction only', () => {
    expect(
      parseHookReport({
        source: PAGE_CHANNEL_SOURCE,
        type: 'assemble',
        token: 'token-1',
        streamId: 1,
      })
    ).toBeNull()
  })
})

describe('the commands the hook accepts', () => {
  it('parses the install that carries the token and the page url', () => {
    const parsed = parseHookCommand({
      source: PAGE_CHANNEL_SOURCE,
      type: 'install',
      token: 'token-1',
      pageUrl: 'https://example.com/watch?v=2',
    })
    expect(parsed?.type).toBe('install')
  })

  it('parses an assembly request with a name and one without', () => {
    // Both have to parse. The worker always sends a name, but one schema parses at both
    // hops, and a schema that required the field would refuse the popup's own message.
    expect(
      parseHookCommand({
        source: PAGE_CHANNEL_SOURCE,
        type: 'assemble',
        token: 'token-1',
        streamId: 3,
        filename: 'Documentary_Stream.mp4',
      })
    ).not.toBeNull()

    expect(
      parseHookCommand({
        source: PAGE_CHANNEL_SOURCE,
        type: 'assemble',
        token: 'token-1',
        streamId: 3,
      })
    ).not.toBeNull()
  })

  it('refuses an assembly request for a stream id that is not one', () => {
    expect(
      parseHookCommand({
        source: PAGE_CHANNEL_SOURCE,
        type: 'assemble',
        token: 'token-1',
        streamId: -1,
      })
    ).toBeNull()
  })

  it('refuses a report, because this parser is the worker to page direction only', () => {
    expect(
      parseHookCommand({
        source: PAGE_CHANNEL_SOURCE,
        type: 'streams',
        token: 'token-1',
        pageUrl: 'https://example.com/watch',
        streams: [],
      })
    ).toBeNull()
  })
})

describe('the filename the relay passes through', () => {
  it('survives a parse, so the page is handed the name the engine built', () => {
    // The whole reason `filename` is on the schema at all: zod strips a field the schema
    // does not declare, and the page would be given a file called nothing.
    const parsed = AssemblePageSchema.parse({
      source: PAGE_CHANNEL_SOURCE,
      type: 'assemble',
      token: 'token-1',
      streamId: 1,
      filename: 'Documentary_Stream.mp4',
    })
    expect(parsed.filename).toBe('Documentary_Stream.mp4')
  })
})
describe('the page wide byte cap', () => {
  it('is the number the copy table promises', () => {
    expect(PAGE_STREAM_BYTE_CAP).toBe(512 * 1024 * 1024)
  })

  it('lets a chunk through while there is room for it', () => {
    expect(capWouldBeCrossed(0, 1024)).toBe(false)
    expect(capWouldBeCrossed(PAGE_STREAM_BYTE_CAP - 2048, 1024)).toBe(false)
  })

  it('counts a chunk that lands exactly on the cap as crossing it', () => {
    // A cap is a line, and a chunk that takes the whole budget has taken it, so the next
    // one is the first that is refused rather than one that is quietly allowed past.
    expect(capWouldBeCrossed(0, PAGE_STREAM_BYTE_CAP)).toBe(true)
    expect(capWouldBeCrossed(PAGE_STREAM_BYTE_CAP - 1024, 1024)).toBe(true)
  })

  it('refuses a chunk once the page is already over the cap', () => {
    // Only reachable if a page got over the line some other way, and the answer still has
    // to be yes rather than an arithmetic accident.
    expect(capWouldBeCrossed(PAGE_STREAM_BYTE_CAP + 1, 0)).toBe(true)
  })

  it('takes the cap as an argument, so the rule is provable at any boundary', () => {
    expect(capWouldBeCrossed(90, 10, 100)).toBe(true)
    expect(capWouldBeCrossed(90, 9, 100)).toBe(false)
  })
})
