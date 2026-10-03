import { beforeEach, describe, expect, it } from 'vitest'
import { NO_RECEIVING_END } from './dual'
import { installFakeChrome } from './install'
import { createFakeTabs } from './tabs'
import type { FakeCallback, FakeChrome, FakeErrorChannel } from './types'

// The fakes' own tests. If these are weak, every test built on top of them is
// weak, so this is where "the fake behaves" gets proven rather than assumed.

let fake: FakeChrome

beforeEach(() => {
  // A fresh set every test: no state can leak from one to the next, which is
  // the whole reason the fakes are built per test rather than reset.
  fake = installFakeChrome([{ id: 1, url: 'https://example.com/watch' }])
})

function callbackSpy(): { calls: unknown[]; callback: FakeCallback } {
  const calls: unknown[] = []
  const callback = ((value: unknown) => {
    calls.push(value)
  }) as FakeCallback
  return { calls, callback }
}

describe('fake storage', () => {
  it('answers a single named key with an object keyed by that name', async () => {
    // Chrome's shape, not the bare value. Production code reads `stored[key]`, and a
    // fake that returned the value itself would make that code look broken rather than
    // making the fake wrong.
    await fake.storage.session.set({ 'vv:tab:1': { entries: [] } })
    const read = await fake.storage.session.get('vv:tab:1')

    expect(read).toEqual({ 'vv:tab:1': { entries: [] } })
  })

  it('returns the stored value by reference, with no deep copy', async () => {
    const record = { entries: [] }
    await fake.storage.session.set({ 'vv:tab:1': record })
    const read = (await fake.storage.session.get('vv:tab:1')) as Record<string, unknown>

    expect(read['vv:tab:1']).toBe(record)
  })

  it('returns the default for an absent key, under that key', async () => {
    expect(await fake.storage.session.get('nope', 'fallback')).toEqual({ nope: 'fallback' })
  })

  it('returns every item for a null key', async () => {
    await fake.storage.session.set({ a: 1, b: 2 })
    expect(await fake.storage.session.get(null)).toEqual({ a: 1, b: 2 })
  })

  it('isolates one storage area from another', async () => {
    await fake.storage.session.set({ shared: 'from session' })
    expect(await fake.storage.local.get('shared', 'absent')).toEqual({ shared: 'absent' })
  })

  it('removes and clears', async () => {
    await fake.storage.session.set({ a: 1, b: 2 })
    await fake.storage.session.remove('a')
    expect(await fake.storage.session.get('a', 'gone')).toEqual({ a: 'gone' })
    await fake.storage.session.clear()
    expect(await fake.storage.session.get(null)).toEqual({})
  })

  it('answers a callback call and returns undefined', async () => {
    await fake.storage.session.set({ a: 1 })
    const { calls, callback } = callbackSpy()
    const returned = fake.storage.session.get('a', callback)
    expect(returned).toBeUndefined()
    // `calls` already collects the callback's arguments, so this is the whole result.
    expect(calls).toEqual([{ a: 1 }])
  })

  it('returns every item when asked with no key at all', async () => {
    // `load()` on the state store port ends up here.
    await fake.storage.session.set({ a: 1, b: 2 })
    expect(await fake.storage.session.get()).toEqual({ a: 1, b: 2 })
  })

  it('returns an object of the requested keys, with undefined for absent ones', async () => {
    await fake.storage.session.set({ a: 1 })
    expect(await fake.storage.session.get(['a', 'missing'])).toEqual({
      a: 1,
      missing: undefined,
    })
  })

  it('merges stored values over an object of defaults', async () => {
    await fake.storage.session.set({ a: 'stored' })
    const read = (await fake.storage.session.get({ a: 'fallback', b: 'fallback' })) as {
      a: string
      b: string
    }
    expect(read).toEqual({ a: 'stored', b: 'fallback' })
  })

  it('removes several keys at once', async () => {
    await fake.storage.session.set({ a: 1, b: 2, c: 3 })
    await fake.storage.session.remove(['a', 'b'])
    expect(await fake.storage.session.get(null)).toEqual({ c: 3 })
  })

  it('tolerates being set with an empty object', async () => {
    // Chrome requires the items argument, so an empty object is the edge here.
    await fake.storage.session.set({})
    expect(await fake.storage.session.get(null)).toEqual({})
  })
})

