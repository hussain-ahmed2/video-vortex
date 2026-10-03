// The page hook: it runs in the page's own world and watches the two mechanisms a page
// uses to build media in the browser, neither of which ever appears as a file on the
// network.
//
// A `SourceBuffer` cannot be read back, so anything worth saving has to be copied as it
// arrives, and copying it has to happen in the page, because the page is the only place
// the media exists. A `blob:` video is the opposite case: the page already holds a whole
// finished object, so the hook only holds on to it. That difference is the whole design,
// and it is why both mechanisms are watched here and neither is watched from outside.
//
// Everything below is wrapped so that a site which fights the hook gets nothing rather
// than an error in its own player. A download tool that breaks the video it is helping
// with has taken something from the person watching it.
//
// What this file must never do is decide what a stream means. It reports what it
// observed and the engine in `src/engine/` decides what a person should be told, which is
// why `deriveStreamState` is not called from here and why the raw signals cross the
// boundary rather than a conclusion.

import {
  capWouldBeCrossed,
  PAGE_CHANNEL_SOURCE,
  parseHookCommand,
  type PageStream,
} from './engine/page-channel'
import type { StreamAssembleError } from './engine/messages'
import type { PartialReason, StreamOrigin } from './engine/types'

/**
 * How often a changed size is allowed to become a report.
 *
 * A stream of thousands of chunks would otherwise become thousands of storage writes and
 * broadcasts, so a size only travels on this tick. A signal that is not a size travels
 * at once, because a row appearing is not something to make wait.
 */
const REPORT_INTERVAL_MS = 1000

/**
 * The rounding applied to a reported size.
 *
 * The popup renders a size to one decimal place, so a change smaller than this renders
 * identically and is not worth a write. Quantising before the comparison is what makes
 * that true rather than hopeful.
 */
const SIZE_BUCKET_BYTES = 64 * 1024

/**
 * How long the address a stream was handed out for is kept alive.
 *
 * Long enough that the browser has taken the bytes and started writing them. Revoking it
 * at once cancels the download, and never revoking it leaks a copy of the file for the
 * life of the tab.
 */
const REVOKE_AFTER_MS = 30_000

/** One stream as the page holds it. Never a verdict: only what was observed. */
interface HeldStream {
  streamId: number
  origin: StreamOrigin
  /** The `SourceBuffer`'s MIME type, or the `Blob`'s type. The only thing to name a container with. */
  mimeType: string
  /** What the hook has copied out of the page. */
  bytes: number
  live: boolean
  encrypted: boolean
  ended: boolean
  partialReason: PartialReason
  mediaElementName: string | null
  /** An mse stream's copied chunks, in arrival order. Empty for a blob. */
  chunks: Uint8Array<ArrayBuffer>[]
  /** A blob stream's object, which is whole the moment it exists. Null for an mse stream. */
  blob: Blob | null
  /** The address the page gave this stream, so a download can click the one it made. */
  address: string | null
  /** The MediaSource behind an mse stream, which is what owns the buffers to sum. */
  mediaSource: MediaSource | null
}

const streams = new Map<number, HeldStream>()

/** One id per MediaSource, so every buffer of it contributes to one row and one file. */
const mediaSourceIds = new WeakMap<MediaSource, number>()

/** Which stream a buffer belongs to, found at append time from the buffer itself. */
const bufferStreams = new WeakMap<SourceBuffer, number>()

/** Which stream an address points at, which is how a player is bound to one. */
const addressStreams = new Map<string, number>()

/** One id per Blob, so re-addressing a finished object does not list it twice. */
const blobIds = new WeakMap<Blob, number>()

/** Streams whose bytes are lost and why. A latch, so it is never cleared. */
const latched = new Set<number>()

/** Assemblies in progress, so a second click says one is running rather than making two. */
const assembling = new Set<number>()

/**
 * The page's own total, and the point past which nothing more is copied.
 *
 * Deliberately a page global and not a worker field: a worker global does not survive the
 * service worker being torn down, and a cap that silently resets is not a cap.
 */
