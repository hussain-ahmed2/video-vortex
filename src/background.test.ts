import { beforeEach, describe, expect, it, vi } from 'vitest'

import { installFakeChrome, type FakeChrome } from './testing'
import { recordKey, TABS_INDEX_KEY } from './engine/state-port'
import { CONTRACT_VERSION, type TabMedia } from './engine/types'

// The worker's two halves, proven against the fakes rather than hand walked.
//
// The worker is a module with top level side effects, which is how a service worker
// really behaves: it registers on load and is reloaded from the top every time Chrome
// wakes it. So each test installs a fresh browser, resets the module registry, and
// imports the worker again. That also makes the startup reconciliation observable,
// because it runs on every one of those imports.
//
// The worker is therefore imported dynamically and never at the top of this file: a
// static import would run its registration before the fake existed, and a service
// worker has no way to register later. The named imports below are bindings to the
// same live module, resolved after the first load.

const PAGE = 'https://example.com/watch'
const MP4 = 'https://cdn.example.com/media/clip.mp4'
const AUDIO = 'https://cdn.example.com/media/track.m4a'

let fake: FakeChrome

/** The worker module, held rather than imported, so it is loaded after the fake. */
type WorkerModule = typeof import('./background')

let worker: WorkerModule

/** Imports the worker fresh, so its listeners and its index reconciliation re-run. */
async function loadWorker(): Promise<void> {
  vi.resetModules()
  worker = await import('./background')
}

/**
 * Sends a message the way the browser does and resolves with the answer.
 *
 * The runtime fake's own `sendMessage` cannot be used for this: it hands the listener
 * an empty sender and reads the response synchronously, while this worker's answers
 * all arrive after an await. Firing the event directly is also what lets a test say
 * which tab a content script is running in.
 */
function ask(message: unknown, sender: unknown = {}): Promise<unknown> {
  return new Promise((resolve) => {
    fake.runtime.onMessage.fire(message, sender, resolve)
  })
}

/** Fires a message the worker is expected to decline, and reports what it returned. */
function decline(message: unknown, sender: unknown = {}): boolean | undefined {
  let kept = false
  fake.runtime.onMessage.fire(message, sender, () => {
    kept = true
  })
  return kept
}

function reportFrom(overrides: Record<string, unknown> = {}): unknown {
  return {
    name: 'ENTRIES_REPORTED',
    payload: {
      contractVersion: CONTRACT_VERSION,
      pageUrl: PAGE,
      pageTitle: 'Documentary Stream',
      status: 'ready',
      entries: [],
      ...overrides,
    },
  }
}

function readFrom(tabId: number): unknown {
  return { name: 'GET_TAB_MEDIA', payload: { contractVersion: CONTRACT_VERSION, tabId } }
}

async function storedRecord(tabId: number): Promise<TabMedia | null> {
  const stored = (await fake.storage.session.get(recordKey(tabId))) as Record<string, unknown>
  return (stored[recordKey(tabId)] as TabMedia | undefined) ?? null
}

beforeEach(async () => {
  fake = installFakeChrome([{ id: 1, url: PAGE, title: 'Documentary Stream' }])
  await loadWorker()
})

