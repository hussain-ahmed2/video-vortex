// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installFakeChrome, type FakeChrome } from './testing'
import { CONTRACT_VERSION } from './engine/types'
import { strongestStatus } from './engine/merge'

// Spec 0004 AC-8: the content script reports the page's title and its URL, and nothing
// else. The two things worth proving are that it sends no media of its own, and that a
// second injection on the same page does nothing, because the worker injects on demand
// and can be asked to read a tab twice.

const STAMP_KEY = '__videoVortexContractVersion'

/** The key the hook stamps itself under, which is what makes a second injection a no-op. */
const HOOK_STAMP_KEY = '__videoVortexHookBuild'

let fake: FakeChrome
let sent: unknown[]

/**
 * Loads the content script and the hook, the way the worker injects them.
 *
 * The hook is stood in for by the greeting it posts on load. The content script claims the
 * page is watched only once that arrives, so a test that left it out would be testing a
 * page with no hook on it, which is a different page and has its own test below.
 *
 * The drain at the end is not tidiness. What the script says into the page arrives on a
 * later task, so a test that read the page straight after this returned would be reading
 * before the answer had been delivered.
 */
async function inject(): Promise<void> {
  vi.resetModules()
  await import('./content')
  await new Promise((resolve) => setTimeout(resolve, 0))
  installHookOnce()
  await flushSoon()
}

/**
 * The greeting, once per build, the way the real hook sends it.
 *
 * The hook stamps the page on load and returns early on a second injection of the same
 * build, so it says hello once and once only. A helper that greeted every time would make
 * a repeated injection look like a report arriving, which is the exact thing the stamp
 * exists to prevent.
 */
function installHookOnce(): void {
  const globals = globalThis as Record<string, unknown>
  if (globals[HOOK_STAMP_KEY] !== undefined) return
  globals[HOOK_STAMP_KEY] = HOOK_STAMP_KEY
  sayHello()
}

/**
 * Loads the content script on a page where the hook never arrives.
 *
 * No wait inside, because the callers fake the timers to reach the handshake timeout, and a
 * real `setTimeout` here would never resolve under them.
 */
async function injectWithoutHook(): Promise<void> {
  vi.resetModules()
  await import('./content')
}

/** The one message the hook says on load, and nothing else. */
function sayHello(): void {
  window.postMessage({ source: 'video-vortex', type: 'hello' }, '*')
}

/** One turn per hop, which is what the page's message bus needs to deliver. */
async function flushSoon(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/**
 * The page listeners each test's script added, so they can be taken off again.
 *
 * A content script adds a `message` listener and never removes it, which is correct in a
 * page and wrong in a suite: one window is shared by every test in this file, so without this
 * a greeting reaches every script an earlier test injected and each of them reports. The
 * scripts' own module state is separate, but the arrays they report into are not.
 */
let pageListeners: (EventListenerOrEventListenerObject)[] = []

beforeEach(() => {
  fake = installFakeChrome()
  sent = []
  toPage = []
  pageListeners = []

  const add = window.addEventListener.bind(window);
  const tracked = (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ): void => {
    if (type === 'message') pageListeners.push(listener);
    add(type, listener, options);
  };
  window.addEventListener = tracked as unknown as typeof window.addEventListener;

  fake.runtime.onMessage.addListener((message) => {
    sent.push(message)
  })
  // The other direction: what the content script says into the page. Registered before the
  // script under test so it sees everything, including a greeting sent as the module loads.
  window.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { source?: string } | null
    if (data?.source === 'video-vortex') toPage.push(data as (typeof toPage)[number])
  })

  // A brand new body element, so the observer of a previous test's script instance is
  // watching a node nothing mutates any more. Every injection adds another observer to
  // whatever body exists at the time, and this is what keeps one test's reports from
  // landing in the next test's assertions.
  document.documentElement.replaceChild(document.createElement('body'), document.body)
  document.title = 'Documentary Stream'
  // The history API rather than a fake location object: `window.location` is
  // unforgeable in jsdom, and this is also how a single page app really changes its
  // URL, without a reload.
  window.history.replaceState({}, '', '/watch')
  delete (globalThis as Record<string, unknown>)[STAMP_KEY]
  delete (globalThis as Record<string, unknown>)[HOOK_STAMP_KEY]
})

