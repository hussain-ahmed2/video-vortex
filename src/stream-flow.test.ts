// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CONTRACT_VERSION, type TabMedia } from './engine/types'
import { recordKey } from './engine/state-port'
import {
  installFakeBlobUrls,
  installFakeMediaElements,
  installFakePageMedia,
  installFakeChrome,
  type FakeChrome,
} from './testing'

// The whole chain, once, with nothing stubbed in the middle.
//
// Every other test in this slice stubs one of its neighbours: the hook is tested with a
// stand in for the relay, the relay with a stand in for the page, the worker with a stand in
// for the content script. That is the right way to test each and the wrong way to find a
// shape that two halves disagree about, because each half is written against the schema and
// the schema is satisfied by construction on both sides. This file is where a disagreement
// would show up, because here the page's own bytes travel all the way to the record and the
// assembled file comes back the other way.
//
// Three runtimes in one jsdom window, which is not how Chrome runs them and is the only way
// to prove the seams without a browser. The two seams that matter are carried faithfully: the
// hook's world is the window, and the isolated world is the same window plus a `chrome`.
//
// covers: AC-1, AC-4, AC-5, AC-10, AC-13, AC-14, AC-15, AC-17

const PAGE = 'https://example.com/watch'
const MIME = 'video/webm; codecs="vp8, vorbis"'
const HOOK_STAMP = '__videoVortexHookBuild'
const CONTENT_STAMP = '__videoVortexContractVersion'

let fake: FakeChrome
let page: ReturnType<typeof installFakePageMedia>
let urls: ReturnType<typeof installFakeBlobUrls>
let players: ReturnType<typeof installFakeMediaElements>

/** Every download the page was asked to start, read off the link the hook clicked. */
let clicked: { href: string; download: string }[]

/** The page listeners this test's runtimes added, so they can be taken off again. */
let pageListeners: (EventListenerOrEventListenerObject)[] = []

/** One turn per hop on the page's message bus, which is one turn each way. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/**
 * Loads the three runtimes, in the order Chrome loads them.
 *
 * The worker first because it is the one that has to be listening before anything reports.
 * The content script before the hook because the hook greets and the greeting is answered.
 * Each file is stamped on the page on load, so a second import of the same build does
 * nothing, which is why the stamps are cleared here rather than in `beforeEach`.
 */
async function loadAll(): Promise<void> {
  vi.resetModules()

  // The worker first, because it is the one that has to be listening before anything reports.
  await import('./background')

  // The content script's own listener, found by watching for the one it adds. It then has to
  // be named to the tabs fake, because in Chrome a tab message reaches the content scripts
  // in that tab and nothing else, while every extension context here shares one registry.
  // Delivering to the whole registry would hand the worker back the request it forwards, and
  // the worker would answer itself forever.
  const before = new Set(fake.runtime.onMessage.listeners);
  await import('./content');
  const relay = [...fake.runtime.onMessage.listeners].find((listener) => !before.has(listener));
  if (!relay) throw new Error('the content script registered no listener');
  fake.tabs.control.setContentScriptListener(relay);

  // The hook last, because the content script's greeting is what installs it.
  await import('./hook')
  await flush();
}

/** The record the worker is holding for the tab, or null. */
async function stored(): Promise<TabMedia | null> {
  const raw = (await fake.storage.session.get(recordKey(1))) as Record<string, unknown>
  return (raw[recordKey(1)] as TabMedia | undefined) ?? null
}

/**
 * The record, once it holds the stream the page reported.
 *
 * `bytes` is what it waits on rather than the entry count, because a record holding a stream
 * is true one report too early: the first chunk lands, the row appears, and the rest of the
 * file is still on its way.
 */
async function storedWithBytes(bytes: number): Promise<TabMedia> {
  let found: TabMedia | null | undefined
  await vi.waitFor(async () => {
    found = await stored()
    expect(found?.entries[0]?.stream?.bytes).toBe(bytes)
  })
  return found as TabMedia
}