let pageBytes = 0
let copyingStopped = false

let nextStreamId = 1
let installedToken: string | null = null
let installedPageUrl: string | null = null
let patchesApplied = false

/**
 * Set when a newer injection has taken the page.
 *
 * The prototypes cannot be unwrapped, because restoring them means restoring whatever the
 * page had before this hook ran, and a hook that keeps copying is far worse than one that
 * keeps a wrapper. So a stale hook gives up its bytes and its voice instead, which is the
 * part that actually costs a tab its memory.
 */
let stoodDown = false
let lastSignals: PageStream[] | null = null
let sizeMoved = false

/**
 * The unpatched address maker, kept because the hook mints addresses of its own when it
 * assembles a file. Calling the patched one would record the file we just built as a new
 * stream, so the popup would gain a row every time a download succeeded.
 */
const nativeCreateObjectURL = URL.createObjectURL.bind(URL)
const nativeRevokeObjectURL = URL.revokeObjectURL.bind(URL)

// ─── Reporting ──────────────────────────────────────────────────────────────

/**
 * Posts to this window only.
 *
 * The target origin is a formality for a same window post: nothing else receives it. The
 * payload is a count and a token that belongs to this page, so there is nothing here a
 * receiver could use.
 */
function post(message: unknown): void {
  window.postMessage(message, '*')
}

/**
 * The bucket a reported size falls in, which is what decides whether it is worth sending.
 *
 * Rounding happens here rather than on the reported value, and that is the whole point: the
 * popup renders a size to one decimal place, so a change inside one bucket cannot be seen,
 * while the number the row shows has to stay the real one. A small file rounded down to
 * its bucket would show as nothing at all.
 */
function sizeBucket(bytes: number): number {
  return Math.floor(bytes / SIZE_BUCKET_BYTES)
}

/**
 * What the player's own buffers report buffered.
 *
 * The browser maintains these ranges and the page can only read them, which is why this
 * is where a row's appearance comes from rather than from how far playback has got. A
 * paused element never passes its metadata, so a video nobody pressed play on would
 * otherwise never be listed at all.
 *
 * A blob reports its own size, because the object is complete the moment it exists and
 * has no gathering phase to report on.
 */
function bufferedBytesFor(stream: HeldStream): number {
  if (stream.origin === 'blob') return stream.bytes

  const buffers = stream.mediaSource?.sourceBuffers
  if (!buffers) return 0

  let total = 0
  for (let index = 0; index < buffers.length; index += 1) {
    const ranges = buffers[index].buffered
    for (let range = 0; range < ranges.length; range += 1) {
      total += ranges.end(range) - ranges.start(range)
    }
  }
  return total
}

/**
 * The name to fall back to when a page has no title.
 *
 * Two sources, and both have to be refused in the cases that would produce nonsense. A
 * `File` is a `Blob` that carries the name the page itself gave the media, which is the
 * only object on this path that has one: a blob address is a uuid, so a name read off it
 * would be `<uuid>` on every row of a page. An element's own address is used only when it
 * is a real one, for the site that hands a player an http address of its own.
 *
 * Four lines of a rule rather than the engine's own, because the engine's filename module
 * cannot be used from here: the hook is its own bundle and is not allowed to reach into the
 * shared rules. The rule it would be duplicating answers a different question anyway, since
 * this reads what the page named its media and not what a finding is called.
 */
