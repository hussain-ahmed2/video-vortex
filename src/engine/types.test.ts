import { describe, expect, it } from 'vitest'

import {
  MediaEntrySchema,
} from './types'
import {
  containerFromPath,
} from './media-rules'
import {
  isSameEntry,
  isStreamUrl,
  streamEntryUrl,
} from './identity'

// What makes two findings the same file. Two finders naming one file must produce one
// row, and the `unknown` exception is the part that is easy to get wrong: without it a
// file first seen on a response that named no type and again with one is one file, and
// every re-request of it grows the count.

function finding(overrides: Partial<Parameters<typeof isSameEntry>[0]> = {}) {
  return {
    url: 'https://cdn.example.com/a.mp4',
    container: 'mp4',
    quality: 'unknown',
    ...overrides,
  }
}

describe('what makes two findings the same file', () => {
  it('recognises the same url, container and quality as the same file', () => {
    expect(isSameEntry(finding(), finding())).toBe(true)
  })

  it('treats a different url as a different file', () => {
    expect(isSameEntry(finding(), finding({ url: 'https://cdn.example.com/b.mp4' }))).toBe(false)
  })

  it('treats a different container as a different file', () => {
    expect(isSameEntry(finding(), finding({ container: 'webm' }))).toBe(false)
  })

  it('treats a different quality as a different file', () => {
    expect(isSameEntry(finding(), finding({ quality: '720p' }))).toBe(false)
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

describe('a manifest entry', () => {
  const ENTRY_BASE = {
    url: 'https://cdn.example.com/master.m3u8',
    container: 'm3u8',
    quality: 'unknown',
    kind: 'video' as const,
    sizeBytes: null,
    sources: ['network-response'],
    discoveredAt: 1,
  }

  it('accepts a playlist entry with the facts the page read', () => {
    const entry = {
      ...ENTRY_BASE,
      playlist: {
        live: false,
        encrypted: false,
        byteRanged: false,
        manifest: 'hls',
        segments: 'mp4',
        variants: ['https://cdn/720.m3u8'],
      },
    }
    expect(MediaEntrySchema.safeParse(entry).success).toBe(true)
  })

  it('refuses a playlist carrying a state that does not exist', () => {
    const entry = {
      ...ENTRY_BASE,
      playlist: {
        live: 'not-a-boolean',
        encrypted: false,
        byteRanged: false,
        manifest: 'hls',
        segments: 'mp4',
        variants: [],
      },
    }
    expect(MediaEntrySchema.safeParse(entry).success).toBe(false)
  })

  it('refuses a manifest name outside the set, because a DASH manifest must be labelled, not guessed', () => {
    const entry = {
      ...ENTRY_BASE,
      container: 'mpd',
      playlist: {
        live: false,
        encrypted: false,
        byteRanged: false,
        manifest: 'youtube',
        segments: 'mp4',
        variants: [],
      },
    }
    expect(MediaEntrySchema.safeParse(entry).success).toBe(false)
  })
})