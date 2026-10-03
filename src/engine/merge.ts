// Owns how a batch of reported findings becomes a tab's list: the field by field
// merge, the cap at fifty, the count of what the cap holds back, and the per tab
// serialisation that keeps two reports from losing each other.
//
// A merge returns a new record rather than editing one. Storage gives back a parsed
// value, and editing it in place would make "did this change?" impossible to answer,
// which is what decides whether the popup is re-read.

import { entryKey, isSameEntry } from './identity'
import type { EntriesReportedRequest } from './messages'
import {
  hiddenCountFor,
  type MediaEntry,
  type MediaEntryDraft,
  type TabMedia,
  type TabStatus,
} from './types'

/**
 * How many entries one tab keeps.
 *
 * Chosen so a person can read the list. A page that really does expose more than this
 * loses some, which is why the record also carries what is being held back and the
 * popup says so.
 */
export const MAX_ENTRIES_PER_TAB = 50

/**
 * Statuses, strongest first.
 *
 * Two extractors reporting the same page must not undo each other's verdict, and the
 * order is how that is prevented: a page that cannot be watched stays unwatchable
 * however many times something else reports it.
 */
const STATUS_PRECEDENCE: readonly TabStatus[] = ['unsupported', 'blocked', 'ready', 'observing']

/** The stronger of two statuses, either one being stronger than `observing`. */
export function strongestStatus(current: TabStatus, incoming: TabStatus): TabStatus {
  return STATUS_PRECEDENCE.indexOf(incoming) < STATUS_PRECEDENCE.indexOf(current)
    ? incoming
    : current
}

/**
 * One finding folded into one entry.
 *
 * A null size never overwrites a known one, and the kind stands from the first
 * classification: reclassifying the same file is not new information, and letting it
 * move would put a row in the audio list on one report and the video list on the next.
 *
 * The stream signals are taken whole from the newest report rather than field by
 * field. Every report is a full snapshot of the live streams, so the newest one is
 * the truth, and merging signal fields individually could produce a combination the
 * page never observed, such as a latched `partialReason` beside a fresh
 * `bufferedBytes` from before the stream broke.
 */
function mergeIntoEntry(existing: MediaEntry, draft: MediaEntryDraft, now: number): MediaEntry {
  return {
    ...existing,
    sources: [...new Set([...existing.sources, ...draft.sources])],
    sizeBytes: draft.sizeBytes ?? existing.sizeBytes,
    stream: draft.stream ?? existing.stream,
    playlist: draft.playlist ?? existing.playlist,
    discoveredAt: now,
  }
}

/** The fresh entry a finding that matches nothing becomes. */
function entryFromDraft(draft: MediaEntryDraft, now: number): MediaEntry {
  return {
    url: draft.url,
    container: draft.container,
    quality: draft.quality,
    kind: draft.kind,
    sizeBytes: draft.sizeBytes,
    sources: [...draft.sources],
    stream: draft.stream,
    playlist: draft.playlist,
    discoveredAt: now,
  }
}

/**
 * The merge itself: drafts folded in order, then the cap, then the derived counts.
 *
 * The cap drops the oldest `discoveredAt`, which is a last seen time, so a source the
 * page keeps re-requesting is never the one thrown away.
 *
 * `updatedAt` moves only when a finding actually folded in. A report carrying nothing
 * but the page title has not seen any media, and advancing the clock on it would make
 * the staleness line read "Updated 0s ago" on a page that found nothing.
 */
export function mergeDrafts(
  record: TabMedia,
  drafts: MediaEntryDraft[],
  now: number
): TabMedia {
  let entries = [...record.entries]
  const seenKeys = [...record.seenKeys]
  let lastWriter = record.lastWriter

  for (const draft of drafts) {
    lastWriter = draft.sources[draft.sources.length - 1] ?? lastWriter

    const found = entries.findIndex((entry) => isSameEntry(entry, draft))
    if (found >= 0) {
      entries[found] = mergeIntoEntry(entries[found], draft, now)
      continue
    }

    entries.push(entryFromDraft(draft, now))
    // Counted once per identity, dropped entries included, which is what keeps a
    // reappearing entry from inflating the hidden count every time it comes back.
    if (!seenKeys.includes(entryKey(draft))) seenKeys.push(entryKey(draft))
  }

  if (entries.length > MAX_ENTRIES_PER_TAB) {
    entries.sort((left, right) => left.discoveredAt - right.discoveredAt)
    entries = entries.slice(entries.length - MAX_ENTRIES_PER_TAB)
  }

  const merged: TabMedia = {
    ...record,
    lastWriter,
    updatedAt: drafts.length > 0 ? now : record.updatedAt,
    seenKeys,
    entries,
    hiddenCount: 0,
  }
  merged.hiddenCount = hiddenCountFor(merged)
  return merged
}