function mediaElementNameOf(address: string, blob: Blob | null): string | null {
  if (typeof File !== 'undefined' && blob instanceof File && blob.name) {
    return withoutExtension(blob.name)
  }

  let parsed: URL
  try {
    parsed = new URL(address, document.baseURI)
  } catch {
    return null
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return withoutExtension(decodeURIComponent(parsed.pathname.slice(parsed.pathname.lastIndexOf('/') + 1)))
}

/** The last path segment with its own extension taken off, because step three puts one back. */
function withoutExtension(segment: string): string | null {
  const dot = segment.lastIndexOf('.')
  const name = dot > 0 ? segment.slice(0, dot) : segment
  return name || null
}

/**
 * Binds the page's players to the streams they are playing.
 *
 * Matched by address rather than by anything the page tells us, because a page has no
 * reason to say. Run on the report tick rather than on every chunk, since it walks the
 * document and an append happens thousands of times a stream.
 */
function refreshMediaElements(): void {
  const players = document.querySelectorAll('video, audio')

  for (const player of players) {
    const element = player as HTMLMediaElement
    const streamId = addressStreams.get(element.currentSrc)
    if (streamId === undefined) continue

    const stream = streams.get(streamId)
    if (!stream) continue

    stream.mediaElementName = mediaElementNameOf(element.currentSrc, stream.blob)
    // Never on the blob path, where the object is complete the moment it exists, so an
    // endless blob is not a thing.
    if (stream.origin === 'mse') {
      stream.live = element.duration === Number.POSITIVE_INFINITY
    }
  }
}

/** Everything the page observed, as the raw signals the engine reads. */
function snapshot(): PageStream[] {
  return [...streams.values()]
    .sort((left, right) => left.streamId - right.streamId)
    .map((stream) => ({
      streamId: stream.streamId,
      origin: stream.origin,
      mimeType: stream.mimeType,
      bytes: stream.bytes,
      bufferedBytes: bufferedBytesFor(stream),
      live: stream.live,
      encrypted: stream.encrypted,
      ended: stream.ended,
      partialReason: stream.partialReason,
      mediaElementName: stream.mediaElementName,
    }))
}

/**
 * Whether anything but the two byte counts moved, which is the part that travels at once.
 *
 * The byte counts are held back deliberately. Both of them move on every chunk, so treating
 * either as a signal would turn a stream of thousands of chunks into thousands of writes,
 * and `bufferedBytes` is a size rather than a verdict: what it is read for is whether it is
 * above zero, which is a separate question answered below.
 */
function sameShape(left: PageStream, right: PageStream): boolean {
  return (
    left.streamId === right.streamId &&
    left.origin === right.origin &&
    left.mimeType === right.mimeType &&
    left.live === right.live &&
    left.encrypted === right.encrypted &&
    left.ended === right.ended &&
    left.partialReason === right.partialReason &&
    left.mediaElementName === right.mediaElementName
  )
}

/**
 * Whether a stream has just started holding bytes, or stopped.
 *
 * The one byte count change that cannot wait. It is what makes a row appear at all, so a
 * stream that went from holding nothing to holding something is reported straight away
 * while the rest of its growth waits for the tick.
 */
function crossedZero(left: number, right: number): boolean {
  return left <= 0 !== right <= 0
}

function report(): void {
  if (installedToken === null || stoodDown) return
  post({
    source: PAGE_CHANNEL_SOURCE,
    type: 'streams',
    token: installedToken,
    pageUrl: installedPageUrl,
    streams: snapshot(),
  })
}

/**
 * Reports only when something worth reporting moved.
 *
 * A signal reports at once, because a row appearing or a stream turning partial is not
 * something to make someone wait a second for. A size alone waits for the tick, because
 * it is the one field that moves on every chunk.
 */
function reportIfChanged(): void {
  const next = snapshot()
  const previous = lastSignals
  lastSignals = next

  if (previous === null || previous.length !== next.length) {
    report()
    return
  }

  const shapeMoved = next.some((stream, index) => !sameShape(stream, previous[index] as PageStream))
  const startedOrStopped = next.some((stream, index) =>
    crossedZero(stream.bufferedBytes, previous[index]?.bufferedBytes ?? 0)
  )

  if (shapeMoved || startedOrStopped) {
    report()
    return
  }

  const bucketMoved = next.some((stream, index) => {
    const before = previous[index]
    if (!before) return true
    return (
      sizeBucket(stream.bytes) !== sizeBucket(before.bytes) ||
      sizeBucket(stream.bufferedBytes) !== sizeBucket(before.bufferedBytes)
    )
  })
  if (bucketMoved) sizeMoved = true
}

// ─── Holding the streams ────────────────────────────────────────────────────

function holdStream(
  streamId: number,
  origin: StreamOrigin,
  mimeType: string,
  extra: Partial<HeldStream> = {}
): HeldStream {
  const stream: HeldStream = {
    streamId,
    origin,
    mimeType,
    bytes: 0,
    live: false,
    encrypted: false,
    ended: false,
    partialReason: 'none',
    mediaElementName: null,
    chunks: [],
    blob: null,
    address: null,
    mediaSource: null,
    ...extra,
  }
  streams.set(streamId, stream)
  return stream
}

/** The id for a MediaSource, minting one the first time it is seen. */
function streamIdFor(mediaSource: MediaSource): number {
  const existing = mediaSourceIds.get(mediaSource)
  if (existing !== undefined) return existing

  const streamId = nextStreamId
  nextStreamId += 1
  mediaSourceIds.set(mediaSource, streamId)
  return streamId
}

function streamIdForBlob(blob: Blob): number {
  const existing = blobIds.get(blob)
  if (existing !== undefined) return existing

  const streamId = nextStreamId
  nextStreamId += 1
  blobIds.set(blob, streamId)
  return streamId
}

/**
 * Records that a stream stopped being savable in full, once, and never clears it.
 *
 * Latching is what makes the pair honest, because bytes already copied cannot be
 * uncopied: the only state a stream that has lost bytes can honestly be in is the one it
 * lost them in. A later append that succeeds does not put them back.
 */
function latch(streamId: number, reason: Exclude<PartialReason, 'none'>): void {
  const stream = streams.get(streamId)
  if (!stream || latched.has(streamId)) return

  latched.add(streamId)
  stream.partialReason = reason
}

/**
 * Copies one chunk, or declines to.
 *
 * Declining rather than throwing is the whole of the hook's manners: the player's own
 * append still goes through, so a person watching a stream never feels the extension
 * spending their tab's memory on them.
 */
function copyChunk(streamId: number, bytes: Uint8Array<ArrayBuffer>): boolean {
  if (stoodDown || copyingStopped) return false

  if (capWouldBeCrossed(pageBytes, bytes.byteLength)) {
    // The stop is page wide and the latch is not, and both are right. Every stream on the
    // page stops growing, or the cap bounds nothing. Only the stream whose own bytes were
    // declined is marked partial, because a stream that had already ended before the cap
    // was reached still holds a whole file and saying otherwise would be a lie.
    copyingStopped = true
    latch(streamId, 'page_cap')
    return false
  }

  const stream = streams.get(streamId)
  if (!stream) return false

  stream.chunks.push(bytes)
  stream.bytes += bytes.byteLength
  pageBytes += bytes.byteLength
  return true
}

// ─── Patching the page ──────────────────────────────────────────────────────

/**
 * Wraps the three methods that are the whole of the interception.
 *
 * The prototypes are patched rather than the constructors replaced, so a site that
 * captured `MediaSource` before this ran is still caught. Only three methods are touched:
 * every extra patch is another chance to change how a player's own code behaves.
 */
function applyPatches(): void {
  const mediaSourcePrototype = MediaSource.prototype
  const sourceBufferPrototype = SourceBuffer.prototype

  const nativeAddSourceBuffer = mediaSourcePrototype.addSourceBuffer
  mediaSourcePrototype.addSourceBuffer = function addSourceBuffer(
    this: MediaSource,
    mimeType: string
  ): SourceBuffer {
    const buffer = nativeAddSourceBuffer.call(this, mimeType)
    const streamId = streamIdFor(this)

    bufferStreams.set(buffer, streamId)
    const stream = streams.get(streamId)
    if (stream) {
      stream.mediaSource = this
      // A player that adds a buffer for the same stream replaces the row rather than
      // adding one, and separate audio and video buffers share the one id.
      if (!stream.mimeType) stream.mimeType = mimeType
    } else {
      holdStream(streamId, 'mse', mimeType, { mediaSource: this })
    }

    buffer.addEventListener('encrypted', () => {
      const held = streams.get(streamId)
      if (held) held.encrypted = true
      reportIfChanged()
    })

    this.addEventListener('sourceended', () => {
      const held = streams.get(streamId)
      if (held) held.ended = true
      reportIfChanged()
    })

    // A stream appearing is a signal, not a size, so it travels at once. Waiting for the
    // tick would put a row a second behind the player that made it.
    reportIfChanged()
    return buffer
  }

  const nativeAppendBuffer = sourceBufferPrototype.appendBuffer
  sourceBufferPrototype.appendBuffer = function appendBuffer(
    this: SourceBuffer,
    data: BufferSource
  ): void {
    const streamId = bufferStreams.get(this)

    try {
      // Chrome returns a promise from here and the DOM types say nothing comes back, so
      // both are wrapped rather than one assumed. A player awaits it, and the copy below
      // has to happen after the browser has taken the bytes or a refused append leaves a
      // hole in what we hold.
      const settled = Promise.resolve(nativeAppendBuffer.call(this, data))
      if (streamId === undefined) return

      // The copy itself cannot fail the page: it is wrapped, and failing to copy is not
      // failing to play.
      void settled
        .then(() => {
          copyChunk(streamId, toBytes(data))
          reportIfChanged()
        })
        .catch((reason: unknown) => {
          // An append the browser refused leaves a hole in the bytes we already copied, so
          // the stream can no longer be reassembled into a whole file whichever way it
          // failed. The browser's own quota is named apart from the rest because a person
          // can act on that one differently.
          latch(streamId, isQuotaRefusal(reason) ? 'browser_quota' : 'broken')
          reportIfChanged()
        })
    } catch (reason) {
      // Chrome throws a quota refusal out of `appendBuffer` synchronously, and the page
      // handles it, so it is rethrown after the latch. Swallowing it would change how a
      // player's own code behaves, which is the one thing this hook must never do.
      if (streamId !== undefined) {
        latch(streamId, isQuotaRefusal(reason) ? 'browser_quota' : 'broken')
        reportIfChanged()
      }
      throw reason
    }
  }

  const nativeAbort = sourceBufferPrototype.abort
  sourceBufferPrototype.abort = function abort(this: SourceBuffer): void {
    nativeAbort.call(this)
    const streamId = bufferStreams.get(this)
    if (streamId !== undefined) {
      latch(streamId, 'broken')
      reportIfChanged()
    }
  }

  URL.createObjectURL = function createObjectURL(object: Blob | MediaSource): string {
    const address = nativeCreateObjectURL(object)

    if (typeof Blob !== 'undefined' && object instanceof Blob) {
      recordBlob(object, address)
    } else if (isMediaSource(object)) {
      // A MediaSource is addressed exactly as often as it is played, and this is the only
      // link between the player and the stream it is playing.
      addressStreams.set(address, streamIdFor(object))
    }

    return address
  }
}

/**
 * Whether a refusal was the browser's own per buffer quota.
 *
 * Named apart from any other failure because a person who hits it can free space and try
 * again, where a player that walked away is not something they can act on.
 */
function isQuotaRefusal(reason: unknown): boolean {
  return (
    typeof reason === 'object' &&
    reason !== null &&
    'name' in reason &&
    (reason as { name?: unknown }).name === 'QuotaExceededError'
  )
}

function isMediaSource(value: unknown): value is MediaSource {
  return typeof MediaSource !== 'undefined' && value instanceof MediaSource
}

/**
 * The append's bytes as one array.
 *
 * Copied rather than viewed, so what is held is never a window onto a buffer the player
 * may reuse. The element type names a plain `ArrayBuffer` because that is what a `Blob`
 * will accept, and a chunk that cannot be joined into a file is not worth holding.
 */
function toBytes(data: BufferSource): Uint8Array<ArrayBuffer> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) {
    // The view's own bytes rather than a window onto them, because what is held must not
    // change under us if the player reuses the buffer it appended from. A view's
    // `byteLength` is already a count of bytes, which is what a `Uint8Array` counts in.
    return new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength)
  }
  return new Uint8Array(0)
}

