import { describe, expect, it } from 'vitest'

import {
  containerFor,
  containerFromPath,
  derivePlaylistState,
  deriveStreamState,
  isDownloadable,
  isListable,
  isMediaResponse,
  isStreamSavable,
  isSuccessStatus,
  kindFor,
  labelForStream,
  sizeBytesFrom,
} from './media-rules'
import type { PlaylistSignals, StreamSignals } from './types'

// Spec 0004 AC-1 and AC-4: what a response is recorded as, and whether a row may
// offer a download at all. Both are asked from the worker when it observes a request
// and from the popup when it renders a row, so they have to agree, which is why the
// rules live here rather than in either runtime.

describe('whether a response delivered anything', () => {
  // covers: AC-1
  it.each([200, 201, 204, 206, 299])('treats %i as a delivery', (status) => {
    expect(isSuccessStatus(status)).toBe(true)
  })

  it.each([199, 301, 302, 304, 400, 404, 500])('treats %i as no delivery', (status) => {
    // A redirect in particular: it answers with the same path extension as the response
    // that follows it, so a rule that only looked at the container recorded both.
    expect(isSuccessStatus(status)).toBe(false)
  })

  it('treats a response that never reported a status as no delivery', () => {
    expect(isSuccessStatus(undefined)).toBe(false)
  })
})

describe('the container in the URL path', () => {
  it('reads an extension off the last path segment', () => {
    expect(containerFromPath('https://cdn.example.com/media/clip.mp4')).toBe('mp4')
  })

  it('lowercases it, because a CDN path case is not a container name', () => {
    expect(containerFromPath('https://cdn.example.com/clip.MP4')).toBe('mp4')
  })

  it('ignores the query string, which is not a file extension', () => {
    // `?format=mp4` is a parameter. Treating it as an extension is how a segmentless
    // path ends up named after a tracking query.
    expect(containerFromPath('https://cdn.example.com/stream?format=mp4')).toBeNull()
  })

  it('ignores a fragment for the same reason', () => {
    expect(containerFromPath('https://cdn.example.com/clip#mp4')).toBeNull()
  })

  it('has no answer for a path with no extension', () => {
    expect(containerFromPath('https://cdn.example.com/media/clip')).toBeNull()
  })

  it('has no answer for a url that will not parse', () => {
    expect(containerFromPath('not a url')).toBeNull()
  })

  it('does not read a dotfile as an extension', () => {
    expect(containerFromPath('https://example.com/.mp4')).toBeNull()
  })
})

describe('the container for a response', () => {
  it('prefers the path extension over the content type', () => {
    // A CDN path is what a site controls; the header is what a server guesses.
    expect(containerFor('https://cdn.example.com/clip.mp4', 'video/webm')).toBe('mp4')
  })

  it('falls back to the content type map', () => {
    expect(containerFor('https://cdn.example.com/stream', 'video/mp4')).toBe('mp4')
  })

  it('drops the parameters a content type carries', () => {
    expect(containerFor('https://cdn.example.com/s', 'video/mp4; codecs="avc1"')).toBe('mp4')
  })

  it.each([
    ['video/mp4', 'mp4'],
    ['audio/mp4', 'mp4'],
    ['video/webm', 'webm'],
    ['video/ogg', 'ogg'],
    ['application/ogg', 'ogg'],
    ['video/mpeg', 'mpeg'],
    ['video/quicktime', 'mov'],
    ['application/vnd.apple.mpegurl', 'm3u8'],
    ['application/dash+xml', 'mpd'],
  ])('maps %s to %s', (contentType, expected) => {
    expect(containerFor('https://cdn.example.com/stream', contentType)).toBe(expected)
  })

  it('answers unknown rather than failing, because the file is still worth listing', () => {
    expect(containerFor('https://cdn.example.com/stream', 'application/octet-stream')).toBe('unknown')
  })

  it('answers unknown when nothing named the file at all', () => {
    expect(containerFor('https://cdn.example.com/stream')).toBe('unknown')
  })
})

describe('the kind, which is what splits the popup into two lists', () => {
  it('calls an audio content type audio even in an mp4 container', () => {
    // The only signal that separates an audio only mp4 from a video one, and the
    // audio list depends on it.
    expect(kindFor('mp4', 'audio/mp4')).toBe('audio')
  })

  it('calls an audio only container audio with no content type at all', () => {
    // `aac` rather than `m4a`: the container list spec 0004 fixes has no m4a, so an
    // audio only mp4 reaches here as `audio/mp4` and is classified from the header.
    expect(kindFor('aac', undefined)).toBe('audio')
  })

  it.each(['wav', 'aac', 'flac', 'opus'])('calls %s audio', (container) => {
    expect(kindFor(container)).toBe('audio')
  })

  it('calls everything else video', () => {
    expect(kindFor('mp4', 'video/mp4')).toBe('video')
    expect(kindFor('unknown')).toBe('video')
  })
})