describe('the observer, which is the only way this extension sees media', () => {
  it('records a media response as one entry', async () => {
    fake.webRequest.control.respond({
      url: MP4,
      tabId: 1,
      contentType: 'video/mp4',
      contentLength: '2048',
    })
    await vi.waitFor(async () => expect(await storedRecord(1)).not.toBeNull())

    const record = await storedRecord(1)
    expect(record?.entries).toHaveLength(1)
    expect(record?.entries[0]?.url).toBe(MP4)
    expect(record?.entries[0]?.container).toBe('mp4')
    expect(record?.entries[0]?.sizeBytes).toBe(2048)
    expect(record?.entries[0]?.kind).toBe('video')
  })

  it('records the quality as unknown, because the fallback has no site to ask', async () => {
    fake.webRequest.control.respond({ url: MP4, tabId: 1, contentType: 'video/mp4' })
    await vi.waitFor(async () => expect(await storedRecord(1)).not.toBeNull())

    // A guess here would be a fabricated quality label on every row.
    expect((await storedRecord(1))?.entries[0]?.quality).toBe('unknown')
  })

  it('records the size as null when the body was encoded', async () => {
    // `Content-Length` then describes the compressed body, so reporting it would show
    // a size that is not the file's.
    fake.webRequest.control.respond({
      url: MP4,
      tabId: 1,
      contentType: 'video/mp4',
      contentLength: '2048',
      contentEncoding: 'gzip',
    })
    await vi.waitFor(async () => expect(await storedRecord(1)).not.toBeNull())

    expect((await storedRecord(1))?.entries[0]?.sizeBytes).toBeNull()
  })

  it('starts a new record when the tab has moved to another page', async () => {
    // A record belongs to the page it was made for. Merging the new page's media into
    // the old page's record meant the next read deleted the lot, taking the new page's
    // media with it, and the user saw an empty list until they reloaded.
    fake.webRequest.control.respond({ url: MP4, tabId: 1, contentType: 'video/mp4' })
    await vi.waitFor(async () => expect(await storedRecord(1)).not.toBeNull())
    fake.tabs.control.setTab({ id: 1, url: 'https://example.com/next' })

    const next = 'https://cdn.example.com/other.mp4'
    fake.webRequest.control.respond({ url: next, tabId: 1, contentType: 'video/mp4' })

    await vi.waitFor(async () => {
      const record = await storedRecord(1)
      expect(record?.entries?.map((entry) => entry.url)).toEqual([next])
    })
    expect((await storedRecord(1))?.pageUrl).toBe('https://example.com/next')
  })

  it('keeps adding to the same record while the tab stays on its page', async () => {
    fake.webRequest.control.respond({ url: MP4, tabId: 1, contentType: 'video/mp4' })
    await vi.waitFor(async () => expect(await storedRecord(1)).not.toBeNull())
    fake.webRequest.control.respond({
      url: 'https://cdn.example.com/other.mp4',
      tabId: 1,
      contentType: 'video/mp4',
    })

    await vi.waitFor(async () => expect((await storedRecord(1))?.entries).toHaveLength(2))
    expect((await storedRecord(1))?.pageUrl).toBe('https://example.com/watch')
  })

  it('records only the final response of a redirect chain', async () => {
    fake.webRequest.control.respond({
      url: MP4,
      tabId: 1,
      statusCode: 302,
      contentType: 'video/mp4',
    })
    fake.webRequest.control.respond({ url: MP4, tabId: 1, contentType: 'video/mp4' })
    await vi.waitFor(async () => expect(await storedRecord(1)).not.toBeNull())

    const record = await storedRecord(1)
    expect(record?.entries).toHaveLength(1)
    expect(record?.entries[0]?.url).toBe(MP4)
  })

  it('records nothing for a redirect, even when its path names a container', async () => {
    // A 302 answers with the same path extension as the 200 that follows it, so a gate
    // that let the container through without looking at the status stored both urls of
    // the chain as two entries. Only a response that delivered the file is a finding.
    fake.webRequest.control.respond({
      url: MP4,
      tabId: 1,
      statusCode: 302,
      contentType: 'video/mp4',
    })
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(await storedRecord(1)).toBeNull()
  })

  it('lists a manifest, because a row with no control is the requirement, not no row', async () => {
    // AC-4: a row whose container is not downloadable renders with no download control
    // at all. That only means something if the row exists, and the gate that used to
    // ask "is this downloadable" dropped it before it could be listed.
    fake.webRequest.control.respond({
      url: 'https://cdn.example.com/master.m3u8',
      tabId: 1,
      contentType: 'application/vnd.apple.mpegurl',
    })

    await vi.waitFor(async () => expect(await storedRecord(1)).not.toBeNull())
    expect((await storedRecord(1))?.entries[0]?.container).toBe('m3u8')
  })

  it('ignores a response that is not media at all', async () => {
    fake.webRequest.control.respond({
      url: 'https://example.com/index.html',
      tabId: 1,
      contentType: 'text/html',
      contentLength: '9000',
    })
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(await storedRecord(1)).toBeNull()
  })

  it('ignores a request with no page behind it', async () => {
    // A negative tab id is this extension's own request, or a prefetch: there is no
    // tab to list it on.
    fake.webRequest.control.respond({ url: MP4, tabId: -1, contentType: 'video/mp4' })
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(await storedRecord(-1)).toBeNull()
  })

  it('asks for response headers, without which it would see no size or type', () => {
    const registration = fake.webRequest.control.registration()

    expect(registration?.urls).toEqual(['<all_urls>'])
    expect(registration?.extraInfoSpec).toEqual(['responseHeaders'])
  })

  it('splits an audio only file into the audio list', async () => {
    fake.webRequest.control.respond({ url: AUDIO, tabId: 1, contentType: 'audio/mp4' })
    await vi.waitFor(async () => expect(await storedRecord(1)).not.toBeNull())

    expect((await storedRecord(1))?.entries[0]?.kind).toBe('audio')
  })
})