/**
 * Holds a finished object the page built in memory.
 *
 * Only a video or audio type is admitted, because anything else a page addresses is
 * something else entirely and would be listed as media on no evidence.
 */
function recordBlob(blob: Blob, address: string): void {
  const type = (blob.type || '').toLowerCase()
  if (!type.startsWith('video/') && !type.startsWith('audio/')) return

  const streamId = streamIdForBlob(blob)
  const existing = streams.get(streamId)
  if (existing) {
    // The same object addressed twice is one stream. A page that revokes and re-addresses
    // a finished file is still one file, and two rows for it would be a page with a
    // duplicated entry for no reason a person could explain.
    addressStreams.set(address, streamId)
    return
  }

  holdStream(streamId, 'blob', blob.type, {
    blob,
    address,
    bytes: blob.size,
  })
  addressStreams.set(address, streamId)
  // A finished file needs no gathering, so it is savable the moment it exists and the row
  // appears now rather than on the next tick.
  reportIfChanged()
}

// ─── Producing the file ─────────────────────────────────────────────────────

/**
 * Clicks a link to an address, which is how the page starts a download.
 *
 * A click on a link rather than any extension API, because this runs in the page's world
 * and shares `window` with the site: there is nothing here the extension needs to be
 * trusted to do, and the bytes never leave the page. Whether Chrome allows it without a
 * fresh gesture in this page is the assumption the whole slice rests on, and it is
 * proven in a real browser before anything else is built on it.
 */