afterEach(async () => {
  for (const listener of pageListeners) window.removeEventListener('message', listener)
  pageListeners = []

  // Drain the observer queue while the environment is still alive, then detach every
  // observer by swapping the body out. A callback left pending runs after teardown,
  // when the globals it closes over are gone, and an unhandled error there is noise
  // that looks like a product failure.
  document.body.append(document.createElement('i'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  document.documentElement.replaceChild(document.createElement('body'), document.body)
})

describe('what the content script reports', () => {
  it('reports the page title and URL once the hook says it is listening', async () => {
    await inject()

    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual({
      name: 'ENTRIES_REPORTED',
      payload: {
        contractVersion: CONTRACT_VERSION,
        pageUrl: 'http://localhost:3000/watch',
        pageTitle: 'Documentary Stream',
        status: 'ready',
        entries: [],
      },
    })
  })

  it('reports no media of its own, because detection belongs to the worker observer', async () => {
    await inject()

    const payload = (sent[0] as { payload: { entries: unknown[] } }).payload
    expect(payload.entries).toEqual([])
  })

  it('reports again when the page navigates without reloading', async () => {
    await inject()
    window.history.pushState({}, '', '/watch?v=2')

    // The observer watches the DOM, so something on the page has to change for it to
    // look. That is how a single page app's navigation arrives.
    document.body.append(document.createElement('span'))
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(sent).toHaveLength(2)
    const payload = (sent[1] as { payload: { pageUrl: string } }).payload
    expect(payload.pageUrl).toBe('http://localhost:3000/watch?v=2')
  })

  it('stays quiet while the URL has not changed', async () => {
    await inject()

    document.body.append(document.createElement('span'))
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(sent).toHaveLength(1)
  })
})

describe('the contract stamp on the page', () => {
  it('stamps the contract version so a later build can tell', async () => {
    await inject()

    expect((globalThis as Record<string, unknown>)[STAMP_KEY]).toBe(CONTRACT_VERSION)
  })

  it('does nothing on a second injection of the same build', async () => {
    // The worker injects on demand and a read can be repeated, so a second copy would
    // add a second report for one page.
    await inject()
    await inject()

    expect(sent).toHaveLength(1)
  })

  it('takes over from a content script left by a previous build', async () => {
    // The case the version check exists for: the page is still running the script from
    // before an extension reload, and it reports a shape the new worker cannot read.
    ;(globalThis as Record<string, unknown>)[STAMP_KEY] = CONTRACT_VERSION - 1

    await inject()

    expect(sent).toHaveLength(1)
    expect((globalThis as Record<string, unknown>)[STAMP_KEY]).toBe(CONTRACT_VERSION)
  })

  it('survives a worker that is not listening', async () => {
    // A content script cannot retry, and a rejection here would be an unhandled one in
    // a page the extension is only trying to help. A fresh fake has no listener, which
    // is what a worker mid reload looks like from here.
    installFakeChrome()

    await expect(inject()).resolves.toBeUndefined()
  })
})
// ─── Spec 0005: the relay between the page and the worker ───────────────────

/**
 * Everything the content script has posted into the page, in order.
 *
 * The content script talks to the page over `window.postMessage` and to the worker over
 * `chrome.runtime`, so a test needs to read both. The token is not exported and should not
 * be: it is read here out of the install message, which is the only place it is ever said,
 * and that is what makes "the token the page must carry" a fact about the wire rather than
 * about a variable.
 */
let toPage: { type: string; token?: string; pageUrl?: string; [key: string]: unknown }[]

/** The token the current injection minted, read off its install message. */
function currentToken(): string {
  const install = toPage.find((message) => message.type === 'install')
  if (!install?.token) throw new Error('the content script never installed the hook')
  return install.token
}

/** A page snapshot, with the signals a real MediaSource stream would report. */
function pageSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'video-vortex',
    type: 'streams',
    token: currentToken(),
    pageUrl: 'http://localhost:3000/watch',
    streams: [
      {
        streamId: 1,
        origin: 'mse',
        mimeType: 'video/webm; codecs="vp8, vorbis"',
        bytes: 2048,
        bufferedBytes: 2048,
        live: false,
        encrypted: false,
        ended: false,
        partialReason: 'none',
        mediaElementName: null,
      },
    ],
    ...overrides,
  }
}

