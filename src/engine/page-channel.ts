// Owns the channel between the page and the content script: the four messages that
// cross it and the schemas that parse them.
//
// This is the only interface the page hook has. It reaches the page through
// `window.postMessage`, because a content script and a page share the DOM but not a
// JavaScript global, and that shared event bus is the one crossing point available.
// So the channel is documented and shaped here like every other boundary in the
// extension, rather than left as two halves that happen to agree.
//
// Everything on it is parsed with zod by the content script, for the reason every other
// boundary here is: the page can post anything at all, and a payload that type checks is
// not one that is valid. The hook itself parses the two messages it receives, because
// the page is equally untrusted from its side.

import { z } from 'zod'

import { STREAM_EXTRACTOR_ID, STREAM_EXTRACTOR_REASON, streamEntryUrl } from './identity'
import { StreamAssembleErrorSchema } from './messages'
import { containerFor, kindFor } from './media-rules'
import { StreamSignalsSchema, type MediaEntryDraft, type StreamSignals } from './types'

/**
 * The marker every message on this channel carries.
 *
 * A page's own `postMessage` traffic reaches the same listener, so the shape of the
 * message cannot be the test for whether it is ours. A namespaced string can, and one
 * that is unlikely to collide is worth more than one that reads nicely.
 */
export const PAGE_CHANNEL_SOURCE = 'video-vortex'

/**
 * How many stream bytes one page may hold, across every MediaSource stream on it.
 *
 * A cap that let the other streams carry on growing would not bound the tab's memory, so
 * it would not be a cap. Stated here rather than in the hook because the number is a
 * decision about what this extension costs a person's browser, and the hook is the only
 * party that can act on it while an append is happening.
 */
export const PAGE_STREAM_BYTE_CAP = 512 * 1024 * 1024

/**
 * Whether one more chunk would cross the cap.
 *
 * The equality case counts as crossing. A cap is a line, and a chunk that lands exactly on
 * it has taken the whole budget, so the next one is the first that is refused. Kept as a
 * function of three numbers so the rule is provable at the boundary without holding half
 * a gigabyte in a test.
 */
export function capWouldBeCrossed(
  pageBytes: number,
  incomingBytes: number,
  cap: number = PAGE_STREAM_BYTE_CAP
): boolean {
  return pageBytes + incomingBytes >= cap
}

/**
 * What the page observed about one stream: the engine's own signals plus one raw string.
 *
 * `mimeType` is the extra field, and it is raw on purpose. The `SourceBuffer`'s MIME type
 * and the `Blob`'s type are the only thing that can name a container for a stream, since a
 * stream has no address and no path to read an extension off. Turning one into the other
 * is a decision, so it happens in the content script rather than here.
 */
export const PageStreamSchema = StreamSignalsSchema.extend({
  mimeType: z.string(),
})
export type PageStream = z.infer<typeof PageStreamSchema>

/**
 * The hook announcing that it is listening.
 *
 * The two files are injected separately and the order is not ours to rely on: the worker
 * puts the content script on the page and then the hook, a `postMessage` is delivered on a
 * later task, and either file may be the one that arrives second. So each side says hello
 * as well as asking. Without this the install could be posted into a window the hook has
 * not attached to yet, and the page would report nothing for the life of the tab.
 */
export const HelloPageSchema = z.object({
  source: z.literal(PAGE_CHANNEL_SOURCE),
  type: z.literal('hello'),
})
export type HelloPageMessage = z.infer<typeof HelloPageSchema>

/**
 * What one page observation becomes as a finding.
 *
 * A translation and not a judgement, which is why it lives here rather than in the content
 * script that calls it: it is the same shape in every runtime that reads a report, and it
 * decides no state at all. The container is the one thing worth explaining, because a
 * stream has no path to read an extension off and the MIME type is all there is. Handing
 * the minted url to `containerFor` is safe precisely because that url can never end in
 * something a path rule could read, which is what the percent encoding above is for.
 */