/** The record, once it holds any stream at all. */
async function storedWithStream(): Promise<TabMedia> {
  let found: TabMedia | null | undefined
  await vi.waitFor(async () => {
    found = await stored()
    expect(found?.entries.length ?? 0).toBeGreaterThan(0)
  })
  return found as TabMedia
}

/** Asks the worker something, the way the popup does, and resolves with its answer. */
function ask(message: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    fake.runtime.onMessage.fire(message, {}, resolve)
  })
}

/** A page playing through MediaSource, the way most sites do. */
async function playStream(chunks: number[]): Promise<void> {
  const mediaSource = page.open()
  const buffer = mediaSource.addSourceBuffer(MIME)
  players.bind({ src: URL.createObjectURL(mediaSource as unknown as MediaSource) })

  for (const length of chunks) {
    await buffer.append(new Uint8Array(length).fill(3))
  }

  // The stream ends, which is a signal rather than a size and so travels at once. Without
  // it the reported size is still whatever the last chunk to cross a bucket carried, because
  // a stream that only grew is deliberately held for the hook's report tick, and these tests
  // would be asserting on that rounding rather than on what the page actually appended.
  mediaSource.endOfStream()
  await flush()
}

beforeEach(() => {
  fake = installFakeChrome([{ id: 1, url: PAGE, title: 'Documentary Stream' }])
  // The worker stores a report against the tab it came from, and Chrome tells it which tab
  // through `sender.tab`. Without this the report is dropped and counted, which is right and
  // is not what these tests are about.
  fake.runtime.control.setSenderTab(1)

  page = installFakePageMedia()
  urls = installFakeBlobUrls()
  players = installFakeMediaElements()

  clicked = []
  document.addEventListener('click', onClick)

  // Every runtime this file loads adds a `message` listener to the one window and never
  // removes it, which is right in a page and wrong here: without this, each test's relay
  // greets the next test's hook with its own token, the hook stands down as designed, and
  // the test fails for a reason that has nothing to do with the code under test.
  pageListeners = [];
  const add = window.addEventListener.bind(window);
  window.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ): void => {
    if (type === 'message') pageListeners.push(listener);
    add(type, listener, options);
  }) as unknown as typeof window.addEventListener;

  // The page's own title, which is the first step of the file name rule. Set here because
  // jsdom's document has none, and a stream on an untitled page is correctly named by the
  // rule's fixed word instead.
  document.title = 'Documentary Stream';

  delete (globalThis as Record<string, unknown>)[HOOK_STAMP]
  delete (globalThis as Record<string, unknown>)[CONTENT_STAMP]
})

afterEach(() => {
  for (const listener of pageListeners) window.removeEventListener('message', listener);
  pageListeners = [];
  vi.useRealTimers()
  document.removeEventListener('click', onClick)
  players.restore()
  urls.restore()
  page.restore()
})

function onClick(event: MouseEvent): void {
  const target = event.target as HTMLAnchorElement | null
  if (!target || target.tagName !== 'A') return
  // Prevented rather than followed: jsdom cannot navigate and says so loudly. What is under
  // test is the click, not the download it starts in a browser.
  event.preventDefault()
  clicked.push({ href: target.href, download: target.download })
}