describe('whether a row may offer a download', () => {
  it.each(['mp4', 'webm', 'ogg', 'mpeg', 'mov', 'm4v', 'mkv', 'avi', 'flv', 'wav', 'aac', 'flac', 'opus'])(
    'allows %s, which Chrome can save as one file',
    (container) => {
      expect(isDownloadable({ container })).toBe(true)
    }
  )

  it.each(['m3u8', 'mpd'])('refuses %s, which describes other files rather than being one', (container) => {
    // Saving a playlist as a file hands a person a file that will not play.
    expect(isDownloadable({ container })).toBe(false)
  })

  it('refuses a container nothing named, because the extension is never guessed', () => {
    expect(isDownloadable({ container: 'unknown' })).toBe(false)
  })
})

describe('the size a response states', () => {
  it('reads Content-Length off a success', () => {
    expect(sizeBytesFrom({ 'Content-Length': '2048' }, 200)).toBe(2048)
  })

  it('reads it whatever case the header arrived in', () => {
    // Chrome reports header names as sent, so both spellings occur in the wild.
    expect(sizeBytesFrom({ 'content-length': '2048' }, 200)).toBe(2048)
  })

  it('is null when the response states no size', () => {
    expect(sizeBytesFrom({}, 200)).toBeNull()
  })

  it('is null on a failure, whatever the headers say', () => {
    expect(sizeBytesFrom({ 'Content-Length': '2048' }, 404)).toBeNull()
  })

  it('is null when the body is encoded, because then the length is not the file size', () => {
    // `Content-Length` then describes the compressed body, so reporting it would show
    // a size that is not the file's.
    expect(sizeBytesFrom({ 'Content-Length': '2048', 'Content-Encoding': 'gzip' }, 200)).toBeNull()
  })

  it('is null on a length that is not a number', () => {
    expect(sizeBytesFrom({ 'Content-Length': 'lots' }, 200)).toBeNull()
  })

  it('is never computed from anything else', () => {
    expect(sizeBytesFrom(undefined, 200)).toBeNull()
  })
})

describe('whether a response is a media file worth listing', () => {
  it('accepts a video or audio response that succeeded', () => {
    expect(isMediaResponse(200, 'video/mp4')).toBe(true)
    expect(isMediaResponse(206, 'audio/mpeg')).toBe(true)
  })

  it('rejects a response that did not deliver the file', () => {
    // A 302 is the redirect, whose url is not the file's. The final response records.
    expect(isMediaResponse(302, 'video/mp4')).toBe(false)
    expect(isMediaResponse(404, 'video/mp4')).toBe(false)
  })

  it('rejects a response that is not media at all', () => {
    expect(isMediaResponse(200, 'text/html')).toBe(false)
    expect(isMediaResponse(200, undefined)).toBe(false)
  })

  it('rejects a manifest, which describes media rather than being it', () => {
    // The row is still listed by the path rule; it simply carries no control.
    expect(isMediaResponse(200, 'application/dash+xml')).toBe(false)
  })
})

// Spec 0005 AC-5, AC-7, AC-8 and AC-9. The page observes and this decides, so the
// order below is the contract and each position earns it. A test per position,
// because a precedence that is only right on average is wrong in the field.

function signals(overrides: Partial<StreamSignals> = {}): StreamSignals {
  return {
    streamId: 1,
    origin: 'mse',
    bytes: 1024,
    bufferedBytes: 1024,
    live: false,
    encrypted: false,
    ended: false,
    partialReason: 'none',
    mediaElementName: null,
    ...overrides,
  }
}

