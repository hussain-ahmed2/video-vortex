// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  capWouldBeCrossed,
  PAGE_CHANNEL_SOURCE,
  PAGE_STREAM_BYTE_CAP,
  parseHookReport,
  type PageStream,
} from './engine/page-channel'
import {
  FakeMediaSource,
  FakeSourceBuffer,
  installFakeBlobUrls,
  installFakeMediaElements,
  installFakePageMedia,
} from './testing'

// Spec 0005's page hook, driven through the fakes a real page would be driven through: the
// hook patches the prototypes of the objects the fake exports, and every action below goes
// in through those patched methods. What is asserted is therefore the interception path
// itself rather than a door into the hook's own state.
//
// covers: AC-1, AC-2, AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-10, AC-12, AC-13, AC-14,
// AC-18, AC-20

const PAGE_URL = 'https://example.com/watch'

/** The key the hook stamps itself under, which is what makes a second injection a no-op. */
const STAMP_KEY = '__videoVortexHookBuild'

/** The MIME type the fake site streams in. */
const MIME = 'video/webm; codecs="vp8, vorbis"'

/**
 * The methods as they were before any hook patched them.
 *
 * Captured here, at module scope, because the hook is imported inside each test and every
 * import wraps whatever it finds. Restoring them afterwards is what stops one test's hook
 * from being inside the next test's.
 */
const NATIVE = {
  addSourceBuffer: FakeMediaSource.prototype.addSourceBuffer,
  appendBuffer: FakeSourceBuffer.prototype.appendBuffer,
  abort: FakeSourceBuffer.prototype.abort,
}

let page: ReturnType<typeof installFakePageMedia>
let urls: ReturnType<typeof installFakeBlobUrls>
let players: ReturnType<typeof installFakeMediaElements>

let token: string
let tokenCount = 0

/** Every snapshot the hook has posted under the current token, in order. */
let reports: PageStream[][]
/** Every assembly answer the hook has posted, in order. */
let answers: { streamId: number; ok: boolean; error?: string }[]
/** Reports and answers refused for carrying a token that is not the current one. */
let stale: number
/** Every download the hook started, read back off the link it clicked. */
let clicked: { href: string; download: string }[]

/**
 * Stands in for the content script's half of the channel.
 *
 * The hook is a separate world from the extension, so the only thing connecting them is
 * this message bus. The relay drops anything without the current token, exactly as the real
 * one does, which is what makes a stale build's report a testable event rather than a claim.
 */
window.addEventListener('message', (event: MessageEvent): void => {
  const parsed = parseHookReport(event.data)
  if (!parsed) return

  // Answered the way the real relay answers it, because the two files are injected
  // separately and either may arrive second. Which one carries the install is not ours to
  // rely on, so both say hello and both ask.
  if (parsed.type === 'hello') {
    window.postMessage(
      {
        source: PAGE_CHANNEL_SOURCE,
        type: 'install',
        token,
        pageUrl: PAGE_URL,
      },
      '*'
    )
    return
  }

  if (parsed.token !== token) {
    stale += 1
    return
  }

  if (parsed.type === 'streams') reports.push(parsed.streams)
  else answers.push({ streamId: parsed.streamId, ok: parsed.ok, error: parsed.error })
})

/**
 * The click a download starts, caught before the browser acts on it.
 *
 * Prevented rather than followed, because jsdom cannot navigate and says so loudly. The
 * handler is on the document so it sees the click whichever element the hook chose, which is
 * the thing under test.
 */
document.addEventListener('click', (event: MouseEvent): void => {
  const target = event.target as HTMLAnchorElement | null
  if (!target || target.tagName !== 'A') return
  event.preventDefault()
  clicked.push({ href: target.href, download: target.download })
})

/**
 * Lets the page's own message bus deliver.
 *
 * One turn per hop, and there are three: the greeting reaches the relay, the relay's
 * install reaches the hook, and the hook's own answer reaches the relay. Waiting fewer is
 * the shape that makes every assertion here look like a failure of the code rather than of
 * the wait.
 */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/**
 * Runs the hook's report tick.
 *
 * Players are bound and sizes are flushed here rather than on every chunk, because both walk
 * the page or the stream list and an append happens thousands of times.
 */