describe('fake runtime', () => {
  it('rejects a broadcast when nothing is listening, with Chrome wording', async () => {
    await expect(fake.runtime.sendMessage({ type: 'PING' })).rejects.toThrow(
      NO_RECEIVING_END
    )
  })

  it('sets lastError on the callback path of a failed broadcast', () => {
    const { callback } = callbackSpy()
    fake.runtime.sendMessage({ type: 'PING' }, callback)
    expect(fake.runtime.lastError?.message).toBe(NO_RECEIVING_END)
  })

  it('passes a message to a registered listener', () => {
    const seen: unknown[] = []
    fake.runtime.onMessage.addListener((message) => {
      seen.push(message)
      return undefined
    })
    fake.runtime.sendMessage({ type: 'PING' })
    expect(seen).toEqual([{ type: 'PING' }])
  })

  it('resolves with the first response a listener gives', async () => {
    fake.runtime.onMessage.addListener((_message, _sender, sendResponse) => {
      sendResponse({ ok: true })
      return true
    })
    expect(await fake.runtime.sendMessage({ type: 'PING' })).toEqual({ ok: true })
  })

  it('resolves undefined when no listener responds', async () => {
    fake.runtime.onMessage.addListener(() => undefined)
    expect(await fake.runtime.sendMessage({ type: 'PING' })).toBeUndefined()
  })

  it('stops calling a listener once removed', async () => {
    let calls = 0
    const listener = () => {
      calls += 1
      return undefined
    }
    fake.runtime.onMessage.addListener(listener)
    await fake.runtime.sendMessage({ type: 'PING' })
    fake.runtime.onMessage.removeListener(listener)
    // With the last listener gone the broadcast has no receiving end, which is
    // the rejection the worker has to swallow.
    await expect(fake.runtime.sendMessage({ type: 'PING' })).rejects.toThrow()
    expect(calls).toBe(1)
  })

  it('reports whether a listener is registered', () => {
    const listener = () => undefined
    expect(fake.runtime.onMessage.hasListener(listener)).toBe(false)
    fake.runtime.onMessage.addListener(listener)
    expect(fake.runtime.onMessage.hasListener(listener)).toBe(true)
  })

  it('asks the next listener when the first one stays silent', async () => {
    fake.runtime.onMessage.addListener(() => undefined)
    fake.runtime.onMessage.addListener((_message, _sender, sendResponse) => {
      sendResponse({ from: 'second' })
      return true
    })
    expect(await fake.runtime.sendMessage({ type: 'PING' })).toEqual({ from: 'second' })
  })

  it('stops at the first listener that answers and keeps the channel open', async () => {
    // `return true` is the signal that the channel stays open, so the second
    // listener must never be consulted.
    let secondCalled = false
    fake.runtime.onMessage.addListener((_message, _sender, sendResponse) => {
      sendResponse({ from: 'first' })
      return true
    })
    fake.runtime.onMessage.addListener((_message, _sender, sendResponse) => {
      secondCalled = true
      sendResponse({ from: 'second' })
      return true
    })
    expect(await fake.runtime.sendMessage({ type: 'PING' })).toEqual({ from: 'first' })
    expect(secondCalled).toBe(false)
  })

  it('clears lastError once a later send succeeds', async () => {
    // Chrome only exposes lastError for the duration of a failed callback, so a
    // stale one left behind here would make production code branch on a phantom
    // error on every later successful call.
    const { callback } = callbackSpy()
    fake.runtime.sendMessage({ type: 'PING' }, callback)
    expect(fake.runtime.lastError).toBeDefined()

    fake.runtime.onMessage.addListener(() => undefined)
    await fake.runtime.sendMessage({ type: 'PING' })

    expect(fake.runtime.lastError).toBeUndefined()
  })
})

