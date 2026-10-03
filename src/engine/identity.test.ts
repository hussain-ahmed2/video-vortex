import { describe, expect, it } from 'vitest'

import {
  entryKey,
  FALLBACK_EXTRACTOR_ID,
  FALLBACK_EXTRACTOR_REASON,
  isSameEntry,
  isStreamUrl,
  STREAM_EXTRACTOR_ID,
  STREAM_EXTRACTOR_REASON,
  STREAM_URL_SCHEME,
  streamEntryUrl,
  streamIdFromUrl,
} from './identity'
import { containerFromPath } from './media-rules'

// What makes two findings the same file. Two finders naming one file must produce one
// row, and the `unknown` exception is the part that is easy to get wrong: without it a
// file first seen on a response that named no type is listed twice, and every
// re-request of it grows the count.

function finding(overrides: Partial<Parameters<typeof isSameEntry>[0]> = {}) {
  return {
    url: 'https://cdn.example.com/a.mp4',
    container: 'mp4',
    quality: 'unknown',
    ...overrides,
  }
}

describe('two findings of the same file', () => {
  it('are one entry when url, container and quality all match', () => {
    expect(isSameEntry(finding(), finding())).toBe(true)
  })

  it('are two entries when the container differs and neither is unknown', () => {
    expect(isSameEntry(finding({ container: 'mp4' }), finding({ container: 'webm' }))).toBe(false)
  })

  it('are two entries when the url differs', () => {
    expect(isSameEntry(finding(), finding({ url: 'https://cdn.example.com/b.mp4' }))).toBe(false)
  })

  it('are two entries when the quality differs', () => {
    expect(isSameEntry(finding({ quality: '720p' }), finding({ quality: '1080p' }))).toBe(false)
  })

  it('are one entry when one of them named no container', () => {
    // The exception the identity rule exists for: a file first seen on a response that
    // named no type and again on one that did is one file, not two rows.
    expect(isSameEntry(finding({ container: 'unknown' }), finding({ container: 'mp4' }))).toBe(true)
    expect(isSameEntry(finding({ container: 'mp4' }), finding({ container: 'unknown' }))).toBe(true)
  })

  it('compare equal to themselves when both are unknown', () => {
    expect(isSameEntry(finding({ container: 'unknown' }), finding({ container: 'unknown' }))).toBe(true)
  })
})

describe('the key one entry is counted and merged under', () => {
  it('is stable for the same finding', () => {
    expect(entryKey(finding())).toBe(entryKey(finding()))
  })

  it('differs when any part of the identity differs', () => {
    expect(entryKey(finding({ url: 'https://cdn.example.com/b.mp4' }))).not.toBe(
      entryKey(finding())
    )
  })
})

describe('the fallback extractor naming itself', () => {
  it('reports one id and one reason, both constants', () => {
    // `lastWriter` and `sources` carry the id, so a findings identity includes the thing
    // that named it.
    expect(FALLBACK_EXTRACTOR_ID).toBe('network-response')
    expect(FALLBACK_EXTRACTOR_REASON).toBe('network response')
  })
})

describe('the url a stream is listed under', () => {
  // covers: AC-3, AC-5
  it('names the page and the stream id', () => {
    expect(streamEntryUrl('https://example.com/watch', 4)).toBe(
      'vortex-stream:https%3A%2F%2Fexample%2Ecom%2Fwatch#4'
    )
  })

  it('gives two streams on one page two urls', () => {
    expect(streamEntryUrl('https://example.com/watch', 1)).not.toBe(
      streamEntryUrl('https://example.com/watch', 2)
    )
  })

  it('gives one stream on two pages two urls', () => {
    expect(streamEntryUrl('https://example.com/watch', 1)).not.toBe(
      streamEntryUrl('https://example.com/other', 1)
    )
  })

  it('never ends in something a path rule could read as a container', () => {
    // The load bearing part of the encoding. Left raw, a page at /watch.html would
    // mint a url ending in `.html`, and containerFromPath would rank ours above the
    // content type map and call the row an html file.
    expect(containerFromPath(streamEntryUrl('https://example.com/watch.html', 1))).toBeNull()
    expect(containerFromPath(streamEntryUrl('https://example.com/clip.mp4', 1))).toBeNull()
    expect(containerFromPath(streamEntryUrl('https://example.com/a.b.c', 2))).toBeNull()
  })

  it('keeps the identity tuple unchanged, so a stream is still one entry', () => {
    const url = streamEntryUrl('https://example.com/watch', 3)
    expect(isSameEntry({ url, container: 'mp4', quality: 'unknown' }, { url, container: 'mp4', quality: 'unknown' })).toBe(true)
  })

  it('recognises its own scheme and nothing else', () => {
    expect(isStreamUrl(streamEntryUrl('https://example.com/watch', 1))).toBe(true)
    expect(isStreamUrl('https://cdn.example.com/a.mp4')).toBe(false)
    expect(isStreamUrl('blob:https://example.com/6f0a')).toBe(false)
  })
})

describe('the two finders that name a finding', () => {
  it('gives the page hook its own id, distinct from the network fallback', () => {
    // Distinct because a row's `sources` is how a person or the diagnostics view tells a
    // sniffed file from a stream the page assembled, and one id for both would erase
    // that difference rather than record it.
    expect(STREAM_EXTRACTOR_ID).not.toBe(FALLBACK_EXTRACTOR_ID)
    expect(STREAM_EXTRACTOR_REASON).not.toBe(FALLBACK_EXTRACTOR_REASON)
  })

  it('says what the hook did, in words that are not a response or a scrape', () => {
    expect(STREAM_EXTRACTOR_REASON).toContain('assembled')
  })
})

describe('reading a stream id back out of a minted url', () => {
  it('returns the id the url was minted with', () => {
    expect(streamIdFromUrl(streamEntryUrl('https://example.com/watch', 7))).toBe(7)
    expect(streamIdFromUrl(streamEntryUrl('https://example.com/watch.html', 0))).toBe(0)
  })

  it('returns null for anything that is not one of ours', () => {
    // The worker's download path and the assembly path are told apart by this, so a file
    // url arriving on the wrong one has to be refused rather than read as stream zero.
    expect(streamIdFromUrl('https://cdn.example.com/clip.mp4')).toBeNull()
    expect(streamIdFromUrl('blob:https://example.com/abc')).toBeNull()
    expect(streamIdFromUrl(`${STREAM_URL_SCHEME}no-hash-here`)).toBeNull()
    expect(streamIdFromUrl(`${STREAM_URL_SCHEME}page#-1`)).toBeNull()
    expect(streamIdFromUrl(`${STREAM_URL_SCHEME}page#1.5`)).toBeNull()
  })
})