function startDownload(address: string, filename: string | undefined): void {
  const anchor = document.createElement('a')
  anchor.href = address
  // Only set when there is a name. An empty `download` makes the browser invent one from
  // the address, which for a blob is a uuid.
  if (filename) anchor.download = filename
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
}

/**
 * The media type on its own, with any codec parameters dropped.
 *
 * A `SourceBuffer` names itself as `video/webm; codecs="vp8, vorbis"`, which is the right
 * thing to hand to `addSourceBuffer` and the wrong thing to declare on a file. A blob's type
 * is a single media type, and a saved file that claims codecs it may not carry is a small
 * lie that some tools believe.
 */
function mediaTypeOf(mimeType: string): string {
  return mimeType.split(';')[0]?.trim() || mimeType
}

/** Joins an mse stream's copied chunks into one address the page can hand over. */
function assembleAddress(stream: HeldStream): string {
  if (stream.origin === 'blob' && stream.address) return stream.address

  const file = new Blob(stream.chunks, { type: mediaTypeOf(stream.mimeType) })
  // The unpatched address maker, so the file this build just produced is not itself
  // recorded as a new stream and the popup gains a row per successful download.
  const address = nativeCreateObjectURL(file)
  window.setTimeout(() => nativeRevokeObjectURL(address), REVOKE_AFTER_MS)
  return address
}

