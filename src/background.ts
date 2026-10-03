// The service worker: the only writer of detection state, and the hub the popup and
// the content script both talk to. It holds no rules of its own. Every decision about
// what a container is, whether a file can be saved, how two findings merge and what a
// file is called lives in `src/engine/`, which is why this file can be read in one
// sitting and why the interesting behaviour is testable with no browser at all.
//
// Everything below registers at the top level on purpose. A service worker is stopped
// after about thirty seconds of quiet and its script is re-run from the top when
// something wakes it, so a listener added at the top level is re-registered on every
// start. That is what makes detection work at all after a stop.
//
// It is worth being precise about what a stop does cost, because the obvious answer is
// wrong. A `chrome.webRequest` registration outlives the worker: Chrome starts the worker
// again when a matching event occurs, so a request made while the worker was gone is
// still seen. Measured on 2026-10-02 with the worker's target closed and its target
// count at zero, a media request brought it back inside 120ms with the file recorded.
// What a stop does cost is anything that finished before anything was listening, which is
// not retroactively visible. Spec 0004's AC-18 states this the other way round and needs
// the correction; the behaviour lives here either way.

import { buildFilename } from './engine/filename'
import { FALLBACK_EXTRACTOR_ID, FALLBACK_EXTRACTOR_REASON } from './engine/identity'
import {
  applyReport,
  createRecord,
  createSerialQueue,
  dropUnknownStreams,
  mergeDrafts,
} from './engine/merge'
import {
  DownloadStateSchema,
  parseMessage,
  request,
  StreamAssembleResponseSchema,
  totalBytesOrNull,
  type DownloadMediaResponse,
  type DownloadStatus,
  type EntriesReportedRequest,
  type GetTabMediaResponse,
  type StreamAssembleResponse,
} from './engine/messages'
import {
  containerFor,
  isDownloadable,
  isListable,
  isSuccessStatus,
  KNOWN_CONTAINERS,
  kindFor,
  sizeBytesFrom,
} from './engine/media-rules'
import { recordKey, TABS_INDEX_KEY, type StateStore } from './engine/state-port'
import { TabMediaSchema, type MediaEntryDraft, type TabMedia } from './engine/types'

/** The largest count the badge shows, after which it says so rather than overflowing. */
const BADGE_CAP = 99

/**
 * Schemes whose pages cannot host a content script.
 *
 * A predicate rather than a try, because injection into these fails with an error that
 * reads like a bug rather than a fact about the page.
 */
const UNSUPPORTED_SCHEMES: readonly string[] = [
  'chrome:',
  'chrome-extension:',
  'chrome-untrusted:',
  'chrome-search:',
  'about:',
  'edge:',
  'moz-extension:',
  'devtools:',
  'view-source:',
]

/**
 * Hosts on an ordinary scheme that still cannot host one.
 *
 * The store's own listing pages are the case worth naming: they are https, they look
 * like a normal page, and injecting into them is refused.
 */
const UNSUPPORTED_HOSTS: readonly string[] = ['chromewebstore.google.com', 'chrome.google.com']

/**
 * Chrome's response headers arrive as a list, in no guaranteed case, and a header is
 * allowed to carry no value at all.
 *
 * The value is therefore narrowed rather than cast. A header with no value becoming the
 * string "undefined" would give a row a size of NaN and a container of nothing.
 */
function headersToRecord(
  headers: chrome.webRequest.HttpHeader[] | undefined
): Record<string, string> {
  const record: Record<string, string> = {}
  for (const header of headers ?? []) {
    if (typeof header.value === 'string') record[header.name.toLowerCase()] = header.value
  }
  return record
}