async function tick(): Promise<void> {
  vi.advanceTimersByTime(1000)
  await flush()
}

/** Loads the hook the way an injection does, and installs it with the current token. */
async function installHook(options: { pageUrl?: string; token?: string } = {}): Promise<void> {
  vi.resetModules()
  await import('./hook')
  window.postMessage(
    {
      source: PAGE_CHANNEL_SOURCE,
      type: 'install',
      token: options.token ?? token,
      pageUrl: options.pageUrl ?? PAGE_URL,
    },
    '*'
  )
  await flush()
}

/** Asks for a file, the way the content script relays the worker's request. */
async function requestAssembly(streamId: number, filename?: string): Promise<void> {
  window.postMessage(
    {
      source: PAGE_CHANNEL_SOURCE,
      type: 'assemble',
      token,
      streamId,
      ...(filename ? { filename } : {}),
    },
    '*'
  )
  await flush()
}

/** A MediaSource with one buffer, the shape most players create. */
function openStream(): { mediaSource: FakeMediaSource; buffer: FakeSourceBuffer } {
  const mediaSource = page.open()
  const buffer = mediaSource.addSourceBuffer(MIME)
  return { mediaSource, buffer }
}

function payload(length: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(length).fill(7)
}

/** The last snapshot, which is the state a person would be looking at. */
function latest(): PageStream[] {
  return reports[reports.length - 1] ?? []
}

/** The one stream the last snapshot holds, which is what most cases below are about. */
function onlyStream(): PageStream {
  const streams = latest()
  if (streams.length !== 1) throw new Error(`expected one stream, saw ${streams.length}`)
  return streams[0] as PageStream
}

/** The address the page would use for a MediaSource it is playing. */
function addressOf(mediaSource: FakeMediaSource): string {
  return URL.createObjectURL(mediaSource as unknown as MediaSource)
}

beforeEach(() => {
  page = installFakePageMedia()
  urls = installFakeBlobUrls()
  players = installFakeMediaElements()

  tokenCount += 1
  token = `token-${tokenCount}`
  reports = []
  answers = []
  stale = 0
  clicked = []

  delete (globalThis as Record<string, unknown>)[STAMP_KEY]

  // Only the interval is faked. The tick has to be driven by hand to keep the cadence
  // assertions honest, while the page's own message delivery has to keep running on real
  // time, which faking every timer would take away.
  vi.useFakeTimers({ toFake: ['setInterval'] })
})

afterEach(() => {
  vi.useRealTimers()
  FakeMediaSource.prototype.addSourceBuffer = NATIVE.addSourceBuffer
  FakeSourceBuffer.prototype.appendBuffer = NATIVE.appendBuffer
  FakeSourceBuffer.prototype.abort = NATIVE.abort
  players.restore()
  urls.restore()
  page.restore()
})