describe('what a stream signals mean', () => {
  // covers: AC-5
  it('calls a stream with buffered bytes playable, whatever playback has done', () => {
    // The case a media element's ready state would have missed: nobody pressed play,
    // so it never passed metadata, and the row would never have appeared.
    expect(deriveStreamState(signals({ bufferedBytes: 1, bytes: 1 }))).toBe('playable')
  })

  // covers: AC-5
  it('calls a stream holding nothing still collecting', () => {
    expect(deriveStreamState(signals({ bufferedBytes: 0, bytes: 0 }))).toBe('assembling')
  })

  // covers: AC-5
  it('calls a finished stream ended rather than playable', () => {
    expect(deriveStreamState(signals({ ended: true }))).toBe('ended')
  })

  // covers: AC-7
  it('calls an endless stream live', () => {
    expect(deriveStreamState(signals({ live: true }))).toBe('live')
  })

  // covers: AC-8
  it('calls an encrypted stream encrypted', () => {
    expect(deriveStreamState(signals({ encrypted: true }))).toBe('encrypted')
  })

  // covers: AC-9
  it.each([
    ['page_cap', 'partial_capped'],
    ['browser_quota', 'partial_browser_quota'],
    ['broken', 'partial_broken'],
  ] as const)('turns a %s stream into %s', (partialReason, expected) => {
    expect(deriveStreamState(signals({ partialReason }))).toBe(expected)
  })

  // covers: AC-8, AC-9
  it('reads encrypted above everything, because a scrambled stream is never worth a row', () => {
    expect(
      deriveStreamState(
        signals({ encrypted: true, live: true, ended: true, partialReason: 'page_cap' })
      )
    ).toBe('encrypted')
  })

  // covers: AC-9, AC-7
  it('reads partial above live, so a capped live broadcast admits it holds memory', () => {
    // Otherwise this sits on 512 MB of a tab's memory saying only that it is endless.
    expect(deriveStreamState(signals({ live: true, partialReason: 'page_cap' }))).toBe(
      'partial_capped'
    )
  })

  // covers: AC-9
  it('reads partial above assembling, so a stream that broke at three seconds still says so', () => {
    expect(deriveStreamState(signals({ bufferedBytes: 0, bytes: 0, partialReason: 'broken' }))).toBe(
      'partial_broken'
    )
  })

  // covers: AC-9
  it('reads partial above ended, because a broken file of full length is the more useful thing to say', () => {
    expect(deriveStreamState(signals({ ended: true, partialReason: 'browser_quota' }))).toBe(
      'partial_browser_quota'
    )
  })

  // covers: AC-5, AC-7, AC-9
  it('reads live above assembling, because an endless stream has no file at any size', () => {
    expect(deriveStreamState(signals({ bufferedBytes: 0, live: true }))).toBe('live')
  })
})

describe('whether a stream may be saved', () => {
  // covers: AC-7, AC-10
  it('offers a control on a whole stream and a finished one', () => {
    expect(isStreamSavable('playable')).toBe(true)
    expect(isStreamSavable('ended')).toBe(true)
  })

  // covers: AC-7, AC-9, AC-10
  it('offers none on a live stream, which would never finish, or a truncated one', () => {
    expect(isStreamSavable('live')).toBe(false)
    expect(isStreamSavable('partial_capped')).toBe(false)
    expect(isStreamSavable('partial_browser_quota')).toBe(false)
    expect(isStreamSavable('partial_broken')).toBe(false)
    expect(isStreamSavable('encrypted')).toBe(false)
    expect(isStreamSavable('assembling')).toBe(false)
  })
})
// ─── Spec 0005: what the engine makes of a stream, for the row that shows it ──

function entry(overrides: Partial<StreamSignals> = {}, extra: Record<string, unknown> = {}) {
  return { container: 'webm', stream: signals(overrides), ...extra }
}

describe('whether a row may offer a download', () => {
  it('takes the entry rather than the container, because a container cannot answer it', () => {
    // A live broadcast and a capped stream are both `webm` and both perfectly savable
    // containers. Neither can be handed over as a file, which is why the container alone is
    // not the question.
    expect(isDownloadable({ container: 'webm' })).toBe(true)
    expect(isDownloadable(entry({ live: true }))).toBe(false)
    expect(isDownloadable(entry({ partialReason: 'page_cap' }))).toBe(false)
  })

  it('allows a playable or ended stream and nothing else', () => {
    expect(isDownloadable(entry())).toBe(true)
    expect(isDownloadable(entry({ ended: true }))).toBe(true)
  })

  it('refuses an encrypted stream even though its container is savable', () => {
    expect(isDownloadable(entry({ encrypted: true }))).toBe(false)
  })

  it('refuses a stream whose container we cannot name', () => {
    // The file could not be given an extension, so a control would hand over something with
    // no name at all.
    expect(isDownloadable(entry({}, { container: 'unknown' }))).toBe(false)
    expect(isDownloadable(entry({}, { container: 'm3u8' }))).toBe(false)
  })

  it('leaves a file entry exactly as the container rule decided', () => {
    expect(isDownloadable({ container: 'mp4' })).toBe(true)
    expect(isDownloadable({ container: 'mpd' })).toBe(false)
  })
})