describe('two responses arriving together', () => {
  it('keeps both entries rather than one overwriting the other', async () => {
    // The serialisation is the point: without one chain per tab, two reports interleave
    // between one task's read and its write and the second write lands on a stale read.
    fake.webRequest.control.respond({ url: MP4, tabId: 1, contentType: 'video/mp4' })
    fake.webRequest.control.respond({ url: AUDIO, tabId: 1, contentType: 'audio/mp4' })

    await vi.waitFor(async () => {
      const record = await storedRecord(1)
      expect(record?.entries).toHaveLength(2)
    })
  })

  it('counts one file once however many times the page re-requests it', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      fake.webRequest.control.respond({ url: MP4, tabId: 1, contentType: 'video/mp4' })
    }

    await vi.waitFor(async () => expect(await storedRecord(1)).not.toBeNull())
    await new Promise((resolve) => setTimeout(resolve, 5))

    const record = await storedRecord(1)
    expect(record?.entries).toHaveLength(1)
    expect(record?.hiddenCount).toBe(0)
  })
})

// covers: AC-16
describe('the badge, the only thing a person sees with the popup closed', () => {
  it('counts the entries the popup is showing', async () => {
    fake.webRequest.control.respond({ url: MP4, tabId: 1, contentType: 'video/mp4' })
    await vi.waitFor(() => expect(fake.action.control.badgeText(1)).toBe('1'))
  })

  it('includes what the cap is holding back, so it never understates', async () => {
    // Fifty entries plus one dropped reads "2", which would look like a bug to anyone
    // who has not read the hidden count line.
    for (let index = 0; index < 51; index += 1) {
      fake.webRequest.control.respond({
        url: `https://cdn.example.com/media/${index}.mp4`,
        tabId: 1,
        contentType: 'video/mp4',
      })
    }

    await vi.waitFor(() => expect(fake.action.control.badgeText(1)).toBe('51'))
  })

  it('caps at 99+, because Chrome renders four characters', () => {
    const record = {
      entries: new Array(60).fill({}),
      hiddenCount: 60,
    } as unknown as TabMedia

    expect(worker.badgeTextFor(record)).toBe('99+')
  })

  it('is empty when there is nothing, and when the record is gone', () => {
    expect(worker.badgeTextFor(null)).toBe('')
    expect(worker.badgeTextFor({ entries: [], hiddenCount: 0 } as unknown as TabMedia)).toBe('')
  })
})