describe('fake downloads', () => {
  it('returns a fresh id from the promise form and from the callback form', async () => {
    const fromPromise = (await fake.downloads.download({
      url: 'https://cdn.example.com/a.mp4',
    })) as number
    const { calls, callback } = callbackSpy()
    const returned = fake.downloads.download(
      { url: 'https://cdn.example.com/b.mp4' },
      callback
    )
    expect(returned).toBeUndefined()
    expect(typeof calls[0]).toBe('number')
    expect(calls[0]).not.toBe(fromPromise)
  })

  it('finds a download by id and by url', async () => {
    const id = (await fake.downloads.download({
      url: 'https://cdn.example.com/a.mp4',
      filename: 'a.mp4',
    })) as number
    const byId = (await fake.downloads.search({ id })) as { filename: string }[]
    const byUrl = (await fake.downloads.search({
      url: 'https://cdn.example.com/a.mp4',
    })) as { filename: string }[]
    expect(byId).toHaveLength(1)
    expect(byId[0].filename).toBe('a.mp4')
    expect(byUrl).toHaveLength(1)
  })

  it('starts a download in progress with an unknown total', async () => {
    const id = (await fake.downloads.download({ url: 'https://x/a.mp4' })) as number
    const [item] = (await fake.downloads.search({ id })) as {
      state: string
      bytesReceived: number
      totalBytes: number
    }[]
    expect(item.state).toBe('in_progress')
    expect(item.bytesReceived).toBe(0)
    expect(item.totalBytes).toBe(-1)
  })

  it('drives a download to complete and reports each change', async () => {
    const id = (await fake.downloads.download({ url: 'https://x/a.mp4' })) as number
    const deltas: unknown[] = []
    fake.downloads.onChanged.addListener((delta) => {
      deltas.push(delta)
    })

    fake.downloads.control.setState(id, {
      bytesReceived: 512,
      totalBytes: 1024,
    })
    fake.downloads.control.setState(id, { state: 'complete', bytesReceived: 1024 })

    expect(deltas).toEqual([
      { id, state: undefined, bytesReceived: { current: 512 }, totalBytes: { current: 1024 }, error: undefined },
      { id, state: { current: 'complete' }, bytesReceived: { current: 1024 }, totalBytes: undefined, error: undefined },
    ])

    const [item] = (await fake.downloads.search({ id })) as { state: string }[]
    expect(item.state).toBe('complete')
  })

  it('ignores a state change for an unknown download', async () => {
    expect(() => fake.downloads.control.setState(999, { state: 'complete' })).not.toThrow()
  })

  it('returns every download for an empty query', async () => {
    await fake.downloads.download({ url: 'https://x/a.mp4' })
    await fake.downloads.download({ url: 'https://x/b.mp4' })
    expect(await fake.downloads.search({})).toHaveLength(2)
  })

  it('returns nothing for a query that matches no download', async () => {
    expect(await fake.downloads.search({ id: 4242 })).toEqual([])
  })

  it('notifies nobody when a state changes with no listener attached', async () => {
    const id = (await fake.downloads.download({ url: 'https://x/a.mp4' })) as number
    expect(() =>
      fake.downloads.control.setState(id, { state: 'complete' })
    ).not.toThrow()
  })
})