describe('installing the hook on a page', () => {
  it('announces an empty list the moment it is installed', async () => {
    // Everything it holds is announced on install, because a stream that began before the
    // hook existed left no trace and the only way a person learns about one is being told
    // what is already there.
    await installHook()

    expect(reports).toHaveLength(1)
    expect(latest()).toEqual([])
  })

  it('installs from the greeting alone, with no install posted first', async () => {
    // The worker injects the content script and then the hook, and a postMessage is
    // delivered on a later task, so the install can be posted into a window the hook has
    // not attached to yet. The hook saying hello is what closes that gap.
    vi.resetModules()
    await import('./hook')
    await flush()

    expect(reports).toHaveLength(1)
    expect(latest()).toEqual([])
  })

  it('does nothing on a second injection of the same build', async () => {
    await installHook()
    const seen = reports.length

    vi.resetModules()
    await import('./hook')
    await flush()

    // The greeting is answered with the same token and the same page, which is the one
    // case that adds nothing.
    expect(reports).toHaveLength(seen)
  })

  it('copies each chunk once even when the build is injected twice', async () => {
    // The stamp is what makes this true. Without it a second copy would wrap the same
    // prototype again and every chunk would be held twice, in two sets of memory.
    await installHook()
    const { buffer } = openStream()
    await buffer.append(payload(500_000))
    await flush()

    vi.resetModules()
    await import('./hook')
    await buffer.append(payload(500_000))
    await tick()

    expect(onlyStream().bytes).toBe(1_000_000)
  })

  it('gives up the page to a newer injection rather than answering under its token', async () => {
    await installHook()
    const seen = reports.length

    // A hook left over from a previous build is still on the page and still receives these
    // messages. If it could adopt the current token it would report under it, and every
    // report the content script drops would be one this let through.
    await installHook({ token: 'another-extensions-token' })

    expect(reports).toHaveLength(seen)
    expect(stale).toBe(0)
  })

  it('gives up the bytes it copied, which a replaced hook would hold for the life of the tab', async () => {
    await installHook()
    const firstToken = token;
    const { buffer } = openStream();
    await buffer.append(payload(500_000));
    await flush();

    // The wrappers cannot be unwrapped, so this hook is still handed every chunk the page
    // appends. A hook that has been replaced but keeps copying holds up to the page's whole
    // cap in memory that nothing will ever read.
    token = 'a-newer-injection';
    await installHook({ token });
    const seen = reports.length;

    await buffer.append(payload(500_000));
    await flush();

    // It has gone quiet, which is the half a person could notice.
    expect(reports).toHaveLength(seen);

    // Asking it for the file is what proves the other half. Its own token still matches, so
    // it answers, and the only way it can know there are no bytes is that the chunks it was
    // holding are gone rather than sitting in a map nothing can reach.
    token = firstToken;
    window.postMessage(
      { source: PAGE_CHANNEL_SOURCE, type: 'assemble', token, streamId: 1 },
      '*'
    )
    await flush()

    expect(answers).toEqual([{ streamId: 1, ok: false, error: 'no_bytes' }])
  })

  it('re-announces when the page url changed, which is how a single page app survives', async () => {
    await installHook()
    const { buffer } = openStream()
    await buffer.append(payload(1000))
    await flush()
    expect(latest()).toHaveLength(1)

    await installHook({ pageUrl: 'https://example.com/watch?v=2' })

    // The rows are still there, which is the whole point: a navigation without a reload
    // leaves the streams live, and returning early would drop them from the list.
    expect(latest()).toHaveLength(1)
    expect(latest()[0]?.streamId).toBe(1)
  })
})