describe('the read the popup makes', () => {
  it('injects the content script when a record exists but nothing has reported yet', async () => {
    // The observer creates a record the moment a page requests media, which is normally
    // long before anyone opens the popup. A read that returns that record without
    // injecting leaves the content script unrun, so nothing ever reports, so the record
    // stays `observing` for the life of the tab and the popup shows skeletons forever.
    fake.webRequest.control.respond({ url: MP4, tabId: 1, contentType: 'video/mp4' })
    await vi.waitFor(async () => expect(await storedRecord(1)).not.toBeNull())
    expect((await storedRecord(1))?.status).toBe('observing')

    const response = (await ask(readFrom(1))) as { record: TabMedia | null }

    // Two files in two worlds: the content script isolated, and the hook in the page's own
    // world because a SourceBuffer cannot be read back from outside the page.
    expect(fake.scripting.control.calls()).toEqual([
      { tabId: 1, files: ['content.js'] },
      { tabId: 1, files: ['hook.js'], world: 'MAIN' },
    ])
    // The record is still answered, so the popup has something to show the moment the
    // report promotes the status.
    expect(response.record?.entries).toHaveLength(1)
  })

  it('does not inject again once the record has been reported', async () => {
    // Injection is cheap but not free, and a record that has already been reported has
    // nothing left to learn from a content script.
    fake.webRequest.control.respond({ url: MP4, tabId: 1, contentType: 'video/mp4' })
    await vi.waitFor(async () => expect(await storedRecord(1)).not.toBeNull())
    await ask(reportFrom(), { tab: { id: 1 } })
    fake.scripting.control.calls()

    await ask(readFrom(1))

    expect(fake.scripting.control.calls()).toEqual([])
  })

  it('answers with the stored record when the tab has one', async () => {
    fake.webRequest.control.respond({ url: MP4, tabId: 1, contentType: 'video/mp4' })
    await vi.waitFor(async () => expect(await storedRecord(1)).not.toBeNull())
    await ask(reportFrom(), { tab: { id: 1 } })

    const response = (await ask(readFrom(1))) as {
      record: TabMedia | null
      status: string
      needsReport: boolean
    }

    expect(response.record?.entries).toHaveLength(1)
    expect(response.status).toBe('ready')
    expect(response.needsReport).toBe(false)
  })

  it('reads a record the observer made as still observing, because nothing has reported', async () => {
    // The status is the record's own, and only a report promotes it. Reporting `ready`
    // here would show a resting list over a page the engine has not heard from.
    fake.webRequest.control.respond({ url: MP4, tabId: 1, contentType: 'video/mp4' })
    await vi.waitFor(async () => expect(await storedRecord(1)).not.toBeNull())

    const response = (await ask(readFrom(1))) as { record: TabMedia | null; status: string }

    expect(response.record?.entries).toHaveLength(1)
    expect(response.status).toBe('observing')
  })

  it('injects a content script and asks the popup to wait when there is no record', async () => {
    // The only way a tab that predates the extension is ever looked at.
    const response = (await ask(readFrom(1))) as { needsReport: boolean; status: string }

    expect(response.needsReport).toBe(true)
    expect(response.status).toBe('observing')
    // Two files in two worlds: the content script isolated, and the hook in the page's own
    // world because a SourceBuffer cannot be read back from outside the page.
    expect(fake.scripting.control.calls()).toEqual([
      { tabId: 1, files: ['content.js'] },
      { tabId: 1, files: ['hook.js'], world: 'MAIN' },
    ])
  })

  it('names the unwatchable state rather than showing an empty list', async () => {
    for (const url of ['chrome://extensions', 'about:blank', 'edge://settings']) {
      fake.tabs.control.setTab({ id: 9, url })
      const response = (await ask(readFrom(9))) as { status: string; needsReport: boolean }

      expect(response.status).toBe('unsupported')
      expect(response.needsReport).toBe(false)
    }
  })

  it('names the store listing pages, which look ordinary but cannot be injected into', () => {
    expect(worker.canHostContentScript('https://chromewebstore.google.com/detail/x')).toBe(false)
    expect(worker.canHostContentScript('https://example.com/watch')).toBe(true)
  })

  it('treats a page that refuses injection as unwatchable', async () => {
    // A file the user has not granted access to reaches the same outcome by a
    // different route, and the popup must say so either way.
    fake.scripting.control.setInjectionFails(true)

    const response = (await ask(readFrom(1))) as { status: string }

    expect(response.status).toBe('unsupported')
  })

  it('deletes a record left behind by a page the user has left', async () => {
    fake.webRequest.control.respond({ url: MP4, tabId: 1, contentType: 'video/mp4' })
    await vi.waitFor(async () => expect(await storedRecord(1)).not.toBeNull())
    fake.tabs.control.setTab({ id: 1, url: 'https://example.com/somewhere-else' })

    const response = (await ask(readFrom(1))) as { record: TabMedia | null; needsReport: boolean }

    expect(response.record).toBeNull()
    expect(response.needsReport).toBe(true)
    expect(await storedRecord(1)).toBeNull()
    expect(fake.action.control.badgeText(1)).toBe('')
  })

  it('discards a record that fails its schema rather than repairing it', async () => {
    // A half understood record is worse than an empty one, because every row in it is
    // suspect.
    await fake.storage.session.set({
      [recordKey(1)]: { tabId: 1, pageUrl: PAGE, entries: 'not entries' },
    })

    const response = (await ask(readFrom(1))) as { record: TabMedia | null; needsReport: boolean }

    expect(response.record).toBeNull()
    expect(response.needsReport).toBe(true)
  })

  it('carries only the transfers whose urls are in this record', async () => {
    fake.webRequest.control.respond({ url: MP4, tabId: 1, contentType: 'video/mp4' })
    await vi.waitFor(async () => expect(await storedRecord(1)).not.toBeNull())

    // `search({})` returns every remembered download across every tab, so filtering
    // here is what stops a row on this tab showing another tab's progress.
    await fake.downloads.download({ url: MP4, filename: 'a.mp4' })
    await fake.downloads.download({ url: 'https://other.example.com/x.mp4', filename: 'b.mp4' })

    const response = (await ask(readFrom(1))) as { inFlight: Array<{ url: string }> }

    expect(response.inFlight).toHaveLength(1)
    expect(response.inFlight[0]?.url).toBe(MP4)
  })

  it('maps Chrome minus one to a null total, so the row can say the size is unknown', async () => {
    fake.webRequest.control.respond({ url: MP4, tabId: 1, contentType: 'video/mp4' })
    await vi.waitFor(async () => expect(await storedRecord(1)).not.toBeNull())
    await fake.downloads.download({ url: MP4, filename: 'a.mp4' })

    const response = (await ask(readFrom(1))) as { inFlight: Array<{ totalBytes: number | null }> }

    expect(response.inFlight[0]?.totalBytes).toBeNull()
  })
})

