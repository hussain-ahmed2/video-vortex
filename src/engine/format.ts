// Owns the strings the popup renders that are computed rather than chosen: a byte
// count, how long ago something was seen, how much of the page is being held back, and
// a transfer's percentage.
//
// They live here rather than in the popup for two reasons. The boundary between the
// engine and the popup is "no rules in App.tsx", and a formatter is a rule: it is the
// difference between a row that says 48.2 MB and one that says 48.2. And each of these
// was previously only checkable by rendering the popup and reading it, which is how a
// wrong number survives for months. The screen's own copy, the words a person reads
// rather than a number they are shown, stays in the popup where it belongs.

import type { DownloadStatus } from './messages'
import { PAGE_STREAM_BYTE_CAP } from './page-channel'
import type { PlaylistState, StreamState } from './types'

const BYTES_IN_KILOBYTE = 1024
const BYTES_IN_MEGABYTE = BYTES_IN_KILOBYTE * 1024
const BYTES_IN_GIGABYTE = BYTES_IN_MEGABYTE * 1024

const SECONDS_IN_MINUTE = 60
const MINUTES_IN_HOUR = 60

/**
 * The size a row shows.
 *
 * `Size unknown` rather than a zero or a dash, because the file's size is genuinely
 * unknown: the response stated none, or the body was compressed, and a wrong number
 * here is worse than no number.
 */
export function formatBytes(sizeBytes: number | null): string {
  if (sizeBytes === null) return 'Size unknown'
  if (sizeBytes < BYTES_IN_KILOBYTE) return `${sizeBytes} B`
  if (sizeBytes < BYTES_IN_MEGABYTE) {
    return `${(sizeBytes / BYTES_IN_KILOBYTE).toFixed(1)} KB`
  }
  if (sizeBytes < BYTES_IN_GIGABYTE) {
    return `${(sizeBytes / BYTES_IN_MEGABYTE).toFixed(1)} MB`
  }
  return `${(sizeBytes / BYTES_IN_GIGABYTE).toFixed(1)} GB`
}

/**
 * How long ago the list was last changed, in whole units.
 *
 * Seconds under a minute, then minutes, then hours. Whole units because "Updated 0s
 * ago" and "Updated 47s ago" are the same information written twice, and a person
 * watching a page wants to know whether the list is fresh, not to the second.
 */
export function formatStaleness(updatedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - updatedAt) / 1000))

  if (seconds < SECONDS_IN_MINUTE) return `Updated ${seconds}s ago`

  const minutes = Math.floor(seconds / SECONDS_IN_MINUTE)
  if (minutes < MINUTES_IN_HOUR) return `Updated ${minutes}m ago`

  return `Updated ${Math.floor(minutes / MINUTES_IN_HOUR)}h ago`
}

/**
 * What the cap is holding back, as one line.
 *
 * "Showing 50 of 62 found" rather than "12 hidden", because the number of rows on
 * screen and the number the page exposed are the two facts a person needs to decide
 * whether to trust the list.
 */
export function formatHiddenCount(shown: number, hidden: number): string {
  return `Showing ${shown} of ${shown + hidden} found`
}

/**
 * A transfer's percentage, or null when the total is unknown.
 *
 * Null is Chrome's minus one after the engine has mapped it, and it is the only
 * indeterminate case. A faked number here would show a transfer of unknown length as
 * part done and never moving, so the row shows no value and says the size is unknown.
 */
export function progressPercent(
  bytesReceived: number,
  totalBytes: number | null
): number | null {
  if (totalBytes === null || totalBytes <= 0) return null

  // Clamped, because `bytesReceived` counts a whole received body while `totalBytes` is
  // the declared size: a redirect or a resumed transfer reports more than it was
  // promised, and a bar running past its own track reads as complete.
  return Math.min(100, Math.max(0, Math.round((bytesReceived / totalBytes) * 100)))
}

/**
 * What a stream row says about itself, or null when it has nothing to add.
 *
 * Null is the answer for a stream that is simply playable and for one that has ended, which
 * is most of them. The four sentences exist because a row with no download control and no
 * explanation is worse than no row: a person would read it as the extension being broken
 * rather than as an honest answer.
 *
 * The three partial sentences are separate rather than one word with three causes behind it,
 * because a person can act on two of them and neither on the third. Our own page cap is ours
 * to raise, the browser's quota is theirs to free, and a player that walked away is neither.
 */
export function formatStreamNote(state: StreamState): string | null {
  switch (state) {
    case 'live':
      return 'This is a live stream, so there is no file to save'
    case 'partial_capped':
      // Stated from the cap rather than written out, so the sentence cannot drift away from
      // the number the hook enforces.
      return `This page reached its ${PAGE_STREAM_BYTE_CAP / (1024 * 1024)} MB limit, so its streams are partial`
    case 'partial_browser_quota':
      return "The browser's own limit for this stream was reached, so this file is partial"
    case 'partial_broken':
      return 'The player abandoned this stream partway through, so this file is partial'
    default:
      // Playable, ended, still collecting, and encrypted. The last is never recorded at all,
      // so a sentence for it would be one nobody can ever read.
      return null
  }
}

/** The label a transfer carries, in both the known and the unknown case. */
export function formatProgressLabel(status: DownloadStatus): string {
  const percent = progressPercent(status.bytesReceived, status.totalBytes)
  return percent === null ? 'Downloading, size unknown' : `Downloading ${percent}%`
}

/**
 * What a manifest row says about itself, or null when it has nothing to add.
 *
 * Null only for `assemblable`, the state that carries a control instead. Every other
 * state is a reason there is no control, and a row with nothing to press and nothing
 * to say reads as the extension being broken rather than as an honest answer.
 *
 * The sentences are distinct rather than one word with causes behind it for the same
 * reason the stream's are: a person can act on them differently, or not at all. A
 * manifest the page could not read, one the page refused, and one that is live are
 * three different situations.
 *
 * The spec's own table is the source for these strings. They are not paraphrased,
 * because a row that almost says the thing is worse than one that says it exactly.
 */
export function formatPlaylistNote(state: PlaylistState): string | null {
  switch (state) {
    case 'unread':
      return 'This page streams video we could not read'
    case 'live':
      return 'This is a live stream, so there is no file to save'
    case 'encrypted':
      return 'This stream is encrypted, so there is nothing we can save'
    case 'byte_ranged':
      return 'This playlist points into one file in pieces, which we do not follow yet'
    case 'unsupported_container':
      return 'This page streams video in a format we cannot save yet'
    case 'assemblable':
      return null
  }
}
