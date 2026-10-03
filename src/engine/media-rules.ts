// Owns how an observation becomes a verdict: a response's container and kind,
// whether a container can be saved as a file, and what a stream's reported signals
// mean. Pure, so the popup can ask the same question about a row the worker recorded
// hours and one worker restarts ago.
//
// The path extension is asked before the content type because a CDN path is what a
// site controls, and the header is what a server guesses. The other order makes a
// mislabelled `video/mp4` on a `.ts` segment win over the name that says what it is.
//
// The stream state machine lives here rather than in a module of its own because it
// answers the same question as `isDownloadable`: is this worth showing, and can it be
// saved. Splitting them put one verdict in two files.

import type {
  MediaEntry,
  MediaKind,
  PartialReason,
  PlaylistSignals,
  PlaylistState,
  StreamSignals,
  StreamState,
} from './types'

/**
 * Content type to container.
 *
 * Spec 0001 requires this map to exist and never enumerates it, so the values here
 * are the ones spec 0004 fixes. Anything absent lands on `unknown`, which is a
 * legitimate answer rather than a failure: the file is still listed, it just cannot
 * be named.
 */
const CONTENT_TYPE_CONTAINERS: Record<string, string> = {
  'video/mp4': 'mp4',
  'audio/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/webm': 'webm',
  'video/ogg': 'ogg',
  'audio/ogg': 'ogg',
  'application/ogg': 'ogg',
  'video/mpeg': 'mpeg',
  'audio/mpeg': 'mpeg',
  'video/quicktime': 'mov',
  'application/vnd.apple.mpegurl': 'm3u8',
  'application/x-mpegurl': 'm3u8',
  'application/dash+xml': 'mpd',
}

/**
 * Every container this extension can name.
 *
 * `isDownloadable` and the file name rule's extension step both read it, so a
 * container added here is savable and nameable at once rather than one and not the
 * other.
 */
export const KNOWN_CONTAINERS: readonly string[] = [
  'mp4',
  'webm',
  'ogg',
  'mpeg',
  'mov',
  'm4v',
  'mkv',
  'avi',
  'flv',
  'wav',
  'aac',
  'flac',
  'opus',
  'm3u8',
  'mpd',
]

/**
 * Containers that describe other files rather than being one.
 *
 * An HLS playlist and a DASH manifest are text that points at segments, so saving
 * one as a file hands a person a file that will not play. They stay listed, because
 * knowing a page is streaming something is useful, and they carry no download
 * control, because offering one would be a lie.
 */
const MANIFEST_CONTAINERS: readonly string[] = ['m3u8', 'mpd']

/** Containers that carry audio and nothing else, so the row belongs in the audio list. */
const AUDIO_ONLY_CONTAINERS: readonly string[] = ['wav', 'aac', 'flac', 'opus']

/**
 * Whether a status code means the response actually delivered the file.
 *
 * Exported because the worker has to ask this before it looks at anything else in a
 * response, and one definition of "a success" is worth more than two that can drift.
 */
export function isSuccessStatus(statusCode: number | undefined): boolean {
  return typeof statusCode === 'number' && statusCode >= 200 && statusCode < 300
}

/** The media type a content type names, with any parameters dropped. */
function mediaTypeOf(contentType: string | undefined | null): string | undefined {
  if (!contentType) return undefined
  const media = contentType.split(';')[0]?.trim().toLowerCase()
  return media || undefined
}

/**
 * The extension in the URL's own path, or null when there is none.
 *
 * The query string is ignored on purpose. `?format=mp4` is not a file extension, and
 * treating it as one is how a tracking query on a segmentless path gets named a
 * container it does not have.
 */
export function containerFromPath(url: string): string | null {
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    return null
  }

  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1)
  const dot = lastSegment.lastIndexOf('.')
  if (dot <= 0) return null

  const extension = lastSegment.slice(dot + 1).toLowerCase()
  if (!/^[a-z0-9]+$/.test(extension)) return null
  return extension
}

/**
 * The container for a response: the path extension, else the content type's map
 * entry, else `unknown`.
 */