/** A brand new record for a tab the worker has just started watching. */
export function createRecord(params: {
  tabId: number
  pageUrl: string
  pageTitle: string
  status: TabStatus
  lastWriter: string
  updatedAt: number
}): TabMedia {
  return {
    tabId: params.tabId,
    pageUrl: params.pageUrl,
    pageTitle: params.pageTitle,
    status: params.status,
    lastWriter: params.lastWriter,
    updatedAt: params.updatedAt,
    hiddenCount: 0,
    seenKeys: [],
    entries: [],
  }
}

export interface AppliedReport {
  record: TabMedia
  /**
   * Whether anything a reader can see moved.
   *
   * The broadcast goes out only when this is true, so a page re-requesting the same
   * file every few seconds does not turn into a re-read every few seconds.
   */
  changed: boolean
}

/**
 * Whether anything a reader can see moved.
 *
 * The two timestamps are left out on purpose. A page playing one video re-requests
 * the same file every few seconds, and comparing them literally would turn that into
 * a re-read every few seconds, which is the burst this comparison exists to absorb.
 * A last seen time is still stored, and the staleness line still moves, it just does
 * not on its own justify waking the popup.
 */
function isSameRecord(before: TabMedia, after: TabMedia): boolean {
  const visible = (record: TabMedia) => ({
    pageUrl: record.pageUrl,
    pageTitle: record.pageTitle,
    status: record.status,
    lastWriter: record.lastWriter,
    hiddenCount: record.hiddenCount,
    seenKeys: record.seenKeys,
    entries: record.entries.map((entry) => ({
      url: entry.url,
      container: entry.container,
      quality: entry.quality,
      kind: entry.kind,
      sizeBytes: entry.sizeBytes,
      sources: entry.sources,
      // Carried whole rather than field by field, for the same reason the merge takes
      // it whole: a derived state reads from several signals at once, so a row whose
      // state had moved but whose signals looked unchanged would look identical here
      // and the popup would never hear about it.
      stream: entry.stream,
      // Same argument, one state machine for playlists. Leaving it out would mean a
      // playlist the page just finished reading never reaches the record, because the
      // merge would read as unchanged.
      playlist: entry.playlist,
    })),
  })

  return JSON.stringify(visible(before)) === JSON.stringify(visible(after))
}

/**
 * Drops every stream the page's latest snapshot does not list.
 *
 * `mergeDrafts` can fold and cap but cannot delete, so a stream whose bytes died with
 * the page would sit in the list forever. A report from the hook is a full snapshot,
 * so anything absent from it is gone, and the row has to go with it.
 *
 * The identity keys go too, and that is the half that is easy to miss. `hiddenCount`
 * is counted less held, so a dropped stream left in `seenKeys` would keep inflating
 * what the cap claims to be holding back, permanently and by exactly one per dead
 * stream. The count has to be rebuilt from what is left rather than decremented.
 *
 * File entries are never touched. They come from the network observer, which has no
 * snapshot and no knowledge of streams, so their absence from a page report says
 * nothing about them.
 */
export function dropUnknownStreams(record: TabMedia, knownStreamIds: ReadonlySet<number>): TabMedia {
  const entries = record.entries.filter(
    (entry) => !entry.stream || knownStreamIds.has(entry.stream.streamId)
  )
  if (entries.length === record.entries.length) return record

  const keptKeys = new Set(entries.map((entry) => entryKey(entry)))
  const dropped: TabMedia = {
    ...record,
    seenKeys: record.seenKeys.filter((key) => keptKeys.has(key)),
    entries,
    hiddenCount: 0,
  }
  dropped.hiddenCount = hiddenCountFor(dropped)
  return dropped
}