describe('the report the content script sends', () => {
  it('creates a record and answers ok', async () => {
    const response = await ask(reportFrom(), { tab: { id: 1 } })

    expect(response).toEqual({ ok: true })
    expect((await storedRecord(1))?.status).toBe('ready')
  })

  it('keeps media the observer already found, because the report is for the same page', async () => {
    fake.webRequest.control.respond({ url: MP4, tabId: 1, contentType: 'video/mp4' })
    await vi.waitFor(async () => expect(await storedRecord(1)).not.toBeNull())

    await ask(reportFrom(), { tab: { id: 1 } })

    const record = await storedRecord(1)
    expect(record?.entries).toHaveLength(1)
    expect(record?.pageTitle).toBe('Documentary Stream')
  })

  it('replaces the record when the report is for another page', async () => {
    fake.webRequest.control.respond({ url: MP4, tabId: 1, contentType: 'video/mp4' })
    await vi.waitFor(async () => expect(await storedRecord(1)).not.toBeNull())

    await ask(reportFrom({ pageUrl: 'https://example.com/next' }), { tab: { id: 1 } })

    const record = await storedRecord(1)
    expect(record?.pageUrl).toBe('https://example.com/next')
    expect(record?.entries).toHaveLength(0)
  })

  it('tells the popup only when the record actually moved', async () => {
    const broadcasts: unknown[] = []
    fake.runtime.onMessage.addListener((message) => {
      const parsed = message as { name?: string }
      if (parsed.name === 'TAB_MEDIA_UPDATED') broadcasts.push(message)
    })

    await ask(reportFrom(), { tab: { id: 1 } })
    await ask(reportFrom(), { tab: { id: 1 } })

    // A title only report that changes nothing must not wake the popup, or a page
    // re-reporting on every load becomes a re-read on every load.
    expect(broadcasts).toHaveLength(1)
  })
})

describe('messages the worker will not act on', () => {
  it('drops an unrecognised name and counts it', () => {
    const before = worker.droppedMessageCount()

    expect(decline({ name: 'FETCH_YOUTUBE_DATA', payload: {} })).toBe(false)
    expect(worker.droppedMessageCount()).toBe(before + 1)
  })

  it('drops a payload that fails its schema and counts it', () => {
    const before = worker.droppedMessageCount()

    expect(decline({ name: 'GET_TAB_MEDIA', payload: { contractVersion: CONTRACT_VERSION } })).toBe(
      false
    )
    expect(worker.droppedMessageCount()).toBe(before + 1)
  })

  it('drops a request from a build whose contract version differs', () => {
    const before = worker.droppedMessageCount()

    expect(
      decline({ name: 'GET_TAB_MEDIA', payload: { contractVersion: 99, tabId: 1 } })
    ).toBe(false)
    expect(worker.droppedMessageCount()).toBe(before + 1)
  })

  it('drops a report with no tab behind it, since there is nowhere to put it', () => {
    const before = worker.droppedMessageCount()

    expect(decline(reportFrom())).toBe(false)
    expect(worker.droppedMessageCount()).toBe(before + 1)
  })

  it('declines its own broadcasts', () => {
    // A runtime that received one is not this worker, so there is nothing to answer.
    expect(decline({ name: 'TAB_MEDIA_UPDATED', payload: { tabId: 1 } })).toBe(false)
  })
})

describe('a handler that fails', () => {
  // A handler that rejects used to leave its response channel open, because the router
  // answered with `.then(sendResponse)` and nothing caught. The sender then waited
  // forever: the popup's read never settled and the row never came back. These three are
  // the same failure seen from the three messages that can fail.

  /** The answer, or the string `never answered` when the channel stayed open. */
  const answerOrSilence = async (message: unknown): Promise<unknown> =>
    Promise.race([
      ask(message),
      new Promise((resolve) => setTimeout(() => resolve('never answered'), 80)),
    ])

  // covers: AC-2, AC-19
  it('still answers a read whose own work failed', async () => {
    fake.webRequest.control.respond({ url: MP4, tabId: 1, contentType: 'video/mp4' })
    await vi.waitFor(async () => expect(await storedRecord(1)).not.toBeNull())

    // The downloads API is what a read consults for anything in flight, and it is the
    // one dependency in that path whose failure the worker cannot see coming.
    fake.downloads.search = () => Promise.reject(new Error('downloads is unavailable'))

    expect(await answerOrSilence(readFrom(1))).not.toBe('never answered')
  })

  // covers: AC-4
  it('still answers a download whose own work failed', async () => {
    fake.webRequest.control.respond({ url: MP4, tabId: 1, contentType: 'video/mp4' })
    await vi.waitFor(async () => expect(await storedRecord(1)).not.toBeNull())

    fake.tabs.query = () => Promise.reject(new Error('no window'))

    const answer = await answerOrSilence({
      name: 'DOWNLOAD_MEDIA',
      payload: { contractVersion: CONTRACT_VERSION, url: MP4 },
    })

    expect(answer).not.toBe('never answered')
    expect(answer).toEqual({ ok: false, error: 'The download could not be started' })
  })

  // covers: AC-1, AC-16
  it('counts a failure during the observer and keeps serving', async () => {
    // The observer has nobody to answer, so a rejection here used to surface as an
    // unhandled rejection in the worker with nothing recorded anywhere. A badge that will
    // not write is the realistic trigger: it happens whenever a tab closes mid response.
    const before = worker.workerFailureCount()
    fake.action.setBadgeText = () => Promise.reject(new Error('the tab went away'))

    fake.webRequest.control.respond({ url: MP4, tabId: 1, contentType: 'video/mp4' })
    await vi.waitFor(async () => expect(worker.workerFailureCount()).toBe(before + 1))

    // And the worker is still there afterwards, which is what the count is for.
    fake.webRequest.control.respond({ url: AUDIO, tabId: 1, contentType: 'audio/mp4' })
    await vi.waitFor(async () => expect((await storedRecord(1))?.entries).toHaveLength(2))
  })
});

