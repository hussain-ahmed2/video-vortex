// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  FakeMediaSource,
  FakeSourceBuffer,
  installFakeBlobUrls,
  installFakeMediaElements,
  installFakePageMedia,
} from './page-media'

// The page media fakes, proven against the browser behaviours the hook reads. A fake
// that is more forgiving than the browser lets a broken hook pass, so each of these is
// the shape the hook has to cope with rather than the shape that would be convenient.

let page: ReturnType<typeof installFakePageMedia>
let urls: ReturnType<typeof installFakeBlobUrls>
let players: ReturnType<typeof installFakeMediaElements>

beforeEach(() => {
  page = installFakePageMedia()
  urls = installFakeBlobUrls()
  players = installFakeMediaElements()
})

afterEach(() => {
  players.restore()
  urls.restore()
  page.restore()
})

describe('the SourceBuffer fake', () => {
  it('grows its buffered ranges by what was appended', () => {
    const buffer = new FakeSourceBuffer('video/mp4')

    return buffer
      .append(new Uint8Array(100))
      .then(() => buffer.append(new Uint8Array(50)))
      .then(() => {
        const ranges = buffer.buffered
        expect(ranges.length).toBe(1)
        expect(ranges.end(0) - ranges.start(0)).toBe(150)
      })
  })

  it('throws a QuotaExceededError out of appendBuffer, as Chrome does', () => {
    // Synchronously, not as a rejection. The hook has to see the real shape or it will
    // handle a real site's quota differently from the fake's.
    const buffer = new FakeSourceBuffer('video/mp4', { quotaExceeded: true })

    expect(() => buffer.appendBuffer(new Uint8Array(10))).toThrowError(/quota/)
    try {
      buffer.appendBuffer(new Uint8Array(10))
    } catch (error) {
      expect((error as DOMException).name).toBe('QuotaExceededError')
    }
  })

  it('keeps nothing buffered when the browser refused the bytes', () => {
    const buffer = new FakeSourceBuffer('video/mp4', { quotaExceeded: true })
    try {
      buffer.appendBuffer(new Uint8Array(10))
    } catch {
      // the refusal is the assertion above
    }

    expect(buffer.buffered.length).toBe(0)
    expect(buffer.accepted()).toEqual([])
  })

  it('empties on abort, which is what a player walking away leaves behind', () => {
    const buffer = new FakeSourceBuffer('video/mp4')

    return buffer
      .append(new Uint8Array(100))
      .then(() => {
        buffer.abort()
        expect(buffer.buffered.length).toBe(0)
      })
  })

  it('tears a hole on remove, which the hook deliberately does not treat as a cause', () => {
    const buffer = new FakeSourceBuffer('video/mp4')

    return buffer
      .append(new Uint8Array(100))
      .then(() => {
        buffer.remove(20, 50)
        expect(buffer.buffered.length).toBe(2)
        expect(buffer.buffered.end(0)).toBe(20)
        expect(buffer.buffered.start(1)).toBe(50)
      })
  })

  it('fires encrypted as an event, because that is the only signal there is', () => {
    const buffer = new FakeSourceBuffer('video/mp4')
    const seen: string[] = []
    buffer.addEventListener('encrypted', () => seen.push('encrypted'))

    buffer.emitEncrypted()

    expect(seen).toEqual(['encrypted'])
  })
})

describe('the MediaSource fake', () => {
  it('refuses a buffer before it is open, as the browser does', () => {
    const source = new FakeMediaSource()
    expect(() => source.addSourceBuffer('video/mp4')).toThrowError(/not open/)
  })

  it('lists its buffers by length and index, which is how the hook reads the list', () => {
    const source = new FakeMediaSource()
    source.open()
    source.addSourceBuffer('video/mp4')
    source.addSourceBuffer('audio/mp4')

    const seen: string[] = []
    for (let index = 0; index < source.sourceBuffers.length; index += 1) {
      seen.push(source.sourceBuffers[index].mimeType)
    }

    expect(seen).toEqual(['video/mp4', 'audio/mp4'])
  })

  it('fires sourceended when the stream ends, which is the ended signal', () => {
    const source = new FakeMediaSource()
    source.open()
    const seen: string[] = []
    source.addEventListener('sourceended', () => seen.push('ended'))

    source.endOfStream()

    expect(seen).toEqual(['ended'])
    expect(source.readyState).toBe('ended')
  })
})

describe('the blob address fake', () => {
  it('records which object each address stands for', () => {
    const blob = new Blob([new Uint8Array(4)], { type: 'video/mp4' })

    const url = URL.createObjectURL(blob)

    expect(urls.urlFor(blob)).toBe(url)
    expect(urls.minted()).toBe(1)
  })

  it('tells a Blob apart from a MediaSource, which is the decision the hook makes', () => {
    const source = page.open()
    const blob = new Blob([new Uint8Array(4)], { type: 'video/mp4' })

    // Cast because this fake stands in for a browser type jsdom does not implement, and
    // the hook's own check is `instanceof MediaSource` at run time rather than this type.
    const sourceUrl = URL.createObjectURL(source as unknown as MediaSource)
    const blobUrl = URL.createObjectURL(blob)

    expect(urls.urlFor(source)).toBe(sourceUrl)
    expect(urls.urlFor(blob)).toBe(blobUrl)
    expect(urls.urlFor(blob)).not.toBe(urls.urlFor(source))
  })

  it('records a revocation, because a blob url the page drops is a real case', () => {
    const blob = new Blob([new Uint8Array(4)], { type: 'video/mp4' })
    const url = URL.createObjectURL(blob)

    URL.revokeObjectURL(url)

    expect(urls.revoked()).toEqual([url])
    expect(urls.urlFor(blob)).toBeUndefined()
  })

  it('restores the real functions, so one test cannot leak into the next', () => {
    urls.restore()
    const after = installFakeBlobUrls()

    expect(after.minted()).toBe(0)

    after.restore()
    urls = installFakeBlobUrls()
  })
})

describe('the player fake', () => {
  it('reports the address and the duration the browser would report', () => {
    const element = players.bind({ src: 'blob:https://example.com/abc', duration: 12 })

    expect(element.currentSrc).toBe('blob:https://example.com/abc')
    expect(element.duration).toBe(12)
  })

  it('attaches the player, because the hook finds players by asking the document', () => {
    players.bind({ src: 'blob:https://example.com/abc' })

    expect(document.querySelectorAll('video, audio')).toHaveLength(1)
  })

  it('carries an infinite duration, which is the only signal a live stream has', () => {
    const element = players.bind({ src: 'blob:https://example.com/live', duration: Infinity })

    expect(element.duration).toBe(Infinity)
  })

  it('takes every player off the page again', () => {
    players.bind({ src: 'blob:https://example.com/abc' })

    players.restore()
    players = installFakeMediaElements()

    expect(document.querySelectorAll('video, audio')).toHaveLength(0)
  })
})