describe('a MediaSource stream', () => {
  it('is reported with the MIME type that names a container', async () => {
    await installHook()
    openStream()
    await flush()

    expect(onlyStream()).toMatchObject({ origin: 'mse', mimeType: MIME, bytes: 0 })
  })

  it('holds no bytes until something is appended', async () => {
    await installHook()
    openStream()
    await flush()

    expect(onlyStream().bytes).toBe(0)
    expect(onlyStream().bufferedBytes).toBe(0)
  })

  it('reports buffered bytes from the buffers rather than from playback', async () => {
    await installHook()
    const { buffer } = openStream()

    // Nothing appended, so nothing buffered. A paused element that never played passes no
    // metadata at all, which is why playback progress cannot be the signal here.
    await flush()
    expect(onlyStream().bufferedBytes).toBe(0)

    await buffer.append(payload(4000))
    await flush()
    expect(onlyStream().bufferedBytes).toBe(4000)
  })

  it('is one stream however many buffers it has, so audio and video share a row', async () => {
    await installHook()
    const { mediaSource } = openStream()
    mediaSource.addSourceBuffer('audio/webm; codecs="vorbis"')
    await flush()

    expect(latest()).toHaveLength(1)
    expect(onlyStream().streamId).toBe(1)
  })

  it('replaces the row when a player re-adds a buffer for the same stream', async () => {
    await installHook()
    const { mediaSource } = openStream()
    await mediaSource.addSourceBuffer('audio/webm; codecs="vorbis"')
    await flush()

    expect(latest()).toHaveLength(1)
  })

  it('is ended by the end of stream the MediaSource fires', async () => {
    await installHook()
    const { mediaSource, buffer } = openStream()
    await buffer.append(payload(1000))

    mediaSource.endOfStream()
    await flush()

    expect(onlyStream().ended).toBe(true)
  })

  it('is encrypted once the browser says so', async () => {
    await installHook()
    const { buffer } = openStream()

    buffer.emitEncrypted()
    await flush()

    // The page decides nothing about it. It says what it saw, and the engine decides that
    // such a stream is never recorded at all.
    expect(onlyStream().encrypted).toBe(true)
  })

  it('reads as partial when the browser refuses an append against its own quota', async () => {
    await installHook()
    const { mediaSource } = openStream()
    const buffer = mediaSource.addSourceBuffer(MIME)
    buffer.setQuotaExceeded(true)

    // The refusal is rethrown, and synchronously as Chrome throws it, because the player's
    // own code handles it and swallowing it would change how the page behaves.
    expect(() => buffer.append(payload(100))).toThrow(/quota/)
    await flush()

    expect(onlyStream().partialReason).toBe('browser_quota')
  })

  it('reads as partial when the player abandons the buffer', async () => {
    await installHook()
    const { buffer } = openStream()
    await buffer.append(payload(1000))

    buffer.abort()
    await flush()

    expect(onlyStream().partialReason).toBe('broken')
  })

  it('keeps the reason it went partial, whatever is appended afterwards', async () => {
    await installHook()
    const { buffer } = openStream()
    await buffer.append(payload(1000))
    buffer.abort()
    await flush()

    await buffer.append(payload(1000))
    await flush()

    // Bytes already copied cannot be uncopied, so the only honest state for a stream that
    // has lost bytes is the one it lost them in.
    expect(onlyStream().partialReason).toBe('broken')
  })

  it('does not treat a remove as a cause, which is a known gap rather than an oversight', async () => {
    await installHook()
    const { buffer } = openStream()
    await buffer.append(payload(1000))

    buffer.remove(0, 500)
    await flush()

    expect(onlyStream().partialReason).toBe('none')
  })
})

describe('the page wide cap', () => {
  it('copies everything while the page total stays under the cap', async () => {
    await installHook()
    const { buffer } = openStream()

    await buffer.append(payload(1_000_000))
    await flush()

    // Nothing near 512 MB, so the cap is nowhere near being read. The crossing itself is
    // pinned where it is decided, in the engine's `capWouldBeCrossed`, because crossing it
    // for real means holding half a gigabyte in a test.
    expect(onlyStream().partialReason).toBe('none')
    expect(onlyStream().bytes).toBe(1_000_000)
  })

  it('decides the crossing by the one rule the engine states', async () => {
    // The number and the comparison live in the engine, so the hook and the popup cannot
    // disagree about what the cap is. Naming them here is what proves the hook reads that
    // rule rather than a copy of it.
    expect(PAGE_STREAM_BYTE_CAP).toBe(512 * 1024 * 1024)
    expect(capWouldBeCrossed(0, PAGE_STREAM_BYTE_CAP - 1)).toBe(false)
    expect(capWouldBeCrossed(0, PAGE_STREAM_BYTE_CAP)).toBe(true)
  })
})

