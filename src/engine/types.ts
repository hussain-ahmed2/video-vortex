// Owns the data model: what one detected file is, what one tab's list is, and the
// version every message carries. Nothing here reaches a browser API, so the popup,
// the worker and the content script can all share the shapes without any of them
// leaking into the rules.
//
// The zod schemas live beside the types on purpose. The worker parses a stored
// record with them on every read, and a record that fails is discarded rather
// than repaired, so the schema is load bearing rather than documentation.

import { z } from 'zod'

/**
 * Bumped whenever a payload shape changes.
 *
 * The content script stamps it onto `globalThis` on start and the worker compares
 * it on receipt, which is the one case the check can actually fire: a page left
 * running a content script from the build before an extension reload. Without the
 * stamp the old script would keep reporting a shape the new worker no longer reads.
 *
 * At 2 the entry and the draft each gained the optional `stream` block. A payload
 * carrying it against a worker still on 1 fails the literal and is dropped rather
 * than read as a file entry, which is the outcome we want: a stream row is not
 * something to half understand.
 *
 * At 3 the entry and the draft each gained the optional `playlist` block, because a
 * manifest is now a first class thing the page can read and report. A payload still on
 * 2 fails the literal and is dropped, which is right: a playlist row is not something
 * to half understand.
 */
export const CONTRACT_VERSION = 3

export const TabStatusSchema = z.enum(['observing', 'ready', 'blocked', 'unsupported'])
export type TabStatus = z.infer<typeof TabStatusSchema>

export const MediaKindSchema = z.enum(['video', 'audio'])
export type MediaKind = z.infer<typeof MediaKindSchema>

/** Which of the two page mechanisms the hook saw. Decided by the argument's type. */
export const StreamOriginSchema = z.enum(['mse', 'blob'])
export type StreamOrigin = z.infer<typeof StreamOriginSchema>

/**
 * Why a stream stopped being savable in full, or that it has not.
 *
 * Three causes rather than one because a person can act on two of them and neither
 * on the third, and one sentence cannot honestly cover all three: our own page cap,
 * the browser's per buffer quota refusing an append, and a player abandoning the
 * buffer. The page latches whichever happens first and never clears it, because
 * bytes already copied cannot be uncopied.
 */
export const PartialReasonSchema = z.enum(['none', 'page_cap', 'browser_quota', 'broken'])
export type PartialReason = z.infer<typeof PartialReasonSchema>

/**
 * What the page observed about one stream. Never a verdict.
 *
 * Every field is a finite value on purpose. A record that fails its schema is
 * discarded whole rather than repaired, so a single unrepresentable number would
 * throw away a tab's whole list. `live` is a boolean rather than the duration that
 * produced it for the same reason: `NaN` has no business crossing this boundary.
 */
export const StreamSignalsSchema = z.object({
  streamId: z.number().int().nonnegative(),
  origin: StreamOriginSchema,
  /** What the hook has copied out of the page so far. */
  bytes: z.number().finite().nonnegative(),
  /**
   * What the player's own `SourceBuffer`s report buffered.
   *
   * This and not the media element's playback progress, because a paused or still
   * buffering element never passes its metadata: a video on a page nobody pressed
   * play on would never be listed, and a finished stream would read as collecting
   * forever. Both are the common case rather than the edge one.
   */
  bufferedBytes: z.number().finite().nonnegative(),
  live: z.boolean(),
  encrypted: z.boolean(),
  ended: z.boolean(),
  partialReason: PartialReasonSchema,
  mediaElementName: z.string().nullable(),
})
export type StreamSignals = z.infer<typeof StreamSignalsSchema>

/**
 * What the engine makes of a stream's signals.
 *
 * The three partial states are separate rather than one state beside a reason, so
 * `deriveStreamState` returns one value and a caller cannot forget to read a second.
 * Each also carries its own sentence, which is the whole reason they are distinct.
 */
export const StreamStateSchema = z.enum([
  'encrypted',
  'partial_capped',
  'partial_browser_quota',
  'partial_broken',
  'live',
  'assembling',
  'ended',
  'playable',
])
export type StreamState = z.infer<typeof StreamStateSchema>

/**
 * Which manifest a playlist is.
 *
 * The signal exists because the page can read both, and the engine has to treat them
 * differently: HLS is the one we attempt to join, and DASH plays through the path spec
 * 0005 already owns, so it is labelled rather than assembled. Without it a DASH manifest
 * could derive to `assemblable`, because DASH segments are usually fragmented MP4, and
 * the engine would have no way to tell an HLS playlist from a DASH one.
 */
export const PlaylistManifestSchema = z.enum(['hls', 'dash', 'unknown'])
export type PlaylistManifest = z.infer<typeof PlaylistManifestSchema>

/** What the page saw when it looked at the segments the playlist points at. */
export const PlaylistSegmentsSchema = z.enum(['mp4', 'ts', 'unknown'])
export type PlaylistSegments = z.infer<typeof PlaylistSegmentsSchema>