describe('closing a tab', () => {
  it('deletes its record, its index entry and its badge', async () => {
    fake.webRequest.control.respond({ url: MP4, tabId: 1, contentType: 'video/mp4' })
    await vi.waitFor(async () => expect(await storedRecord(1)).not.toBeNull())

    fake.tabs.onRemoved.fire(1)
    await vi.waitFor(async () => expect(await storedRecord(1)).toBeNull())

    const index = (await fake.storage.session.get(TABS_INDEX_KEY)) as { [TABS_INDEX_KEY]: number[] }
    expect(index[TABS_INDEX_KEY]).toEqual([])
    expect(fake.action.control.badgeText(1)).toBe('')
  })
})

describe('starting the worker again', () => {
  // covers: AC-18
  it('re-registers the observer, which is what makes detection work after a stop', async () => {
    // A service worker's script is re-run from the top when something wakes it, so a
    // listener added at the top level is re-registered every time.
    fake.webRequest.control.respond({ url: MP4, tabId: 1, contentType: 'video/mp4' })
    await vi.waitFor(async () => expect(await storedRecord(1)).not.toBeNull())
    await fake.storage.session.remove(recordKey(1))

    await loadWorker()
    fake.webRequest.control.respond({ url: MP4, tabId: 1, contentType: 'video/mp4' })

    await vi.waitFor(async () => expect(await storedRecord(1)).not.toBeNull())
  })

  it('drops a record whose tab no longer exists', async () => {
    // A record left behind by a crash is invisible otherwise: nothing will ever write
    // to that tab again, so nothing will ever remove it.
    await fake.storage.session.set({
      [recordKey(42)]: { tabId: 42 },
      [TABS_INDEX_KEY]: [42],
    })

    await loadWorker()

    await vi.waitFor(async () => {
      const index = (await fake.storage.session.get(TABS_INDEX_KEY)) as { [TABS_INDEX_KEY]: number[] }
      expect(index[TABS_INDEX_KEY]).toEqual([])
    })
  })

  it('keeps a record whose tab is still open', async () => {
    fake.webRequest.control.respond({ url: MP4, tabId: 1, contentType: 'video/mp4' })
    await vi.waitFor(async () => expect(await storedRecord(1)).not.toBeNull())

    await loadWorker()

    const index = (await fake.storage.session.get(TABS_INDEX_KEY)) as { [TABS_INDEX_KEY]: number[] }
    expect(index[TABS_INDEX_KEY]).toEqual([1])
    expect(await storedRecord(1)).not.toBeNull()
  })
})
// ─── Spec 0005: the worker's half of the stream feature ────────────────────

/** The signals a page reports for a MediaSource stream, with overrides. */
function streamSignals(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    streamId: 1,
    origin: 'mse',
    bytes: 2048,
    bufferedBytes: 2048,
    live: false,
    encrypted: false,
    ended: false,
    partialReason: 'none',
    mediaElementName: null,
    ...overrides,
  }
}

/** A stream finding as the content script would report it. */
function streamDraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const signals = streamSignals(overrides)
  return {
    url: `vortex-stream:https%3A%2F%2Fexample%2Ecom%2Fwatch#${signals.streamId}`,
    container: 'webm',
    quality: 'unknown',
    kind: 'video',
    sizeBytes: 2048,
    sources: ['page-stream-hook'],
    reason: 'assembled by the page',
    stream: signals,
  }
}

const downloadCalls: { url: string; filename?: string }[] = []

/** Every call the worker made to `chrome.downloads.download`, which a stream must never make. */
function downloadsCalled(): { url: string; filename?: string }[] {
  return downloadCalls
}

/** The assembly request the popup sends, with no name, because the worker derives it. */
function STREAM_ASSEMBLE(url: string): unknown {
  return { name: 'STREAM_ASSEMBLE', payload: { contractVersion: CONTRACT_VERSION, url } }
}

/** The file download request, which a stream must never be sent through. */
function DOWNLOAD_MEDIA(url: string): unknown {
  return { name: 'DOWNLOAD_MEDIA', payload: { contractVersion: CONTRACT_VERSION, url } }
}

beforeEach(() => {
  downloadCalls.length = 0
  const real = fake.downloads.download.bind(fake.downloads)
  fake.downloads.download = (options: { url: string; filename?: string }) => {
    downloadCalls.push(options)
    return real(options)
  }
})