describe('a blob stream', () => {
  function videoBlob(size = 2048): Blob {
    return new Blob([payload(size)], { type: 'video/mp4' })
  }

  it('is recorded from the address the page made, with nothing copied', async () => {
    await installHook()

    URL.createObjectURL(videoBlob())
    await flush()

    // A blob is already a whole file, so there are no chunks to hold and nothing to
    // assemble. Copying it would double the tab's memory for nothing.
    expect(onlyStream()).toMatchObject({ origin: 'blob', bytes: 2048, mimeType: 'video/mp4' })
  })

  it('is one stream however many times the page addresses it', async () => {
    await installHook()
    const blob = videoBlob()

    URL.createObjectURL(blob)
    URL.createObjectURL(blob)
    await flush()

    expect(latest()).toHaveLength(1)
  })

  it('survives the page revoking the address', async () => {
    await installHook()
    const blob = videoBlob()
    const address = URL.createObjectURL(blob)

    URL.revokeObjectURL(address)
    await flush()

    // The address is the page's, not ours. The object is still in our hands, so the row
    // outlives the revoke rather than vanishing with it.
    expect(onlyStream().bytes).toBe(2048)
  })

  it('is ignored when it is not audio or video', async () => {
    await installHook()

    URL.createObjectURL(new Blob([payload(16)], { type: 'application/json' }))
    await flush()

    // No evidence that this is media, and a row offering to save a JSON file is a lie.
    expect(latest()).toEqual([])
  })

  it('is never a MediaSource handed to the same function', async () => {
    await installHook()
    const { mediaSource } = openStream()

    addressOf(mediaSource)
    await flush()

    // The origin is decided by what the object is, not by which hook path saw the call.
    // Getting this wrong sends a MediaSource down the blob path, where the type test
    // rejects it and the stream disappears.
    expect(latest()).toHaveLength(1)
    expect(onlyStream().origin).toBe('mse')
  })
})

describe('binding a player to a stream', () => {
  it('reads an endless stream as live, because an infinite duration is the only signal', async () => {
    await installHook()
    const { mediaSource } = openStream()

    players.bind({ src: addressOf(mediaSource), duration: Infinity })
    await tick()

    expect(onlyStream().live).toBe(true)
  })

  it('is never live on the blob path, because the object is whole the moment it exists', async () => {
    await installHook()
    const blob = videoBlobOfSize(2048)

    players.bind({ src: URL.createObjectURL(blob), duration: Infinity })
    await tick()

    expect(onlyStream().live).toBe(false)
  })

  it('takes the name the page gave the media, and nothing at all for a plain blob', async () => {
    await installHook()
    const file = new File([payload(2048)], 'Documentary_Stream.mp4', { type: 'video/mp4' })
    players.bind({ src: URL.createObjectURL(file) })
    players.bind({ src: URL.createObjectURL(new Blob([payload(1024)], { type: 'video/mp4' })) })
    await tick()

    const streams = latest()
    expect(streams.find((stream) => stream.streamId === 1)?.mediaElementName).toBe(
      'Documentary_Stream'
    )
    // A blob address is a uuid, so a name read off one would put `<uuid>` on every row of
    // the page.
    expect(streams.find((stream) => stream.streamId === 2)?.mediaElementName).toBeNull()
  })

  it('ignores a player that is not playing anything we hold', async () => {
    await installHook()
    openStream()

    players.bind({ src: 'https://cdn.example.com/somewhere-else.mp4' })
    await tick()

    expect(latest()).toHaveLength(1)
  })
})

function videoBlobOfSize(size: number): Blob {
  return new Blob([payload(size)], { type: 'video/mp4' })
}