export function pageStreamToDraft(stream: PageStream, pageUrl: string): MediaEntryDraft {
  const url = streamEntryUrl(pageUrl, stream.streamId)
  const container = containerFor(url, stream.mimeType)

  // Spelled out one field at a time rather than spread, on purpose. A signal added to the
  // schema then fails to compile here until someone decides whether the page reports it and
  // what it means, which is the moment to have that conversation. A rest spread would carry
  // the new field silently and put a value on the wire nobody had looked at.
  const signals: StreamSignals = {
    streamId: stream.streamId,
    origin: stream.origin,
    bytes: stream.bytes,
    bufferedBytes: stream.bufferedBytes,
    live: stream.live,
    encrypted: stream.encrypted,
    ended: stream.ended,
    partialReason: stream.partialReason,
    mediaElementName: stream.mediaElementName,
  }

  return {
    url,
    container,
    // No page ever supplied a label for a stream, the same standing answer the network
    // fallback gives, so this is not a missing value but the honest one.
    quality: 'unknown',
    kind: kindFor(container, stream.mimeType),
    sizeBytes: stream.bytes,
    sources: [STREAM_EXTRACTOR_ID],
    reason: STREAM_EXTRACTOR_REASON,
    stream: signals,
  }
}

/**
 * What the content script tells the page when it puts the hook there.
 *
 * The token is minted by the content script for this injection and the hook stamps itself
 * with it, so a report can be traced to the injection that asked for it. The page url is
 * stamped for the same reason the content script stamps its own: a single page app that
 * navigates without a reload leaves the hook installed, and the new page url is what tells
 * it to announce what it still holds rather than return early.
 */
export const InstallPageSchema = z.object({
  source: z.literal(PAGE_CHANNEL_SOURCE),
  type: z.literal('install'),
  token: z.string().min(1),
  pageUrl: z.string(),
})
export type InstallPageMessage = z.infer<typeof InstallPageSchema>

/** A full snapshot of the streams the page holds right now. */
export const StreamsReportSchema = z.object({
  source: z.literal(PAGE_CHANNEL_SOURCE),
  type: z.literal('streams'),
  token: z.string().min(1),
  pageUrl: z.string(),
  streams: z.array(PageStreamSchema),
})
export type StreamsReportMessage = z.infer<typeof StreamsReportSchema>

/**
 * The assembly request, relayed into the page.
 *
 * `filename` arrives from the engine's own six step rule and is the reason this message
 * carries it rather than the popup: the worker is the only party that knows the name.
 */
export const AssemblePageSchema = z.object({
  source: z.literal(PAGE_CHANNEL_SOURCE),
  type: z.literal('assemble'),
  token: z.string().min(1),
  streamId: z.number().int().nonnegative(),
  filename: z.string().optional(),
})
export type AssemblePageMessage = z.infer<typeof AssemblePageSchema>

/**
 * What the page answers with.
 *
 * The two errors it can raise are the two it is the only party able to see: whether an
 * assembly for this stream is already running, and whether there are any bytes to
 * assemble. The other two in `StreamAssembleError` are the worker's to decide.
 */
export const AssembledPageSchema = z.object({
  source: z.literal(PAGE_CHANNEL_SOURCE),
  type: z.literal('assembled'),
  token: z.string().min(1),
  streamId: z.number().int().nonnegative(),
  ok: z.boolean(),
  error: StreamAssembleErrorSchema.optional(),
})
export type AssembledPageMessage = z.infer<typeof AssembledPageSchema>

/**
 * Anything the hook sends, parsed or refused.
 *
 * Two functions rather than one, because the two directions accept different messages
 * and a single parser returning all four would let a caller that asked for a report
 * quietly act on a command, or the other way round. The page can post anything, so each
 * side has to refuse what it does not understand.
 */
export function parseHookReport(
  data: unknown
): StreamsReportMessage | AssembledPageMessage | HelloPageMessage | null {
  if (typeof data !== 'object' || data === null) return null

  switch ((data as { type?: unknown }).type) {
    case 'streams':
      return StreamsReportSchema.safeParse(data).data ?? null
    case 'assembled':
      return AssembledPageSchema.safeParse(data).data ?? null
    case 'hello':
      return HelloPageSchema.safeParse(data).data ?? null
    default:
      return null
  }
}

/** Anything the hook is asked to do, parsed or refused. */
export function parseHookCommand(
  data: unknown
): InstallPageMessage | AssemblePageMessage | null {
  if (typeof data !== 'object' || data === null) return null

  switch ((data as { type?: unknown }).type) {
    case 'install':
      return InstallPageSchema.safeParse(data).data ?? null
    case 'assemble':
      return AssemblePageSchema.safeParse(data).data ?? null
    default:
      return null
  }
}