describe('a MediaSource site, from the page to the record', () => {
  it('lists the stream the page is playing', async () => {
    await loadAll()
    await playStream([1000, 1000])

    const record = await storedWithStream()
    expect(record.entries).toHaveLength(1)

    // The container came from the SourceBuffer's MIME type, because a stream has no path to
    // read an extension off. The url is one the extension minted rather than one to fetch.
    const entry = record.entries[0]
    expect(entry?.url).toContain('vortex-stream:')
    expect(entry?.container).toBe('webm')
    expect(entry?.kind).toBe('video')
    expect(entry?.sources).toEqual(['page-stream-hook'])
  })

  it('records a row only once the stream holds bytes', async () => {
    await loadAll()

    // The buffer exists but nothing has been appended, so there is nothing to describe and
    // the record holds nothing at all.
    const mediaSource = page.open()
    mediaSource.addSourceBuffer(MIME)
    await flush()

    expect((await stored())?.entries ?? []).toEqual([])
  })

  it('keeps no media byte anywhere the extension can see', async () => {
    await loadAll()
    await playStream([2000, 2000])

    const record = await storedWithBytes(4000)

    // The whole point of the design, asserted on the size rather than on the content: the
    // page holds the bytes and the extension holds a count. Two kilobyte of media would
    // dwarf this if any of it were here, as base64 or as an array of numbers.
    const everything = JSON.stringify(await fake.storage.session.get(null))
    expect(everything.length).toBeLessThan(1000)
    expect(record.entries[0]?.stream).not.toHaveProperty('chunks')
  })

  it('makes one row for a player with separate audio and video buffers', async () => {
    await loadAll()
    const mediaSource = page.open()
    const video = mediaSource.addSourceBuffer(MIME)
    const audio = mediaSource.addSourceBuffer('audio/webm; codecs="vorbis"')
    players.bind({ src: URL.createObjectURL(mediaSource as unknown as MediaSource) })
    await video.append(new Uint8Array(1000).fill(1))
    await audio.append(new Uint8Array(500).fill(2))
    await flush()

    // One MediaSource is one stream and one row. Two rows would mean a silent video and a
    // row of its own.
    const record = await storedWithStream()
    expect(record.entries).toHaveLength(1)
  })

  it('drops the row when the page reloads and the fresh hook knows nothing', async () => {
    await loadAll()
    await playStream([1000])
    expect((await storedWithStream()).entries).toHaveLength(1)

    // A reload replaces the document, so the bytes behind the stream died with it. Both
    // files claim the fresh page, the fresh hook holds nothing, and the fresh relay reports
    // an empty snapshot, which is a claim that the stream is gone.
    delete (globalThis as Record<string, unknown>)[HOOK_STAMP]
    delete (globalThis as Record<string, unknown>)[CONTENT_STAMP]
    vi.resetModules()
    await import('./hook')
    await import('./content')
    await flush()

    const record = await stored()
    expect(record?.entries ?? []).toEqual([])
    // And the count with it, or the cap would claim it is holding back a row nobody can see.
    expect(record?.hiddenCount).toBe(0)
  })
})