/** Reports the page's streams to the worker, from the content script on tab 1. */
function reportStreams(entries: unknown[], overrides: Record<string, unknown> = {}): Promise<unknown> {
  return ask({ ...(reportFrom({ entries, ...overrides }) as object) }, { tab: { id: 1 } })
}

/** What the worker forwarded down to the content script for the active tab. */
function forwardedToTab(tabId: number): { message: unknown }[] {
  return fake.tabs.control.sentMessages().filter((sent) => sent.tabId === tabId)
}

describe('the worker discarding what the engine says should never be recorded', () => {
  it('never records an encrypted stream, because scrambled bytes are not a row', async () => {
    await reportStreams([streamDraft({ encrypted: true })])

    const record = await storedRecord(1)
    expect(record?.entries).toEqual([])
  })

  it('records no stream that is still collecting, because it has nothing to show', async () => {
    await reportStreams([streamDraft({ bytes: 0, bufferedBytes: 0 })])

    // Recorded and hidden would leave the badge claiming media the list cannot show, which is
    // the one thing a count must never do.
    const record = await storedRecord(1)
    expect(record?.entries).toEqual([])
  })

  it('records a stream that lost bytes even though it never played', async () => {
    await reportStreams([streamDraft({ bufferedBytes: 0, partialReason: 'broken' })])

    // The opposite of the two above: this is exactly when a person needs telling, so it gets a
    // row and the row says what went wrong.
    expect((await storedRecord(1))?.entries).toHaveLength(1)
  })

  it('keeps the stream the engine does not derive as encrypted', async () => {
    await reportStreams([streamDraft(), streamDraft({ streamId: 2, encrypted: true })])

    const record = await storedRecord(1)
    expect(record?.entries).toHaveLength(1)
    expect(record?.entries[0]?.stream?.streamId).toBe(1)
  })

})

