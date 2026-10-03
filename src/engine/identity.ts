// Owns what makes two findings the same file, plus the id and reason the network
// fallback reports itself as. Two finders naming one file must produce one row, or
// a page that is both sniffed and scraped lists everything twice.
//
// The fallback's constants live here rather than in a module of their own because
// they are identity: `lastWriter` and `sources` carry the id, so the thing that named
// a finding and the rule for recognising it belong in one place.

/** The id the network fallback writes into `lastWriter` and `sources`. */
export const FALLBACK_EXTRACTOR_ID = 'network-response'

/** Why the fallback kept a finding. Never stored, only reported. */
export const FALLBACK_EXTRACTOR_REASON = 'network response'

/** The id the page hook writes into `lastWriter` and `sources` for a stream. */
export const STREAM_EXTRACTOR_ID = 'page-stream-hook'

/**
 * Why the page hook kept a stream.
 *
 * A stream is not a response and not a scrape, so it needs its own wording. Recorded so
 * the diagnostics view can say where a row came from without guessing from its url.
 */
export const STREAM_EXTRACTOR_REASON = 'assembled by the page'

/** The three fields that make a finding an entry. The tab is implied by the record. */
export interface EntryIdentity {
  url: string
  container: string
  quality: string
}

/** The scheme every stream entry's url is written under. Never a fetchable address. */
export const STREAM_URL_SCHEME = 'vortex-stream:'

/**
 * The url a stream is listed under.
 *
 * A stream has no address to fetch, so its identity has to be minted rather than
 * read. It stays inside the existing tuple: url, container, quality are unchanged
 * and the tab is implied by the record, so this introduces no stream specific
 * identity rule and feature 8 does not have to learn a second one.
 *
 * The page url is percent encoded, and the encoding is the load bearing part.
 * `encodeURIComponent` escapes the slashes but leaves dots alone, and that is not
 * enough: with no slash left anywhere in the string, the whole encoded page url
 * becomes one path segment, and `containerFromPath` reads the tail of it as an
 * extension. A page at `/watch.html` minted a url ending in `.html`, so the rule
 * ranked ours above the content type map and called the row an html file. The dot
 * is escaped too, which leaves nothing for that rule to read and is why this is not
 * plain `encodeURIComponent`.
 */
export function streamEntryUrl(pageUrl: string, streamId: number): string {
  const encoded = encodeURIComponent(pageUrl).replace(/\./g, '%2E')
  return `${STREAM_URL_SCHEME}${encoded}#${streamId}`
}

/** Whether a url is one this extension minted for a stream. */
export function isStreamUrl(url: string): boolean {
  return url.startsWith(STREAM_URL_SCHEME)
}

/**
 * The stream id back out of a minted url, or null when the url is not one of ours.
 *
 * The assembly request carries a url rather than a stream id, because that is the field
 * the popup has and the one the worker looks the entry up by. So the id is read back out
 * here rather than added to the message, which would have meant a seventh field on a
 * contract that already grew by a message for this slice.
 */
export function streamIdFromUrl(url: string): number | null {
  if (!isStreamUrl(url)) return null

  const hash = url.lastIndexOf('#')
  if (hash < 0) return null

  const parsed = Number(url.slice(hash + 1))
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

/**
 * The identity key one entry is counted and merged under.
 *
 * The tab id is not in the key because a merge always runs inside one tab's record,
 * so the tab is already fixed by the record being merged into. Spelling the tab into
 * every key would mean carrying it through calls that only ever see one tab.
 */
export function entryKey(identity: EntryIdentity): string {
  return `${identity.url}|${identity.container}|${identity.quality}`
}

/**
 * Whether two findings are the same entry.
 *
 * `unknown` compares equal to itself across findings, which is the one exception to
 * the tuple and the reason this is a function rather than a string compare. A file
 * first seen on a response that named no type and again on one that did is one file,
 * and a plain key would make it two rows: the same bytes listed twice, and a count
 * that grew every time the page re-requested it.
 */
export function isSameEntry(left: EntryIdentity, right: EntryIdentity): boolean {
  if (left.url !== right.url) return false
  if (left.quality !== right.quality) return false
  if (left.container === right.container) return true

  return left.container === 'unknown' || right.container === 'unknown'
}