export function containerFor(url: string, contentType?: string | null): string {
  const fromPath = containerFromPath(url)
  if (fromPath) return fromPath

  const media = mediaTypeOf(contentType)
  return (media && CONTENT_TYPE_CONTAINERS[media]) || 'unknown'
}

/**
 * Video or audio, from the content type when it says so and from the container
 * otherwise.
 *
 * The content type leads because it is the only one of the two that distinguishes
 * an audio only mp4 from a video mp4, and the popup's two lists are built on this.
 */
export function kindFor(container: string, contentType?: string | null): MediaKind {
  const media = mediaTypeOf(contentType)
  if (media?.startsWith('audio/')) return 'audio'

  if (AUDIO_ONLY_CONTAINERS.includes(container.toLowerCase())) return 'audio'
  return 'video'
}

/** Whether this container is one Chrome can save as a single playable file. */
function isKnownSavableContainer(container: string): boolean {
  const known = container.toLowerCase()
  return KNOWN_CONTAINERS.includes(known) && !MANIFEST_CONTAINERS.includes(known)
}

/**
 * Whether this entry can be saved, and so carries a download control.
 *
 * Takes the entry rather than the container, which is the signature change spec 0005 asks
 * for. A container alone cannot answer it: a live broadcast and a stream the page capped are
 * both `webm`, both perfectly savable containers, and neither can be handed to a person as a
 * file. A stream answers through its derived state instead, which is why the row and the
 * worker cannot disagree about it.
 *
 * The container still has to be one we can name, for a stream as much as for a file. A row
 * whose container is unknown gets no control, because the file could not be given an
 * extension and would arrive with no name.
 */
export function isDownloadable(
  entry: Pick<MediaEntry, 'container' | 'stream' | 'playlist'>
): boolean {
  // A manifest entry answers through its playlist signals. The container check below
  // would refuse every one of them, because `m3u8` and `mpd` are manifest containers,
  // and that refusal was the point for the whole of spec 0004. The assemblable case is
  // the one exception this feature exists to add.
  if (entry.playlist) {
    return derivePlaylistState(entry.playlist) === 'assemblable'
  }
  if (!isKnownSavableContainer(entry.container)) return false
  if (!entry.stream) return true
  return isStreamSavable(deriveStreamState(entry.stream))
}

/** Which `PartialReason` becomes which `StreamState`. One sentence each, by design. */
const PARTIAL_STATES: Record<Exclude<PartialReason, 'none'>, StreamState> = {
  page_cap: 'partial_capped',
  browser_quota: 'partial_browser_quota',
  broken: 'partial_broken',
}

/**
 * What a stream's signals mean, in one place and provable with no browser.
 *
 * The page observes and reports; this decides. The order is the contract and each
 * position earns it:
 *
 * `encrypted` first, because scrambled bytes are never worth a row whatever else is
 * true of the stream.
 *
 * Then the three partial states, because a stream that has lost bytes has something
 * to say whether or not it ever played and whether or not it is live. A capped live
 * broadcast is exactly the case that would otherwise sit on 512 MB of a tab's memory
 * saying only that it is endless.
 *
 * Then `live`, because an endless stream has no file at any size.
 *
 * Then `assembling`, because a stream holding nothing yet has nothing to describe.
 *
 * Then `ended` before `playable`, and partial before ended: a stream that both lost
 * bytes and ended is a broken file of full length, and "partial" is the more useful
 * of the two things to tell someone.
 */
export function deriveStreamState(signals: StreamSignals): StreamState {
  if (signals.encrypted) return 'encrypted'
  if (signals.partialReason !== 'none') return PARTIAL_STATES[signals.partialReason]
  if (signals.live) return 'live'
  if (signals.bufferedBytes <= 0) return 'assembling'
  if (signals.ended) return 'ended'
  return 'playable'
}