describe('fake tabs', () => {
  it('finds a tab by id', async () => {
    const tab = (await fake.tabs.get(1)) as { url: string }
    expect(tab.url).toBe('https://example.com/watch')
  })

  it('rejects a tab message when no content script is listening', async () => {
    fake.tabs.control.setContentScriptListening(false)
    await expect(fake.tabs.sendMessage(1, { type: 'PING' })).rejects.toThrow(
      NO_RECEIVING_END
    )
  })

  it('resolves a tab message when a content script is listening', async () => {
    expect(await fake.tabs.sendMessage(1, { type: 'PING' })).toBeUndefined()
  })

  it('notifies onRemoved listeners', () => {
    const removed: number[] = []
    fake.tabs.onRemoved.addListener((tabId) => {
      removed.push(tabId)
    })
    fake.tabs.onRemoved.fire(7)
    expect(removed).toEqual([7])
  })

  it('returns undefined for a tab it does not know', async () => {
    expect(await fake.tabs.get(999)).toBeUndefined()
  })

  it('returns every tab for a query with no filter', async () => {
    fake.tabs.control.setTab({ id: 2, url: 'https://example.com/other' })
    expect(await fake.tabs.query({})).toHaveLength(2)
  })

  it('filters to the tabs with an id for an active query', async () => {
    // The popup asks for the active tab in the current window, so a tab with no
    // id must not be counted as one.
    expect(await fake.tabs.query({ active: true, currentWindow: true })).toHaveLength(1)
  })

  it('picks up a tab added after the fake was installed', async () => {
    fake.tabs.control.setTab({ id: 3, url: 'https://example.com/late' })
    const tab = (await fake.tabs.get(3)) as { url: string }
    expect(tab.url).toBe('https://example.com/late')
  })

  it('sets lastError on the callback path of a failed tab message', () => {
    // Chrome reports a missing content script through `runtime.lastError`, so a
    // fake that stays quiet here would let a test pass while the real code takes
    // the error branch. This is the same contract the runtime fake already meets.
    fake.tabs.control.setContentScriptListening(false)
    const { calls, callback } = callbackSpy()

    fake.tabs.sendMessage(1, { type: 'PING' }, callback)

    expect(fake.runtime.lastError?.message).toBe(NO_RECEIVING_END)
    expect(calls).toEqual([undefined])
  })

  it('clears lastError once a later tab message succeeds', async () => {
    // The same leak the runtime fake has to guard against: a failure must not
    // survive into the next call, whichever namespace made it.
    fake.tabs.control.setContentScriptListening(false)
    const { callback } = callbackSpy()
    fake.tabs.sendMessage(1, { type: 'PING' }, callback)
    expect(fake.runtime.lastError).toBeDefined()

    fake.tabs.control.setContentScriptListening(true)
    await fake.tabs.sendMessage(1, { type: 'PING' })

    expect(fake.runtime.lastError).toBeUndefined()
  })

  it('shares one lastError between the runtime and tab namespaces', () => {
    // A failure on one namespace must be visible after a call on the other, or
    // the property stops meaning what Chrome means by it.
    fake.tabs.control.setContentScriptListening(false)
    const { callback } = callbackSpy()
    fake.tabs.sendMessage(1, { type: 'PING' }, callback)

    expect(fake.runtime.lastError?.message).toBe(NO_RECEIVING_END)
  })
})

describe('the error channel', () => {
  // The channel is how a namespace fake reaches `runtime.lastError`. Its contract
  // is two operations and an order, so both are pinned here directly rather than
  // only through the wiring that `installFakeChrome` happens to provide.

  function recordingChannel(calls: string[]): FakeErrorChannel {
    return {
      clear: () => {
        calls.push('clear')
      },
      report: (message) => {
        calls.push(`report:${message}`)
      },
    }
  }

  it('clears before it reports, so a failure is never wiped by the clear', async () => {
    // The order is the whole point. Reporting first and clearing second would
    // leave lastError permanently undefined and the error branch untested.
    const calls: string[] = []
    const tabs = createFakeTabs([{ id: 1 }], recordingChannel(calls))
    tabs.control.setContentScriptListening(false)

    await expect(tabs.sendMessage(1, { type: 'PING' })).rejects.toThrow()

    expect(calls).toEqual(['clear', `report:${NO_RECEIVING_END}`])
  })

  it('clears on a successful call without reporting anything', async () => {
    const calls: string[] = []
    const tabs = createFakeTabs([{ id: 1 }], recordingChannel(calls))

    expect(await tabs.sendMessage(1, { type: 'PING' })).toBeUndefined()

    expect(calls).toEqual(['clear'])
  })

  it('still rejects when no channel was supplied at all', async () => {
    // The default is a no-op pair, so building a tabs fake on its own must not
    // throw on either path.
    const tabs = createFakeTabs([{ id: 1 }])
    tabs.control.setContentScriptListening(false)

    await expect(tabs.sendMessage(1, { type: 'PING' })).rejects.toThrow(
      NO_RECEIVING_END
    )
  })

  it('does not throw on the success path with no channel either', async () => {
    const tabs = createFakeTabs([{ id: 1 }])

    expect(await tabs.sendMessage(1, { type: 'PING' })).toBeUndefined()
  })
})