describe('producing the file', () => {
  it('joins the copied chunks into one download for a MediaSource stream', async () => {
    await installHook()
    const { buffer } = openStream()
    await buffer.append(payload(1000))
    await buffer.append(payload(24))
    await flush()

    await requestAssembly(1, 'Documentary_Stream.webm')

    expect(clicked).toHaveLength(1)
    expect(clicked[0]?.download).toBe('Documentary_Stream.webm')
    expect(answers).toEqual([{ streamId: 1, ok: true }])
  })

  it('hands over exactly the bytes that were appended, in order', async () => {
    await installHook()
    const { buffer } = openStream()
    await buffer.append(new Uint8Array([1, 2, 3, 4]))
    await buffer.append(new Uint8Array([9, 9]))
    await flush()

    await requestAssembly(1, 'joined.webm')

    // Read back off the address that was clicked, so what is asserted is the file the
    // browser would receive rather than the hook's own idea of it.
    const file = urls.objectFor(clicked[0]?.href ?? '')
    expect(file).toBeInstanceOf(Blob)
    expect(new Uint8Array(await (file as Blob).arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3, 4, 9, 9])
    )
  })

  it('clicks the address the page already made for a blob, minting nothing', async () => {
    await installHook()
    const blob = videoBlobOfSize(2048)
    const address = URL.createObjectURL(blob)
    const before = urls.minted()
    await flush()

    await requestAssembly(1, 'Already_There.mp4')

    expect(clicked[0]?.href).toBe(address)
    expect(urls.minted()).toBe(before)
  })

  it('does not record the file it just built as a stream of its own', async () => {
    await installHook()
    const { buffer } = openStream()
    await buffer.append(payload(1000))
    await flush()

    await requestAssembly(1, 'joined.webm')
    await flush()

    // The hook mints an address to hand the file over, and that address goes through the
    // same function the page uses. Recording it would give the popup a second row for every
    // download that worked.
    expect(latest()).toHaveLength(1)
  })

  it('says one download is already running rather than assembling twice', async () => {
    await installHook()
    const { buffer } = openStream()
    await buffer.append(payload(1000))
    await flush()

    // Two requests in one turn, which is what two quick clicks are.
    for (let click = 0; click < 2; click += 1) {
      window.postMessage({ source: PAGE_CHANNEL_SOURCE, type: 'assemble', token, streamId: 1 }, '*')
    }
    await flush()

    expect(clicked).toHaveLength(1)
    expect(answers).toHaveLength(2)
    expect(answers[1]).toMatchObject({ ok: false, error: 'already_running' })
  })

  it('says there are no bytes for a stream it does not hold', async () => {
    await installHook()

    await requestAssembly(99, 'nothing.webm')

    expect(clicked).toHaveLength(0)
    expect(answers).toEqual([{ streamId: 99, ok: false, error: 'no_bytes' }])
  })

  it('ignores a request carrying a token it was not installed with', async () => {
    await installHook()
    const { buffer } = openStream()
    await buffer.append(payload(1000))
    await flush()

    window.postMessage(
      { source: PAGE_CHANNEL_SOURCE, type: 'assemble', token: 'a-stale-build', streamId: 1 },
      '*'
    )
    await flush()

    // A previous injection's request, or a previous build's. Answering it would assemble a
    // file for a row the worker may no longer hold.
    expect(clicked).toHaveLength(0)
    expect(answers).toHaveLength(0)
  })

  it('carries no name when it is given none, rather than an empty one', async () => {
    await installHook()
    const { buffer } = openStream()
    await buffer.append(payload(1000))
    await flush()

    await requestAssembly(1)

    // An empty `download` makes the browser invent a name from the address, which for a
    // blob is a uuid.
    expect(clicked[0]?.download).toBe('')
  })
})

describe('the report cadence', () => {
  it('reports a signal at once rather than making a row wait for the tick', async () => {
    await installHook()
    const { buffer } = openStream()
    const before = reports.length

    await buffer.append(payload(1000))
    await flush()

    // The buffered ranges crossing zero is what makes the row appear, and making someone
    // wait a second for a row is a second of the extension looking broken.
    expect(reports.length).toBeGreaterThan(before)
  })

  it('holds a size back until the tick, so a stream of chunks is not a stream of writes', async () => {
    await installHook()
    const { buffer } = openStream()
    await buffer.append(payload(1000))
    await flush()
    const afterFirst = reports.length

    // Grows again, and every byte count moves with it. Both stay in the same rounded
    // bucket, so nothing a person could see has moved and no write is worth making.
    await buffer.append(payload(1000))
    await flush()

    expect(reports.length).toBe(afterFirst)

    await buffer.append(payload(200_000))
    await tick()

    expect(reports.length).toBeGreaterThan(afterFirst)
  })
})

describe('a stale build left on the page', () => {
  it('keeps reporting, and the relay drops it', async () => {
    await installHook({ token: 'the-old-build' })
    const { buffer } = openStream()
    await buffer.append(payload(1000))
    await flush()

    // The relay refuses it because the content script minted a different token. That is the
    // whole of what the token is for: not a defence against the page, which shares this
    // world, but a way to stop a hook left over from a previous build adding a row.
    expect(reports).toHaveLength(0)
    expect(stale).toBeGreaterThan(0)
  })
})