describe('whether an entry belongs in the list at all', () => {
  it('lists every file, because a file always has something to show', () => {
    expect(isListable({})).toBe(true)
    expect(isListable({ stream: undefined })).toBe(true)
  })

  it('holds back a stream still collecting, because it has nothing true to say', () => {
    expect(isListable(entry({ bufferedBytes: 0, bytes: 0 }))).toBe(false)
  })

  it('holds back an encrypted stream, because its bytes are not a file', () => {
    expect(isListable(entry({ encrypted: true }))).toBe(false)
  })

  it('lists a stream that lost bytes, even though it never played', () => {
    // That is precisely the moment a person needs telling, so the three partial states are
    // the ones most likely to have no playback behind them at all.
    for (const reason of ['page_cap', 'browser_quota', 'broken'] as const) {
      expect(isListable(entry({ partialReason: reason, bufferedBytes: 0 }))).toBe(true)
    }
  })

  it('lists a live broadcast, so it can say there is no file', () => {
    expect(isListable(entry({ live: true }))).toBe(true)
  })
})

describe('the label a stream row carries', () => {
  it('names a MediaSource stream by its id', () => {
    expect(labelForStream(signals({ streamId: 1 }))).toBe('Stream 1')
    expect(labelForStream(signals({ streamId: 12 }))).toBe('Stream 12')
  })

  it('says a blob is already a whole file, because that is what a person can act on', () => {
    // A blob saves at once and a MediaSource stream has to be assembled first, which is the
    // difference worth putting where the person reads it.
    expect(labelForStream(signals({ streamId: 2, origin: 'blob' }))).toBe('Whole file 2')
  })

  it('never carries an address, because a blob address ends in a uuid', () => {
    const label = labelForStream(signals({ origin: 'blob' }))
    expect(label).not.toContain('blob:')
    expect(label).not.toContain('/')
  })

  it('tells two streams on one page apart, which is the whole point of the id', () => {
    const first = labelForStream(signals({ streamId: 1 }))
    const second = labelForStream(signals({ streamId: 2 }))
    expect(first).not.toBe(second)
  })
})
describe('what a playlist signals mean', () => {
  function playlist(overrides: Partial<PlaylistSignals> = {}): PlaylistSignals {
    return {
      live: false,
      encrypted: false,
      byteRanged: false,
      manifest: 'hls',
      segments: 'mp4',
      variants: [],
      ...overrides,
    }
  }

  it('joins a video on demand fragmented MP4 playlist', () => {
    expect(derivePlaylistState(playlist())).toBe('assemblable')
  })

  it('labels an encrypted playlist before anything else, because the bytes are never worth a control', () => {
    expect(derivePlaylistState(playlist({ encrypted: true, live: true }))).toBe('encrypted')
  })

  it('labels a byte ranged playlist, because we never build a file from stacked ranges', () => {
    expect(derivePlaylistState(playlist({ byteRanged: true }))).toBe('byte_ranged')
  })

  it('labels a DASH manifest rather than assembling it, because DASH plays through spec 0005', () => {
    expect(derivePlaylistState(playlist({ manifest: 'dash' }))).toBe('unsupported_container')
  })

  it('labels a transport stream playlist, because Chrome will not play the joined file', () => {
    expect(derivePlaylistState(playlist({ segments: 'ts' }))).toBe('unsupported_container')
  })

  it('labels a live playlist, because an endless playlist has no whole file', () => {
    expect(derivePlaylistState(playlist({ live: true }))).toBe('live')
  })

  it('labels an unrecognised manifest rather than attempting a join nobody validated', () => {
    expect(derivePlaylistState(playlist({ manifest: 'unknown' }))).toBe('unsupported_container')
  })

  it('keeps every playlist listable, because however the page read it the row has something to say', () => {
    expect(isListable({ playlist: playlist({ encrypted: true }) })).toBe(true)
    expect(isListable({ playlist: playlist() })).toBe(true)
  })

  it('offers a control on an assemblable playlist and none on any other', () => {
    expect(isDownloadable({ container: 'm3u8', playlist: playlist() })).toBe(true)
    expect(isDownloadable({ container: 'm3u8', playlist: playlist({ live: true }) })).toBe(false)
    expect(isDownloadable({ container: 'mpd', playlist: playlist({ manifest: 'dash' }) })).toBe(false)
  })

  it('offers nothing on a manifest the page never read, because there is no state yet', () => {
    expect(isDownloadable({ container: 'm3u8' })).toBe(false)
  })
})