/**
 * Drops every playlist row that a master on this record points at.
 *
 * A master playlist is one row, and it is the row the person wants. The quality
 * playlists it names are how one video is offered in four resolutions, not four
 * things to save, so they never become rows. They cannot simply be ignored by the
 * observer, because the observer lists every response it is told about. Dropping them
 * is the engine's job from the variant urls the page reported, never the page's.
 *
 * File entries and stream entries are never touched, for the same reason as
 * `dropUnknownStreams`: their absence from this list says nothing about them.
 *
 * The identity keys go with the dropped rows, and that is the half that is easy to
 * miss. `hiddenCount` is counted less held, so a variant left in `seenKeys` would
 * keep inflating what the cap claims to be holding back. The count is rebuilt from
 * what is left rather than decremented.
 */
export function dropVariantPlaylists(record: TabMedia): TabMedia {
  const variantUrls = new Set<string>()
  for (const entry of record.entries) {
    if (!entry.playlist) continue
    for (const url of entry.playlist.variants) variantUrls.add(url)
  }
  if (variantUrls.size === 0) return record

  const entries = record.entries.filter((entry) => !variantUrls.has(entry.url))
  if (entries.length === record.entries.length) return record

  const keptKeys = new Set(entries.map((entry) => entryKey(entry)))
  const dropped: TabMedia = {
    ...record,
    seenKeys: record.seenKeys.filter((key) => keptKeys.has(key)),
    entries,
    hiddenCount: 0,
  }
  dropped.hiddenCount = hiddenCountFor(dropped)
  return dropped
}

export interface ApplyReportParams {
  /** The tab the sender is running in, which the report itself does not name. */
  tabId: number
  existing: TabMedia | null
  report: EntriesReportedRequest
  now: number
}

/**
 * Folds one report into a tab's record, creating or replacing it as the page demands.
 *
 * A report whose `pageUrl` is not the record's replaces the record rather than
 * merging into it, so a report still in flight from a page the user has already left
 * cannot land on the new page's list. Everything counted for the old page goes with
 * it, which is why `seenKeys` is emptied rather than carried over.
 */
export function applyReport({
  tabId,
  existing,
  report,
  now,
}: ApplyReportParams): AppliedReport {
  const isNewPage = existing === null || existing.pageUrl !== report.pageUrl

  if (isNewPage) {
    const record = createRecord({
      tabId,
      pageUrl: report.pageUrl,
      pageTitle: report.pageTitle,
      status: report.status,
      lastWriter: existing?.lastWriter ?? '',
      updatedAt: now,
    })
    return { record: mergeDrafts(record, report.entries, now), changed: true }
  }

  const withStatus: TabMedia = {
    ...existing,
    pageTitle: report.pageTitle,
    status: strongestStatus(existing.status, report.status),
  }
  const merged = mergeDrafts(withStatus, report.entries, now)

  // A variant playlist is not a row, whatever the observer was told. Asked of every
  // report rather than of a report that mentions a playlist, because a report naming a
  // master for the first time is the one that makes already recorded variants visible.
  const record = dropVariantPlaylists(merged)

  return { record, changed: !isSameRecord(existing, record) }
}

export interface SerialQueue {
  /** Runs `task` after every earlier task for the same tab has settled. */
  run<T>(tabId: number, task: () => Promise<T>): Promise<T>
}

/**
 * One promise chain per tab.
 *
 * A single writer is not enough. Every step here awaits, and awaiting yields, so two
 * reports can interleave between one task's read and its write and the second write
 * lands on a record read before the first was saved. One chain per tab removes the
 * interleaving, and keeping the chains per tab rather than global stops one busy tab
 * from delaying every other one.
 */
export function createSerialQueue(): SerialQueue {
  const chains = new Map<number, Promise<unknown>>()

  return {
    run<T>(tabId: number, task: () => Promise<T>): Promise<T> {
      const previous = chains.get(tabId) ?? Promise.resolve()
      const next = previous.then(task, task)
      // The stored chain must not reject, or every later report for this tab would
      // be skipped as a rejected predecessor.
      chains.set(
        tabId,
        next.catch(() => undefined)
      )
      return next
    },
  }
}