/** Whether this page can host a content script at all. */
export function canHostContentScript(url: string | undefined): boolean {
  if (!url) return false

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  if (UNSUPPORTED_SCHEMES.includes(parsed.protocol)) return false
  return !UNSUPPORTED_HOSTS.some(
    (host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`)
  )
}

/**
 * The badge text for a record: what is listed plus what the cap is holding back,
 * capped at `99+`.
 *
 * Both halves matter. The count alone would understate what was found, and the
 * uncapped total would overflow the four characters Chrome renders.
 */
export function badgeTextFor(record: TabMedia | null): string {
  if (!record) return ''

  const total = record.entries.length + record.hiddenCount
  if (total <= 0) return ''
  return total > BADGE_CAP ? `${BADGE_CAP}+` : String(total)
}

/**
 * The store over session storage.
 *
 * Session storage rather than a `Map` because Chrome stops this worker after thirty
 * seconds of quiet, and a list held in a worker global is gone by the time the popup
 * opens. The index key is written in the same operation as the record it belongs to,
 * so the two cannot drift apart.
 */
function createSessionStore(): StateStore {
  async function readIndex(): Promise<number[]> {
    const stored = await chrome.storage.session.get(TABS_INDEX_KEY)
    const value = stored[TABS_INDEX_KEY]
    return Array.isArray(value) ? value.filter((id): id is number => typeof id === 'number') : []
  }

  return {
    async load(tabId) {
      const key = recordKey(tabId)
      const stored = await chrome.storage.session.get(key)
      const raw = stored[key]
      if (raw === undefined) return null

      // Discarded, never repaired. A record from an older build, or one Chrome
      // truncated, is a record where every row is suspect, and an empty list is
      // honest where a half understood one is not.
      const parsed = TabMediaSchema.safeParse(raw)
      return parsed.success ? parsed.data : null
    },

    async save(record) {
      const index = new Set(await readIndex())
      index.add(record.tabId)
      await chrome.storage.session.set({
        [recordKey(record.tabId)]: record,
        [TABS_INDEX_KEY]: [...index],
      })
    },

    async remove(tabId) {
      const index = new Set(await readIndex())
      index.delete(tabId)
      await chrome.storage.session.remove(recordKey(tabId))
      await chrome.storage.session.set({ [TABS_INDEX_KEY]: [...index] })
    },

    tabs: readIndex,
  }
}

const store = createSessionStore()

/**
 * One promise chain per tab, so two reports arriving together cannot lose an entry.
 *
 * Every step below awaits, and awaiting yields. A single writer is therefore not
 * enough: two merges can interleave between one task's read and its write.
 */
const queue = createSerialQueue()

/** Messages dropped for being unrecognised, malformed or from another build. */
let droppedMessages = 0

/** Handler work that failed, which is a different thing from a message being dropped. */
let workerFailures = 0

/** Read by the diagnostics view later, and by the tests that assert a drop happened. */
export function droppedMessageCount(): number {
  return droppedMessages
}

/**
 * Read by the diagnostics view later, and by the tests that assert a failure was caught.
 *
 * Separate from `droppedMessages` on purpose: a dropped message is the input being
 * wrong, and this is the worker failing at something it was asked to do.
 */
export function workerFailureCount(): number {
  return workerFailures
}

/**
 * What a handler answers when its own work failed.
 *
 * The channel is always closed, because a caller waiting on an open channel waits for the
 * life of the popup. A read answers `undefined`, which its caller already treats as "no
 * answer", and a download answers the refusal it would have sent anyway, because that
 * message exists to be answered and a refusal is an answer. Inventing a new field for
 * "the worker could not do it" would be a contract change wearing a fix's clothes; the
 * count is what tells a person or the diagnostics view it happened.
 */
function answerAfterFailure(sendResponse: (response?: unknown) => void, fallback?: unknown): void {
  workerFailures += 1
  sendResponse(fallback)
}

async function getTab(tabId: number): Promise<chrome.tabs.Tab | undefined> {
  try {
    return await chrome.tabs.get(tabId)
  } catch {
    // Chrome rejects with `lastError` when the tab has gone, which is normal in a
    // worker that is woken by an event about a tab someone just closed.
    return undefined
  }
}

async function setBadge(tabId: number, record: TabMedia | null): Promise<void> {
  await chrome.action.setBadgeText({ tabId, text: badgeTextFor(record) })
}

async function broadcastTabMedia(tabId: number): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ name: 'TAB_MEDIA_UPDATED', payload: { tabId } })
  } catch {
    // Nobody is listening whenever no popup is open, which is the normal case and not
    // an error. Swallowed deliberately, and said here so nobody "fixes" it later.
  }
}

/**
 * Folds one observer finding into a tab's record, then updates the badge and tells the
 * popup if anything a reader can see moved.
 */
async function recordFinding(tabId: number, draft: MediaEntryDraft): Promise<void> {
  await queue.run(tabId, async () => {
    const tab = await getTab(tabId)
    if (!tab?.url) return

    // A record belongs to the page it was made for. Merging into a record whose page the
    // tab has left put the new page's media somewhere the next read was going to delete
    // the whole of, so the user saw an empty list until they reloaded. The tab's own url
    // is the authority here, and it costs one in memory lookup per media response.
    const existing = await store.load(tabId)
    const base =
      existing && existing.pageUrl === tab.url
        ? existing
        : createRecord({
            tabId,
            pageUrl: tab.url,
            pageTitle: tab.title ?? '',
            status: 'observing',
            lastWriter: FALLBACK_EXTRACTOR_ID,
            updatedAt: Date.now(),
          })

    const record = mergeDrafts(base, [draft], Date.now())
    await store.save(record)
    await setBadge(tabId, record)
    await broadcastTabMedia(record.tabId)
  })
}

/**
 * The observer: the only way this extension sees a page's media.
 *
 * Registered without a `types` filter on purpose. Media segments are frequently
 * fetched as XHR rather than as media, and a type filter would drop exactly the
 * requests a page is playing right now. The content type is the real test, and it is
 * what the engine's own rule asks.
 */
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    // A negative tab id is a request with no page behind it: this extension's own, a
    // service worker's, or a prefetch. There is no tab to list it on.
    if (details.tabId < 0) return

    const headers = headersToRecord(details.responseHeaders)
    const contentType = headers['content-type']
    const container = containerFor(details.url, contentType)

    // Only a success is ever recorded, and this is asked before anything else looks at
    // the response. A redirect answers 302 and the final response answers 200, so
    // requiring a success is what makes the url stored the file's own rather than the
    // one that pointed at it. It has to stand on its own: a path ending in .mp4 says
    // nothing about whether this response delivered anything, and letting the container
    // through first stored both urls of a redirect chain as two entries.
    if (!isSuccessStatus(details.statusCode)) return

    // Then it has to be media worth listing, either because the server named it as such
    // or because the path is named as a container we can put a name to. A manifest
    // qualifies: it is listed, and the row carries no download control.
    if (!isSuccessWithMedia(contentType, details.statusCode) && !isKnownContainer(container)) {
      return
    }

    // Nobody is waiting on this one, so a failure has no channel to leave open. It is
    // counted rather than left to surface as an unhandled rejection in the worker, which
    // is how a badge that cannot write for a closing tab used to announce itself.
    void recordFinding(details.tabId, {
      url: details.url,
      container,
      // The fallback has no site to ask, so every row reads `unknown` until a site
      // extractor lands. Recording a guess here would be a fabricated quality label.
      quality: 'unknown',
      kind: kindFor(container, contentType),
      sizeBytes: sizeBytesFrom(headers, details.statusCode),
      sources: [FALLBACK_EXTRACTOR_ID],
      reason: FALLBACK_EXTRACTOR_REASON,
    }).catch(() => {
      workerFailures += 1
    })
  },
  { urls: ['<all_urls>'] },
  // Without this the event carries no response headers at all, and a size and a
  // content type are the only two things the engine has to work from.
  ['responseHeaders']
)

/** A 2xx response that named itself as media, which is a file worth listing. */
function isSuccessWithMedia(contentType: string | undefined, statusCode: number | undefined): boolean {
  if (!isSuccessStatus(statusCode)) return false
  const media = contentType?.split(';')[0]?.trim().toLowerCase()
  return Boolean(media && (media.startsWith('video/') || media.startsWith('audio/')))
}

/**
 * Whether this container is one the engine can name.
 *
 * Not the same question as `isDownloadable`, and the difference is the whole of a
 * manifest: `m3u8` and `mpd` describe other files rather than being one, so a row for
 * them carries no download control, but the row still has to exist or the popup has
 * nothing to say about the page.
 */
function isKnownContainer(container: string): boolean {
  return KNOWN_CONTAINERS.includes(container.toLowerCase())
}

/**
 * Brings the index back in line with the records actually present.
 *
 * Run once per worker start. A record left behind by a crash is invisible otherwise:
 * nothing will ever write to that tab again, so nothing will ever remove it, and the
 * badge would claim media for a tab that closed minutes ago.
 */
async function reconcileIndex(): Promise<void> {
  const stored = await chrome.storage.session.get(null)
  const present: number[] = []
  for (const key of Object.keys(stored)) {
    const match = /^vv:tab:(\d+)$/.exec(key)
    if (match) present.push(Number(match[1]))
  }
  if (present.length === 0) return

  const live = new Set(
    (await chrome.tabs.query({}))
      .map((tab) => tab.id)
      .filter((id): id is number => typeof id === 'number')
  )
  const keep = present.filter((tabId) => live.has(tabId))
  const stale = present.filter((tabId) => !live.has(tabId))

  if (stale.length > 0) await chrome.storage.session.remove(stale.map(recordKey))
  await chrome.storage.session.set({ [TABS_INDEX_KEY]: keep })
}

void reconcileIndex().catch(() => {
  // A reconciliation that fails leaves the index as it was, which costs a stale record
  // at worst. Failing the worker's start over it would cost all detection, so this one is
  // counted rather than thrown, like every other failure in this file.
  workerFailures += 1
})

/**
 * Closing a tab deletes its record, its index entry and its badge.
 *
 * Not housekeeping. Chrome reuses tab ids, so a record left behind is inherited by
 * whatever tab opens next, and the popup would list one page's media on another. The
 * queue is used because a tab can be closed while a merge for it is still running.
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  void queue
    .run(tabId, async () => {
      await store.remove(tabId)
      await setBadge(tabId, null)
    })
    .catch(() => {
      // A tab that closed mid write is ordinary. The queue keeps its own chain from
      // rejecting, so without this the failure would surface as an unhandled rejection
      // and nothing would record that the record may now outlive its tab.
      workerFailures += 1
    })
})

// ─── The read path ─────────────────────────────────────────────────────────

/**
 * Puts the content script on the page, and then the page hook, in that order.
 *
 * Two files in two worlds, and neither is optional for the other. The content script is
 * isolated and cannot read the page's own variables, which is why the hook exists at all:
 * a `SourceBuffer` cannot be read back from outside the page, so the only place a stream's
 * bytes can be copied is inside it. The hook therefore goes in with `world: 'MAIN'`, which
 * shares `window` with the site.
 *
 * The order is the content script first so that the token is minted before the hook can
 * report, but nothing depends on it: the two say hello to each other over the page's
 * message bus, so whichever arrives second is answered and the page is watched either way.
 *
 * Only the first injection's failure is the read path's business. A page that will take a
 * content script but not a file in its own world is rare, and answering "this page cannot
 * be watched" for it would be a lie: the network observer still works, and so does
 * everything the content script reports.
 */
async function injectContentScript(tabId: number): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
  } catch {
    // A page that refuses injection cannot be watched. Saying so by name is the
    // difference between an honest popup and an empty list on a playing video.
    return false
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['hook.js'],
      world: 'MAIN',
    })
  } catch {
    workerFailures += 1
  }

  return true
}

/**
 * What is in flight for the urls this record holds.
 *
 * `chrome.downloads.search({})` returns every remembered download across every tab and
 * carries no tab id, so it is filtered here. Without that, a row on this tab could
 * show another tab's progress.
 */
async function inFlightFor(record: TabMedia): Promise<DownloadStatus[]> {
  const urls = new Set(record.entries.map((entry) => entry.url))
  const items = await chrome.downloads.search({})

  return items.flatMap((item) => {
    if (!urls.has(item.url)) return []

    // Chrome's own state, narrowed. A state this engine does not model is dropped
    // rather than passed on as a string the popup's switch cannot see.
    const state = DownloadStateSchema.safeParse(item.state)
    if (!state.success) return []

    return [
      {
        downloadId: item.id,
        url: item.url,
        bytesReceived: item.bytesReceived,
        totalBytes: totalBytesOrNull(item.totalBytes),
        state: state.data,
      },
    ]
  })
}

/**
 * Everything the popup needs about one tab.
 *
 * A read is not a pure read: with no record it puts a content script on the page. That
 * is deliberate and it is the only way a tab that predates the extension is ever looked
 * at. The injection is idempotent, because the content script stamps `globalThis` and
 * returns early if a script of this build is already running there.
 */
async function readTabMedia(tabId: number): Promise<GetTabMediaResponse> {
  const tab = await getTab(tabId)

  if (!tab || !canHostContentScript(tab.url)) {
    return { record: null, needsReport: false, status: 'unsupported', inFlight: [] }
  }

  // The record this read answers with. It is cleared when the record turns out to belong
  // to a page the tab has left, because a record that was just deleted must not be
  // handed back to the popup as if it were still there.
  let current = await store.load(tabId)

  // A record whose page is not the tab's current page is media from somewhere the user
  // has left. It is deleted and the read carries on as if there had been none, which
  // is what stops the popup listing a page that is no longer on screen.
  if (current && current.pageUrl !== tab.url) {
    await queue.run(tabId, async () => {
      await store.remove(tabId)
      await setBadge(tabId, null)
    })
    current = null
  } else if (current && current.status !== 'observing') {
    // Only a record something has reported is finished with. A record the observer made
    // is still waiting for its content script, so the read falls through to the
    // injection below rather than answering a page the engine has never heard from:
    // returning here left the record `observing` for the life of the tab, and the popup
    // on skeletons, because nothing would ever run to report.
    return {
      record: current,
      needsReport: false,
      status: current.status,
      inFlight: await inFlightFor(current),
    }
  }

  const injected = await injectContentScript(tabId)
  if (!injected) {
    // With a record, the media is real even though the page cannot be watched further,
    // and the spec's `unsupported` verdict is written for the case where the popup would
    // otherwise show an empty list. Answering with what was found is the honest reading
    // of both; the popup names the state whenever there is genuinely nothing.
    if (current) {
      return {
        record: current,
        needsReport: false,
        status: current.status,
        inFlight: await inFlightFor(current),
      }
    }
    return { record: null, needsReport: false, status: 'unsupported', inFlight: [] }
  }

  // The record is answered alongside the request for a report, so the popup has the
  // entries it already has while it waits, and the broadcast that follows the report
  // brings it the rest.
  return {
    record: current,
    needsReport: true,
    status: current?.status ?? 'observing',
    inFlight: current ? await inFlightFor(current) : [],
  }
}

// ─── Downloads ─────────────────────────────────────────────────────────────

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'The download could not be started'
}

/**
 * Starts one download, naming the file here rather than in the popup.
 *
 * The worker looks the entry up in its own record, so the six step rule exists in one
 * place and the popup cannot disagree with it about what a file is called. The lookup
 * is by url against the active tab's record because the message carries no tab id.
 */
async function startDownload(url: string): Promise<DownloadMediaResponse> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const tabId = tab?.id
  if (tabId === undefined) {
    return { ok: false, error: 'There is no tab to download from' }
  }

  const record = await store.load(tabId)
  const entry = record?.entries.find((candidate) => candidate.url === url)
  if (!record || !entry) {
    return { ok: false, error: 'That file is no longer listed for this page' }
  }
  if (entry.stream) {
    // Not reachable from the popup, which asks for a stream by a different message. It is
    // here so a stale popup or a crafted request cannot send us to `chrome.downloads` with
    // a url that has nothing to fetch.
    return { ok: false, error: 'That file cannot be saved on its own' }
  }
  if (!isDownloadable(entry)) {
    return { ok: false, error: 'That file cannot be saved on its own' }
  }

  const filename = buildFilename({
    pageTitle: record.pageTitle,
    url: entry.url,
    container: entry.container,
    quality: entry.quality,
  })

  try {
    // `saveAs: false`, so the browser takes the name this rule built rather than
    // asking for one. A dialog on every save would make the extension unusable.
    const downloadId = await chrome.downloads.download({ url, filename, saveAs: false })
    return { ok: true, downloadId }
  } catch (error) {
    // A dismissed dialog and a rejected permission both land here, and both mean the
    // row should offer its control again rather than sit at `in_progress` forever.
    return { ok: false, error: messageOf(error) }
  }
}

chrome.downloads.onChanged.addListener((delta) => {
  // The same shape as every other entry point here: an event with nobody waiting on it,
  // so a failure is counted rather than left to surface as an unhandled rejection. The
  // search is the part that can reject, since it is a call into the browser rather than
  // into this worker's own state.
  void (async () => {
    const [item] = await chrome.downloads.search({ id: delta.id })
    if (!item) return

    const state = DownloadStateSchema.safeParse(item.state)
    if (!state.success) return

    try {
      await chrome.runtime.sendMessage({
        name: 'DOWNLOAD_PROGRESS',
        payload: {
          downloadId: item.id,
          url: item.url,
          bytesReceived: item.bytesReceived,
          totalBytes: totalBytesOrNull(item.totalBytes),
          state: state.data,
        },
      })
    } catch {
      // The same swallow as the other broadcast: no popup open is not an error.
    }
  })().catch(() => {
    workerFailures += 1
  })
})

// ─── The content script's report ────────────────────────────────────────────

/**
 * Drops the entries the engine says should never be recorded.
 *
 * Decided here and not in the content script, which could have made the same call with the
 * engine already bundled in. One place decides, so the popup and the record can never
 * disagree about whether an encrypted stream exists, and the page's own report stays a
 * report rather than a decision.
 *
 * Neither kind is recorded rather than recorded and hidden. Scrambled bytes are not worth a
 * row at all, and a stream still collecting has nothing true to say, so a badge counting it
 * would claim the page holds media the list cannot show.
 */
function keepableDrafts(payload: EntriesReportedRequest): MediaEntryDraft[] {
  return payload.entries.filter(isListable)
}

/**
 * The streams this report lists, which is the whole of the live set.
 *
 * A report from the page is a full snapshot, so the ids it carries are everything the page
 * holds. Nothing extra is needed on the message to say so, and nothing else reports stream
 * entries: they come from the page and from nowhere else.
 */
function streamIdsIn(payload: EntriesReportedRequest): Set<number> {
  const ids = new Set<number>()
  for (const draft of payload.entries) {
    if (draft.stream) ids.add(draft.stream.streamId)
  }
  return ids
}

async function applyEntriesReport(
  payload: EntriesReportedRequest,
  tabId: number
): Promise<{ ok: true }> {
  const report: EntriesReportedRequest = { ...payload, entries: keepableDrafts(payload) }

  const result = await queue.run(tabId, async () => {
    const existing = await store.load(tabId)
    const applied = applyReport({ tabId, existing, report, now: Date.now() })

    // A stream whose bytes died with the page has to go, because the merge can fold and cap
    // but cannot delete. Asked of every report rather than of a report that mentions
    // streams, since a snapshot listing none is exactly the report that has to drop them.
    const record = dropUnknownStreams(applied.record, streamIdsIn(report))

    // Saved only when something moved. A report that changed nothing is already in storage,
    // and writing it again would churn storage on every page load for nothing.
    const changed = applied.changed || record !== applied.record
    if (changed) {
      await store.save(record)
      await setBadge(tabId, record)
    }
    return { changed }
  })

  // Only when the record differs from what was stored, so a page re-requesting the file it
  // is already playing does not become a re-read every few seconds.
  if (result.changed) await broadcastTabMedia(tabId)

  return { ok: true }
}

// ─── Assembling a stream, which only the page can do ────────────────────────

/**
 * Asks the page to put a stream's file together, naming it here first.
 *
 * The worker is the only party that knows the file name, which is why the name travels with
 * the request and why one message has two hops rather than the popup naming a file the popup
 * cannot check. The page holds the bytes and starts the download itself; the extension
 * never receives a media byte and never calls `chrome.downloads` for a stream.
 *
 * The target tab is the active one, as the file download path also does, because the
 * message carries no tab id and the popup is always about the tab in front of the user.
 */
async function assembleStream(url: string): Promise<StreamAssembleResponse> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const tabId = tab?.id
  if (tabId === undefined) return { ok: false, error: 'not_listed' }

  const record = await store.load(tabId)
  const entry = record?.entries.find((candidate) => candidate.url === url)
  if (!record || !entry?.stream) return { ok: false, error: 'not_listed' }

  const filename = buildFilename({
    pageTitle: record.pageTitle,
    url: entry.url,
    container: entry.container,
    quality: entry.quality,
    // A stream has no address to read a name off, so the page's own answer about the
    // element it is playing is the only thing between the page title and the fixed word.
    mediaElementName: entry.stream.mediaElementName,
  })

  let answer: unknown
  try {
    answer = await chrome.tabs.sendMessage(
      tabId,
      request('STREAM_ASSEMBLE', { url: entry.url, filename })
    )
  } catch {
    // No content script on the page, or it went away mid request. The page refused, as
    // opposed to the two refusals the worker decides for itself.
    return { ok: false, error: 'page_refused' }
  }

  // The answer comes from another world, so it is parsed rather than trusted, and an
  // unrecognised one is a refusal rather than a success nobody can account for.
  const parsed = StreamAssembleResponseSchema.safeParse(answer)
  return parsed.success ? parsed.data : { ok: false, error: 'page_refused' }
}

// ─── One router for the six messages ──────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const parsed = parseMessage(message)

  if (!parsed) {
    // Unrecognised, malformed, or from a build whose contract version differs. Dropped
    // and counted, never guessed at: a payload that half parses is how a row ends up
    // carrying a field from a shape the popup no longer renders.
    droppedMessages += 1
    return false
  }

  switch (parsed.name) {
    case 'ENTRIES_REPORTED': {
      const tabId = (sender as { tab?: { id?: number } }).tab?.id
      if (typeof tabId !== 'number') {
        droppedMessages += 1
        return false
      }
      void applyEntriesReport(parsed.payload, tabId).then(sendResponse, () =>
        answerAfterFailure(sendResponse)
      )
      return true
    }

    case 'GET_TAB_MEDIA': {
      void readTabMedia(parsed.payload.tabId).then(sendResponse, () =>
        answerAfterFailure(sendResponse)
      )
      return true
    }

    case 'DOWNLOAD_MEDIA': {
      void startDownload(parsed.payload.url).then(
        sendResponse,
        () =>
          answerAfterFailure(sendResponse, {
            ok: false,
            error: 'The download could not be started',
          })
      )
      return true
    }

    case 'STREAM_ASSEMBLE': {
      // The one message with two hops: the worker names the file, then forwards the request
      // down to the content script, which relays it into the page.
      void assembleStream(parsed.payload.url).then(
        sendResponse,
        () => answerAfterFailure(sendResponse, { ok: false, error: 'page_refused' })
      )
      return true
    }

    default:
      // The two broadcasts are the worker's own. A runtime that received one is not
      // this worker, so there is nothing to answer.
      return false
  }
})