describe('a stream whose bytes died with the page', () => {
  it('is dropped by a later snapshot that does not list it', async () => {
    await reportStreams([streamDraft(), streamDraft({ streamId: 2 })])
    expect((await storedRecord(1))?.entries).toHaveLength(2)

    await reportStreams([])

    // The merge can fold and cap but cannot delete, so this is the only thing that can take
    // a row away once it is there.
    expect((await storedRecord(1))?.entries).toEqual([])
  })

  it('is dropped along with the key that was counting it, so the hidden count stays honest', async () => {
    await reportStreams([streamDraft()])
    const before = await storedRecord(1)
    expect(before?.hiddenCount).toBe(0)

    await reportStreams([])

    // `hiddenCount` is counted less held, so a dropped stream left in `seenKeys` would keep
    // inflating what the cap claims to be holding back, by exactly one per dead stream.
    const after = await storedRecord(1)
    expect(after?.hiddenCount).toBe(0)
    expect(after?.seenKeys).toEqual([])
  })

  it('never touches a file entry, because the observer has no snapshot and no streams', async () => {
    fake.webRequest.control.respond({ url: MP4, tabId: 1, contentType: 'video/mp4' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    await reportStreams([])

    const record = await storedRecord(1)
    expect(record?.entries.map((entry) => entry.url)).toEqual([MP4])
  })

  it('tells the popup, because a row that vanished is something to look at', async () => {
    await reportStreams([streamDraft()])

    const broadcasts: unknown[] = []
    fake.runtime.onMessage.addListener((message) => {
      if ((message as { name?: string }).name === 'TAB_MEDIA_UPDATED') broadcasts.push(message)
    })

    await reportStreams([])

    expect(broadcasts).toHaveLength(1)
  })
})

describe("the assembly request, which has two hops", () => {
  /** Puts a listed stream in the record, the way a page report would. */
  async function listAStream(
    overrides: Record<string, unknown> = {},
    report: Record<string, unknown> = {}
  ): Promise<string> {
    await reportStreams([streamDraft(overrides)], report)
    const record = await storedRecord(1)
    return record?.entries[0]?.url as string
  }

  it('looks the entry up and refuses a url that is not listed', async () => {
    await listAStream()

    await expect(ask(STREAM_ASSEMBLE('https://cdn.example.com/clip.mp4'))).resolves.toEqual({
      ok: false,
      error: 'not_listed',
    })
  })

  it('forwards the request to the tab with the name it derived', async () => {
    const url = await listAStream()
    fake.tabs.control.setContentScriptListener((message, _sender, sendResponse) => {
      const payload = (message as { payload?: { url?: string } }).payload
      if (payload?.url === url) sendResponse({ ok: true })
      return true
    })

    await ask(STREAM_ASSEMBLE(url))

    const [forwarded] = forwardedToTab(1)
    expect(forwarded?.message).toMatchObject({
      name: 'STREAM_ASSEMBLE',
      payload: { url, filename: 'Documentary_Stream.webm' },
    })
  })

  it('never asks Chrome to download a stream, because a stream has nothing to fetch', async () => {
    const url = await listAStream()
    fake.tabs.control.setContentScriptListener((_message, _sender, sendResponse) => {
      sendResponse({ ok: true })
      return true
    })

    await ask(STREAM_ASSEMBLE(url))

    // `chrome.downloads.download` is never called for a stream: the page produces the file
    // from bytes it already holds and starts the download itself.
    expect(downloadsCalled()).toEqual([])
  })

  it('names the file from the media element rather than from a url it does not have', async () => {
    // A stream's url is one we minted, so reading a name off it would name every stream on
    // the page after the page.
    // Untitled, because the page title is the first step of the rule and the element name is
    // only reached once there is no title to use.
    const url = await listAStream({ mediaElementName: 'Episode_Two' }, { pageTitle: '' })
    fake.tabs.control.setContentScriptListener((_message, _sender, sendResponse) => {
      sendResponse({ ok: true })
      return true
    })

    await ask(STREAM_ASSEMBLE(url))

    const [forwarded] = forwardedToTab(1)
    expect(forwarded?.message).toMatchObject({
      payload: { filename: 'Episode_Two.webm' },
    })
  })

  it('answers with what the page said, rather than assuming it worked', async () => {
    const url = await listAStream()
    fake.tabs.control.setContentScriptListener((_message, _sender, sendResponse) => {
      sendResponse({ ok: false, error: 'already_running' })
      return true
    })

    await expect(ask(STREAM_ASSEMBLE(url))).resolves.toEqual({
      ok: false,
      error: 'already_running',
    })
  })

  it('treats an answer it does not recognise as a refusal', async () => {
    const url = await listAStream()
    fake.tabs.control.setContentScriptListener((_message, _sender, sendResponse) => {
      sendResponse({ ok: 'yes' })
      return true
    })

    await expect(ask(STREAM_ASSEMBLE(url))).resolves.toEqual({
      ok: false,
      error: 'page_refused',
    })
  })

  it('treats a page with no content script as a refusal', async () => {
    const url = await listAStream()
    fake.tabs.control.setContentScriptListening(false)

    await expect(ask(STREAM_ASSEMBLE(url))).resolves.toEqual({
      ok: false,
      error: 'page_refused',
    })
  })

  it('sends the content script the same message the popup sent', async () => {
    // One schema at both hops, or zod would strip the name in transit and the page would be
    // handed a file called nothing.
    const url = await listAStream()
    fake.tabs.control.setContentScriptListener((_message, _sender, sendResponse) => {
      sendResponse({ ok: true })
      return true
    })

    await ask(STREAM_ASSEMBLE(url))

    const [forwarded] = forwardedToTab(1)
    const payload = (forwarded?.message as { payload: { contractVersion: number } }).payload
    expect(payload.contractVersion).toBe(CONTRACT_VERSION)
  })
})

describe('a stream reaching the file download path', () => {
  it('is refused, so nothing tries to fetch a url that has no bytes behind it', async () => {
    await reportStreams([streamDraft()])
    const url = (await storedRecord(1))?.entries[0]?.url as string

    await expect(ask(DOWNLOAD_MEDIA(url))).resolves.toEqual({
      ok: false,
      error: 'That file cannot be saved on its own',
    })
    expect(downloadsCalled()).toEqual([])
  })
})

describe('injecting the hook alongside the content script', () => {
  it('still reads the page when the hook cannot be put in the page own world', async () => {
    // Rare, and answering "this page cannot be watched" for it would be a lie: the network
    // observer still works and so does everything the content script reports.
    fake.scripting.control.setInjectionFails(true, ['hook.js'])

    const response = (await ask(readFrom(1))) as { status: string }

    expect(response.status).toBe('observing')
    expect(fake.scripting.control.calls().map((call) => call.files[0])).toEqual([
      'content.js',
      'hook.js',
    ])
  })

  it('counts a refused hook as a failure rather than losing it', async () => {
    const before = worker.workerFailureCount()
    fake.scripting.control.setInjectionFails(true, ['hook.js'])

    await ask(readFrom(1))

    // Counted rather than thrown: an unhandled rejection in a service worker is a bug report
    // nobody wrote, and a stream nobody can see is a gap rather than a crash.
    expect(worker.workerFailureCount()).toBe(before + 1)
  })

  it('answers that the page cannot be watched when the content script itself is refused', async () => {
    fake.scripting.control.setInjectionFails(true)

    const response = (await ask(readFrom(1))) as { status: string }

    expect(response.status).toBe('unsupported')
    expect(fake.scripting.control.calls()).toHaveLength(1)
  })
})