function answer(streamId: number, ok: boolean, error?: StreamAssembleError): void {
  post({
    source: PAGE_CHANNEL_SOURCE,
    type: 'assembled',
    token: installedToken,
    streamId,
    ok,
    ...(error ? { error } : {}),
  })
}

/**
 * Produces the file for one stream and hands it to the browser.
 *
 * `already_running` is real even though the work is synchronous, because the click and
 * the address minting both happen in one turn and two clicks can land in it. The flag is
 * held until the browser has had a turn, which is as long as this can honestly say a
 * download is under way.
 */
function assemble(streamId: number, filename: string | undefined): void {
  const stream = streams.get(streamId)

  if (assembling.has(streamId)) {
    answer(streamId, false, 'already_running')
    return
  }
  if (!stream || stream.bytes <= 0) {
    answer(streamId, false, 'no_bytes')
    return
  }

  assembling.add(streamId)
  try {
    startDownload(assembleAddress(stream), filename)
    answer(streamId, true)
  } catch {
    // A page whose document has gone, or whose body has been removed, cannot be clicked.
    // It is answered rather than thrown, because the row is waiting on this answer.
    answer(streamId, false, 'no_bytes')
  } finally {
    window.setTimeout(() => assembling.delete(streamId), 0)
  }
}

// ─── Installing ─────────────────────────────────────────────────────────────