/**
 * Asks the content script to assemble, the way the worker does after naming the file.
 *
 * The sender carries a tab, because that is the only thing that marks a message as addressed
 * to this tab rather than as one the popup sent for the worker.
 */
function askForAssembly(url: string, filename?: string): Promise<unknown> {
  return new Promise((resolve) => {
    fake.runtime.onMessage.fire(
      {
        name: 'STREAM_ASSEMBLE',
        payload: {
          contractVersion: CONTRACT_VERSION,
          url,
          ...(filename ? { filename } : {}),
        },
      },
      { tab: { id: 1 } },
      resolve
    )
  })
}

/**
 * The drop counter, read from the module under test.
 *
 * Imported dynamically for the same reason the worker is: the module registers listeners
 * on load, so a static import would run it before the fake browser exists.
 */
async function droppedCount(): Promise<number> {
  const module = await import('./content')
  return module.droppedPageMessageCount()
}

/** The first entry of the nth report the content script sent to the worker. */
function entryAt(index: number): Record<string, unknown> {
  const payload = (sent[index] as { payload: { entries: Record<string, unknown>[] } }).payload
  return payload.entries[0] as Record<string, unknown>
}

/** One page snapshot, reported, which is what a stream row in the worker comes from. */
async function reportAStream(): Promise<string> {
  await inject()
  sent = []
  window.postMessage(pageSnapshot(), '*')
  await flushSoon()
  return entryAt(0).url as string
}

describe('installing the hook', () => {
  it('mints a token and installs the hook with it and the page url', async () => {
    await inject()

    const install = toPage.find((message) => message.type === 'install')
    expect(install).toBeDefined()
    expect(install?.token).toBeTruthy()
    // The page url is stamped because a single page app navigates without a reload, and the
    // new url is what tells the hook to re-announce rather than return early.
    expect(install?.pageUrl).toBe('http://localhost:3000/watch')
  })

  it('answers the hook saying hello, because either file may arrive second', async () => {
    // The worker injects the content script and then the hook, and a postMessage is
    // delivered on a later task, so the install can be posted into a window the hook has not
    // attached to yet.
    await inject()
    const before = toPage.length

    window.postMessage({ source: 'video-vortex', type: 'hello' }, '*')
    await flushSoon()

    expect(toPage.length).toBeGreaterThan(before)
    expect(toPage.at(-1)?.type).toBe('install')
  })
})