describe('installing the fakes', () => {
  it('puts the returned object where the extension expects the browser to be', () => {
    // The one thing the whole harness rests on: production code reads the global
    // `chrome`, so the object handed back has to be that same object.
    const installed = installFakeChrome()
    expect(globalThis.chrome).toBe(installed)
  })

  it('replaces the previous set rather than merging into it', () => {
    // Freshness per test is the mechanism that stops state leaking between tests.
    const first = installFakeChrome()
    const second = installFakeChrome()

    expect(second).not.toBe(first)
    expect(globalThis.chrome).toBe(second)
  })
})

describe('delivering a message to a content script', () => {
  // The worker's assembly request is answered by the content script and not by
  // anything the worker owns, so a fake that only modelled the failure would leave
  // that hop untestable. Spec 0005 AC-17.

  it('resolves with what the content script answered', async () => {
    fake.tabs.control.setContentScriptListener((_message, _sender, sendResponse) => {
      sendResponse({ ok: true })
      return false
    })

    await expect(fake.tabs.sendMessage(1, { name: 'STREAM_ASSEMBLE' })).resolves.toEqual({
      ok: true,
    })
  })

  it('answers in the callback form too, the way production code calls it', () => {
    const { calls, callback } = callbackSpy()
    fake.tabs.control.setContentScriptListener((_message, _sender, sendResponse) => {
      sendResponse({ ok: false, error: 'already_running' })
      return false
    })

    fake.tabs.sendMessage(1, { name: 'STREAM_ASSEMBLE' }, callback)
    expect(calls).toEqual([{ ok: false, error: 'already_running' }])
  })

  it('tells the content script which tab it is on, the way Chrome does', () => {
    const seen: unknown[] = []
    fake.tabs.control.setContentScriptListener((_message, sender) => {
      seen.push(sender)
      return false
    })

    fake.tabs.sendMessage(7, { name: 'STREAM_ASSEMBLE' })
    // On `sender.tab`, which is where Chrome puts it and what a content script reads to tell
    // a message addressed to it from one the popup sent for the worker.
    expect(seen).toEqual([{ tab: { id: 7 } }])
  })

  it('resolves undefined when the listener answers nothing', async () => {
    fake.tabs.control.setContentScriptListener(() => false)
    await expect(fake.tabs.sendMessage(1, { name: 'STREAM_ASSEMBLE' })).resolves.toBeUndefined()
  })

  it('still refuses when the page has no content script at all', async () => {
    fake.tabs.control.setContentScriptListening(false)
    fake.tabs.control.setContentScriptListener((_message, _sender, sendResponse) => {
      sendResponse({ ok: true })
      return false
    })

    await expect(fake.tabs.sendMessage(1, { name: 'STREAM_ASSEMBLE' })).rejects.toThrow(
      NO_RECEIVING_END
    )
    expect(fake.runtime.lastError?.message).toBe(NO_RECEIVING_END)
  })

  it('records what was sent, so a test can assert the forward reached the right tab', () => {
    fake.tabs.control.setContentScriptListener(() => false)
    fake.tabs.sendMessage(3, { name: 'STREAM_ASSEMBLE' })
    fake.tabs.sendMessage(9, { name: 'STREAM_ASSEMBLE' })

    expect(fake.tabs.control.sentMessages().map((sent) => sent.tabId)).toEqual([3, 9])
  })
})