/**
 * Gives up the page to a newer injection.
 *
 * The bytes go first, because that is what a tab's memory is made of here. Everything the
 * hook held is dropped at once rather than stream by stream, since none of it can be reached
 * any more: the reports carrying it are refused and no row points at it.
 */
function standDown(): void {
  stoodDown = true;
  streams.clear();
  addressStreams.clear();
  latched.clear();
  assembling.clear();
  pageBytes = 0;
  copyingStopped = false;
  lastSignals = null;
}

function install(nextToken: string, nextPageUrl: string): void {
  // A hook already installed keeps the token it was given. A different one means a newer
  // injection has taken the page, which is the case the token exists for: a hook left over
  // from a previous build is still on the page and still receiving these messages, and if it
  // could adopt the current token it would report under it and every report the content
  // script drops would be one this let through.
  //
  // It also has to let go. This hook's wrappers are still underneath the new one's, so it is
  // still handed every chunk the page appends, and a hook that has been replaced but keeps
  // copying holds up to the page's whole cap in memory that nothing will ever read.
  if (installedToken !== null && installedToken !== nextToken) {
    standDown()
    return
  }

  // The same injection asking twice, which happens because both sides say hello. There is
  // nothing to add, and reporting again would be a write for no change.
  if (patchesApplied && installedPageUrl === nextPageUrl) return

  installedPageUrl = nextPageUrl

  // Already installed with this token, on a page url that has moved. A single page app
  // navigated without a reload and the streams are still live, so returning early would
  // drop them from the list.
  if (patchesApplied) {
    refreshMediaElements()
    lastSignals = null
    report()
    return
  }

  installedToken = nextToken
  patchesApplied = true
  applyPatches()
  window.setInterval(() => {
    refreshMediaElements()
    // A size on its own waits for here, so a stream of thousands of chunks does not
    // become thousands of writes and broadcasts.
    if (sizeMoved) {
      sizeMoved = false
      report()
      return
    }
    reportIfChanged()
  }, REPORT_INTERVAL_MS)

  lastSignals = null
  report()
}

/**
 * The key this build stamps itself under on the page.
 *
 * A page's globals are shared with this script, so the key is prefixed to be unlikely to
 * collide with anything the site set. It is what makes a second injection of the same
 * build do nothing at all: without it a second copy would wrap the same prototypes again,
 * and every chunk would be copied twice into two sets of memory.
 */
const STAMP_KEY = '__videoVortexHookBuild'

/**
 * Claims this page for the build running now, or reports it is already claimed.
 *
 * The same two cases the content script's own stamp covers, and for the same reason: a
 * page still running the previous build's hook must keep reporting under its old token,
 * which the content script drops, rather than being silently replaced.
 */
function claimPage(): boolean {
  const globals = globalThis as Record<string, unknown>
  if (globals[STAMP_KEY] === STAMP_KEY) return false

  globals[STAMP_KEY] = STAMP_KEY
  return true
}

if (claimPage()) {
  window.addEventListener('message', onPageMessage)
  // Said as well as asked. The content script posts its install on load, but the two files
  // are injected separately and either may arrive second, so a hook that loads after that
  // post would otherwise wait for an install that has already been delivered to a window it
  // was not listening on yet.
  post({ source: PAGE_CHANNEL_SOURCE, type: 'hello' })
}

function onPageMessage(event: MessageEvent): void {
  // Every message on the page reaches this listener, and no attempt is made to tell a
  // same window post from a frame posting in. What decides is the token below: it is
  // minted per injection by the content script, and a page or a frame that has not seen it
  // cannot produce a command this hook will act on. Checking the sender instead would be
  // security theatre that also breaks wherever `event.source` is not the window itself.
  const command = parseHookCommand(event.data)
  if (!command) return

  if (command.type === 'install') {
    install(command.token, command.pageUrl)
    return
  }

  // An assembly request carrying a token this hook was not installed with is from a
  // previous injection or a previous build, and is ignored rather than answered.
  if (command.token !== installedToken) return
  assemble(command.streamId, command.filename)
}