describe('the report the worker receives', () => {
  it('carries no entries while the page streams nothing', async () => {
    await inject()

    // The same shape as before this slice: a report is the page's title and its url, and a
    // file found by the network observer is not the page's to report.
    const payload = (sent[0] as { payload: { entries: unknown[] } }).payload
    expect(payload.entries).toEqual([])
  })

  it('turns a page snapshot into one entry, named from the MIME type', async () => {
    await inject()
    sent = []

    window.postMessage(pageSnapshot(), '*')
    await flushSoon()

    // A stream has no address and no path, so the MIME type is the only thing that can name
    // a container, and the url is one we minted rather than one to fetch.
    expect(entryAt(0)).toMatchObject({
      url: expect.stringContaining('vortex-stream:'),
      container: 'webm',
      kind: 'video',
      quality: 'unknown',
      sizeBytes: 2048,
      sources: ['page-stream-hook'],
    })
  })

  it('carries the raw signals through, and no verdict', async () => {
    await inject()
    sent = []

    window.postMessage(pageSnapshot(), '*')
    await flushSoon()

    // The page observed and the engine decides. A stream block carrying a state would mean
    // two places deciding, and the two would drift.
    const stream = entryAt(0).stream as Record<string, unknown>
    expect(stream).toMatchObject({ streamId: 1, origin: 'mse', bufferedBytes: 2048 })
    expect(stream).not.toHaveProperty('state')
  })

  it('drops a report carrying a token this injection did not mint', async () => {
    await inject()
    sent = []
    const before = await droppedCount()

    window.postMessage(pageSnapshot({ token: 'a-stale-build' }), '*')
    await flushSoon()

    // A hook left over from a previous build is still on the page and still reporting.
    expect(sent).toHaveLength(0)
    expect(await droppedCount()).toBe(before + 1)
  })

  it('drops a report with no token at all', async () => {
    await inject()
    sent = []
    const before = await droppedCount()

    window.postMessage(pageSnapshot({ token: '' }), '*')
    await flushSoon()

    expect(sent).toHaveLength(0)
    expect(await droppedCount()).toBe(before + 1)
  })

  it('refuses a whole snapshot carrying one stream that fails its schema', async () => {
    await inject()
    sent = []
    const before = await droppedCount()

    const broken = pageSnapshot()
    ;(broken.streams as { bytes: number }[])[0].bytes = -1
    window.postMessage(broken, '*')
    await flushSoon()

    // The whole snapshot is refused rather than the one bad stream dropped, because a
    // snapshot missing an entry is a claim that the stream is gone.
    expect(sent).toHaveLength(0)
    expect(await droppedCount()).toBe(before + 1)
  })
})

describe('a single page app that navigates without a reload', () => {
  it('re-installs the hook for the new url and keeps listing the streams', async () => {
    await inject()
    window.postMessage(pageSnapshot(), '*')
    await flushSoon()

    const reportsBefore = sent.length

    // Something on the page has to change for the observer to look, which is how a single
    // page app's navigation arrives.
    window.history.pushState({}, '', '/watch?v=2')
    document.body.append(document.createElement('span'))
    await flushSoon()

    const install = toPage.filter((message) => message.type === 'install').at(-1)
    expect(install?.pageUrl).toBe('http://localhost:3000/watch?v=2')
    // The streams are still the ones playing, so they stay listed rather than being dropped
    // as rows belonging to a page nobody is on any more.
    expect(sent.length).toBeGreaterThan(reportsBefore)
    expect((sent.at(-1) as { payload: { entries: unknown[] } }).payload.entries).toHaveLength(1)
  })
})