/**
 * What a playlist's signals mean, in one place and provable with no browser.
 *
 * The page reads the playlist and reports what it found; this decides. Mirrors
 * `deriveStreamState` so there is one pattern in the codebase for how a page's
 * observations become a row. The order is the contract and each position earns it:
 *
 * `encrypted` first, because scrambled bytes are never worth a control whatever else is
 * true, the same reason the stream rule puts it first.
 *
 * Then `byte_ranged`, because it is a statement about what the page saw that this feature
 * never builds a file from.
 *
 * Then the manifest is checked. Anything that is not HLS is not assembled here at all,
 * because DASH plays through the path spec 0005 owns and an unrecognised manifest might
 * be either. Saying so is more honest than attempting a join nobody validated.
 *
 * Then the segment container. MPEG-TS joins into a file Chrome will not open, which is the
 * reason it is a labelled case rather than an assembled one.
 *
 * Then `live`, because an endless playlist has no whole file at any size.
 *
 * Then `assemblable`.
 */
export function derivePlaylistState(signals: PlaylistSignals): PlaylistState {
  if (signals.encrypted) return 'encrypted'
  if (signals.byteRanged) return 'byte_ranged'
  if (signals.manifest !== 'hls') return 'unsupported_container'
  if (signals.segments !== 'mp4') return 'unsupported_container'
  if (signals.live) return 'live'
  return 'assemblable'
}

/**
 * Whether this entry belongs in the list at all.
 *
 * Two of the eight states are not worth a row. A stream still collecting holds nothing yet,
 * so there is nothing true to say about it, and an encrypted one has bytes that cannot be
 * reassembled into anything playable. A stream that has lost bytes *does* get a row even
 * though it never played, because that is precisely the moment a person needs telling.
 *
 * Asked in the worker, so the record, the badge and the count all agree with the list, and
 * again in the popup, so a record written by a build before this rule cannot put a row on
 * screen that the engine says has nothing to say. One rule, two readers.
 */
export function isListable(entry: Pick<MediaEntry, 'stream' | 'playlist'>): boolean {
  if (entry.stream) {
    const state = deriveStreamState(entry.stream)
    return state !== 'assembling' && state !== 'encrypted'
  }
  // A playlist is always listable: however the page read it, the row has something to
  // say, even if what it says is that the page refused or the thing is encrypted.
  return true
}

/**
 * The label a stream row carries.
 *
 * Never read off the stream's url. A `blob:` address ends in a uuid, so every row on a page
 * would carry the same label and a person could not tell them apart. The id is what tells
 * two streams on one page apart, and the origin is in the label because it is the difference
 * a person can act on: a blob is already a whole file and saves at once, while a MediaSource
 * stream is still being assembled and takes a moment.
 */
export function labelForStream(signals: StreamSignals): string {
  return signals.origin === 'mse'
    ? `Stream ${signals.streamId}`
    : `Whole file ${signals.streamId}`
}

/**
 * Whether a stream in this state can be saved, and so carries a download control.
 *
 * A live row and each partial row say no, which is what keeps an endless stream from
 * being offered a download that would never finish and keeps a truncated file from
 * being offered as though it were the whole thing.
 */
export function isStreamSavable(state: StreamState): boolean {
  return state === 'playable' || state === 'ended'
}

/**
 * The size the response stated, or null.
 *
 * Null whenever the response states none, is not a success, or carries a
 * `Content-Encoding`. That last case is the important one: `Content-Length` then
 * describes the compressed body, so reporting it would show a size that is not the
 * file's. Never computed from anything else.
 */
export function sizeBytesFrom(
  headers: Record<string, string> | undefined,
  statusCode: number | undefined
): number | null {
  if (!headers || !isSuccessStatus(statusCode)) return null

  // Chrome reports header names as sent, so `Content-Length` and `content-length`
  // both occur. Reading case insensitively is the difference between a row that
  // shows its size and one that says "Size unknown" on a perfectly good response.
  const lower = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]))
  if (lower.has('content-encoding')) return null

  const parsed = Number(lower.get('content-length'))
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

/** Whether this response is a media file the popup should list at all. */
export function isMediaResponse(
  statusCode: number | undefined,
  contentType: string | undefined | null
): boolean {
  if (!isSuccessStatus(statusCode)) return false

  const media = mediaTypeOf(contentType)
  return Boolean(media && (media.startsWith('video/') || media.startsWith('audio/')))
}