describe('a stream row, from the popup all the way back to the page', () => {
  it('assembles the file, names it, and hands it to the browser', async () => {
    await loadAll()
    await playStream([1000, 24])
    const record = await storedWithStream()
    const url = record.entries[0]?.url as string

    const answer = await ask({
      name: 'STREAM_ASSEMBLE',
      payload: { contractVersion: CONTRACT_VERSION, url },
    })

    expect(answer).toEqual({ ok: true })
    expect(clicked).toHaveLength(1)

    // The name came from the engine's six step rule, with the page title first, and it
    // travelled popup to worker to relay to page without being lost on the way.
    expect(clicked[0]?.download).toBe('Documentary_Stream.webm')
  })

  it('hands over exactly the bytes the page appended, in order', async () => {
    await loadAll()
    const mediaSource = page.open()
    const buffer = mediaSource.addSourceBuffer(MIME)
    players.bind({ src: URL.createObjectURL(mediaSource as unknown as MediaSource) })
    await buffer.append(new Uint8Array([1, 2, 3, 4]))
    await buffer.append(new Uint8Array([9, 9]))
    mediaSource.endOfStream()
    await flush()

    const record = await storedWithStream()
    await ask({
      name: 'STREAM_ASSEMBLE',
      payload: { contractVersion: CONTRACT_VERSION, url: record.entries[0]?.url as string },
    })

    // Read back off the address the page was handed, which is the file the browser would
    // receive rather than the hook's own idea of it.
    const file = urls.objectFor(clicked[0]?.href ?? '') as Blob
    expect(file).toBeInstanceOf(Blob)
    expect(file.type).toBe(MIME.split(';')[0])
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 9, 9]))
  })

  it('never asks Chrome to download a stream, because a stream has no address to fetch', async () => {
    await loadAll()
    await playStream([1000])
    const record = await storedWithStream()

    await ask({
      name: 'STREAM_ASSEMBLE',
      payload: { contractVersion: CONTRACT_VERSION, url: record.entries[0]?.url as string },
    })

    // The file is produced by the page and the browser takes it from there. Calling
    // `chrome.downloads` with a minted url would hand the browser something to fetch that
    // does not exist.
    expect(await fake.downloads.search({})).toEqual([])
  })

  it('refuses a second assembly of the same stream while one is running', async () => {
    await loadAll()
    await playStream([1000])
    const record = await storedWithStream()
    const url = record.entries[0]?.url as string

    const [first, second] = await Promise.all([
      ask({ name: 'STREAM_ASSEMBLE', payload: { contractVersion: CONTRACT_VERSION, url } }),
      ask({ name: 'STREAM_ASSEMBLE', payload: { contractVersion: CONTRACT_VERSION, url } }),
    ])

    // Two clicks in one turn, which is what two quick presses are. One file, not two copies
    // of the same bytes.
    expect(clicked).toHaveLength(1)
    expect([first, second].filter((answer) => (answer as { ok: boolean }).ok)).toHaveLength(1)
  })

  it('says the row is not listed when the page no longer holds it', async () => {
    await loadAll()
    await playStream([1000])

    const answer = await ask({
      name: 'STREAM_ASSEMBLE',
      payload: {
        contractVersion: CONTRACT_VERSION,
        url: 'vortex-stream:https%3A%2F%2Fexample%2Ecom%2Fwatch#999',
      },
    })

    // A stream id the record does not hold. The worker answers rather than forwarding a
    // request the page cannot match to anything.
    expect(answer).toEqual({ ok: false, error: 'not_listed' })
    expect(clicked).toHaveLength(0)
  })

  it('does not offer a download for a stream the engine derives as live', async () => {
    // The player binding is read on the hook's report tick rather than on every chunk, so
    // this is the one test here that has to drive that tick. It is faked rather than waited
    // for, and it has to be faked before the hook loads: a timer created by the real clock
    // cannot be advanced afterwards.
    vi.useFakeTimers({ toFake: ['setInterval'] });
    try {
      await loadAll();
      const mediaSource = page.open();
      const buffer = mediaSource.addSourceBuffer(MIME);
      players.bind({
        src: URL.createObjectURL(mediaSource as unknown as MediaSource),
        duration: Infinity,
      });
      await buffer.append(new Uint8Array(1000).fill(1));
      vi.advanceTimersByTime(1000);
      await flush();

      const record = await storedWithStream();
      expect(record.status).toBe('ready');

      // The row is listed so it can say why, and the engine's own savability rule refuses it,
      // so a download for it would be an endless stream handed over as a file.
      expect(record.entries[0]?.stream?.live).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  })
})

describe('a blob video, from the page to the record', () => {
  it('lists it with the size the page already had, and copies nothing', async () => {
    await loadAll()
    const blob = new Blob([new Uint8Array(3000).fill(4)], { type: 'video/mp4' })
    const address = URL.createObjectURL(blob)
    players.bind({ src: address })

    const record = await storedWithStream()

    expect(record.entries[0]).toMatchObject({ container: 'mp4' })
    expect(record.entries[0]?.stream?.origin).toBe('blob')
    expect(record.entries[0]?.sizeBytes).toBe(3000)
  })

  it('saves it by clicking the address the page already made', async () => {
    await loadAll()
    const blob = new Blob([new Uint8Array(3000).fill(4)], { type: 'video/mp4' })
    const address = URL.createObjectURL(blob)
    players.bind({ src: address })
    const record = await storedWithStream()

    await ask({
      name: 'STREAM_ASSEMBLE',
      payload: { contractVersion: CONTRACT_VERSION, url: record.entries[0]?.url as string },
    })

    // The same address, not a new one. A blob is already a whole file, so there is nothing to
    // assemble and nothing to copy.
    expect(clicked[0]?.href).toBe(address)
  })

  it('ignores a blob that is not audio or video', async () => {
    await loadAll()
    URL.createObjectURL(new Blob([new Uint8Array(16)], { type: 'application/json' }))
    await flush()

    expect((await stored())?.entries ?? []).toEqual([])
  })
})