describe('assembling a stream on the page', () => {
  it('relays the request into the page with the stream id read out of the url', async () => {
    const url = await reportAStream()

    void askForAssembly(url, 'Documentary_Stream.webm')
    await flushSoon()

    // The url is what the popup has and what the worker looks the entry up by, so the id is
    // read back out of it rather than carried as a seventh field on the message.
    expect(toPage.find((message) => message.type === 'assemble')).toMatchObject({
      token: currentToken(),
      streamId: 1,
    })
  })

  it('carries the file name the worker derived', async () => {
    const url = await reportAStream()

    void askForAssembly(url, 'Documentary_Stream.webm')
    await flushSoon()

    expect(toPage.find((message) => message.type === 'assemble')?.filename).toBe(
      'Documentary_Stream.webm'
    )
  })

  it('answers the worker with what the page said', async () => {
    const url = await reportAStream()
    const answered = askForAssembly(url, 'joined.webm')

    await flushSoon()
    window.postMessage(
      {
        source: 'video-vortex',
        type: 'assembled',
        token: currentToken(),
        streamId: 1,
        ok: true,
      },
      '*'
    )
    await flushSoon()

    await expect(answered).resolves.toEqual({ ok: true })
  })

  it('passes the page refusal on rather than inventing a success', async () => {
    const url = await reportAStream()
    const answered = askForAssembly(url, 'joined.webm')

    await flushSoon()
    window.postMessage(
      {
        source: 'video-vortex',
        type: 'assembled',
        token: currentToken(),
        streamId: 1,
        ok: false,
        error: 'already_running',
      },
      '*'
    )
    await flushSoon()

    await expect(answered).resolves.toEqual({ ok: false, error: 'already_running' })
  })

  it('refuses a url that is not one of ours', async () => {
    await inject()

    await expect(askForAssembly('https://cdn.example.com/clip.mp4')).resolves.toEqual({
      ok: false,
      error: 'not_listed',
    })
  })

  it('says the page refused when it goes quiet, so the row gets its control back', async () => {
    // Timers are faked only once the script is loaded, because the injection itself waits
    // on a real timer to let the page's first messages land.
    const url = await reportAStream()
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      let answer: unknown
      void askForAssembly(url, 'joined.webm').then((value) => {
        answer = value
      })
      await vi.advanceTimersByTimeAsync(30_000)

      // The answer comes from the page, and the page is not ours to trust to answer at all.
      // A channel left open is a popup waiting for the life of the tab.
      expect(answer).toEqual({ ok: false, error: 'page_refused' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a page where the hook never arrives', () => {
  it('says the page blocks access rather than showing an empty list', async () => {
    // The hook is injected into the page's own world, and a page can refuse that while
    // accepting an isolated content script. Silence is the only signal there is, so the
    // verdict is a bounded wait, and `blocked` is a state the popup already renders.
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      await injectWithoutHook();
      await vi.advanceTimersByTimeAsync(5000);
      expect(sent).toHaveLength(1);
      const payload = (sent[0] as { payload: { status: string } }).payload;
      expect(payload.status).toBe('blocked');
    } finally {
      vi.useRealTimers();
    }
  });

  it('says ready instead, the moment the hook answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      vi.resetModules();
      await import('./content');
      await vi.advanceTimersByTimeAsync(0);
      sayHello();
      await vi.advanceTimersByTimeAsync(0);

      expect(sent).toHaveLength(1);
      const payload = (sent[0] as { payload: { status: string } }).payload;
      expect(payload.status).toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });

  it('never claims the page is ready before the hook has spoken', async () => {
    // The worker already answers `observing` while it waits, so a report claiming the page
    // is watched before the hook answers would claim it is fully watched while its streams
    // go unseen. That is what makes an empty list read as a page with no media.
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      await injectWithoutHook();
      await vi.advanceTimersByTimeAsync(500);

      expect(sent).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not say blocked after the hook has already answered', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      vi.resetModules();
      await import('./content');
      await vi.advanceTimersByTimeAsync(0);
      sayHello();
      await vi.advanceTimersByTimeAsync(5000);

      // One report, and it is the ready one. The timer firing afterwards must not add a
      // second verdict over the top of a page that is being watched perfectly well.
      expect(sent).toHaveLength(1);
      const payload = (sent[0] as { payload: { status: string } }).payload;
      expect(payload.status).toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps its verdict for the life of the page, because nothing else will say otherwise', async () => {
    // The worker latches the strongest status, and `blocked` outranks `ready`. So a page
    // that refused the hook stays blocked rather than being rescued by a later report, which
    // is what a person needs: the same page will refuse again.
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      await injectWithoutHook();
      await vi.advanceTimersByTimeAsync(5000);

      const blocked = sent.at(-1) as { payload: { status: string } };
      sayHello();
      await vi.advanceTimersByTimeAsync(0);

      expect(blocked.payload.status).toBe('blocked');
      expect(strongestStatus('blocked', sent.at(-1) ? 'ready' : 'ready')).toBe('blocked');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the token, which is the whole of what AC-2 claims', () => {
  it('is a different value on every injection', async () => {
    await inject();
    const first = currentToken();

    delete (globalThis as Record<string, unknown>)[STAMP_KEY];
    delete (globalThis as Record<string, unknown>)[HOOK_STAMP_KEY];
    toPage = [];
    await inject();

    // Per injection, not per build. A token that survived a reinjection would let a hook
    // from the previous injection keep reporting under a marker the content script still
    // accepts, which is the case AC-2 exists to stop.
    expect(currentToken()).not.toBe(first);
  });
});