/**
 * What the page observed about one playlist. Never a verdict.
 *
 * The same rule as `StreamSignals`: every field is a finite value, because a record that
 * fails its schema is discarded whole, so a single unrepresentable number would throw
 * away a tab's whole list. A playlist entry's `sizeBytes` stays null until assembly,
 * because a playlist declares no segment sizes.
 */
export const PlaylistSignalsSchema = z.object({
  /** True when the playlist has an end. A live playlist has none. */
  live: z.boolean(),
  /** True when the playlist declares keyed or sample encrypted segments. */
  encrypted: z.boolean(),
  /** True when any segment is addressed by a byte range rather than on its own. */
  byteRanged: z.boolean(),
  manifest: PlaylistManifestSchema,
  segments: PlaylistSegmentsSchema,
  /** The urls a master playlist points at. The one field the page would not think to send. */
  variants: z.array(z.string()),
})
export type PlaylistSignals = z.infer<typeof PlaylistSignalsSchema>

/**
 * What the engine makes of a playlist's signals.
 *
 * Six states, each with its own sentence. `unread` is the one the page never reports,
 * because it means there were no facts to report: the popup names it when a manifest
 * row carries no block at all.
 */
export const PlaylistStateSchema = z.enum([
  'unread',
  'encrypted',
  'byte_ranged',
  'unsupported_container',
  'live',
  'assemblable',
])
export type PlaylistState = z.infer<typeof PlaylistStateSchema>

export const MediaEntrySchema = z.object({
  url: z.string(),
  // Part of the entry's identity. `unknown` means nothing named the container, and
  // it compares equal to itself across findings so one file seen twice is one row.
  container: z.string(),
  // Free text, never an enum, because sites invent labels. `unknown` throughout
  // this slice: the network fallback has no site to ask.
  quality: z.string(),
  kind: MediaKindSchema,
  // A number the site or the response stated, or null. Never computed and never a
  // compressed transfer size, so a row says "Size unknown" rather than a wrong one.
  sizeBytes: z.number().nullable(),
  // Ids of the extractors that found this entry, so two finders naming one file
  // produce one row that says so.
  sources: z.array(z.string()),
  // A last seen time, not a first seen time. The cap drops the oldest, and a source
  // that keeps being reported is therefore never the one dropped.
  discoveredAt: z.number(),
  // Absent for a file entry. Present for a stream, carrying what the page observed
  // and nothing more: the state is derived from it, never stored beside it.
  stream: StreamSignalsSchema.optional(),
  // Absent for a file entry and for a stream. Present for a manifest the page read,
  // carrying the same kind of raw observations as `stream`.
  playlist: PlaylistSignalsSchema.optional(),
})
export type MediaEntry = z.infer<typeof MediaEntrySchema>

/**
 * What an extractor hands over, before it becomes a stored entry.
 *
 * `reason` is the one field the data model rule exempts: it is never stored, and it
 * exists so an extractor can be tested and so the diagnostics view can explain a
 * decision later.
 */
export const MediaEntryDraftSchema = z.object({
  url: z.string(),
  container: z.string(),
  quality: z.string(),
  kind: MediaKindSchema,
  sizeBytes: z.number().nullable(),
  sources: z.array(z.string()),
  reason: z.string(),
  stream: StreamSignalsSchema.optional(),
  playlist: PlaylistSignalsSchema.optional(),
})
export type MediaEntryDraft = z.infer<typeof MediaEntryDraftSchema>

export const TabMediaSchema = z.object({
  tabId: z.number(),
  // The page as of the last write. Compared against the tab's current URL on every
  // read, which is how a list from a page the user has left gets caught.
  pageUrl: z.string(),
  // Untrusted page text. The popup renders it as text and never as markup.
  pageTitle: z.string(),
  status: TabStatusSchema,
  // Id of the extractor that wrote last. Its only reader is the diagnostics view.
  lastWriter: z.string(),
  updatedAt: z.number(),
  // What the cap is holding back, so the popup can say what it is not showing.
  // Derived on every save rather than accumulated, see `hiddenCountFor`.
  hiddenCount: z.number(),
  /**
   * The identity key of every distinct entry ever counted for this tab, dropped
   * entries included.
   *
   * This is the one addition to spec 0001's record that a number could not do. AC-10
   * wants an entry that was dropped at the cap and later seen again not to be
   * counted twice, and a scalar cannot remember which entries were dropped. Keeping
   * the keys is what makes `hiddenCount` honest rather than merely plausible.
   */
  seenKeys: z.array(z.string()),
  entries: z.array(MediaEntrySchema),
})
export type TabMedia = z.infer<typeof TabMediaSchema>

/** Distinct identities counted for a tab, which is what the scalar `seenCount` meant. */
export function seenCountOf(record: TabMedia): number {
  return record.seenKeys.length
}

/**
 * What the cap is holding back: everything counted, less what is still listed.
 *
 * Both numbers come from one place so they cannot drift. Callers read this rather
 * than trusting a stored `hiddenCount` that some other code path might have set.
 */
export function hiddenCountFor(record: TabMedia): number {
  return seenCountOf(record) - record.entries.length
}
