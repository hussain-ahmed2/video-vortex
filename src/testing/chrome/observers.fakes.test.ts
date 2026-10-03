import { beforeEach, describe, expect, it } from 'vitest'

import { createFakeAction } from './action'
import { createFakeScripting, INJECTION_FAILED } from './scripting'
import type { FakeResponseDetails } from './web-request'
import { createFakeWebRequest } from './web-request'

// The three fakes the worker's observer, badge and injection branch are proven
// against.
//
// covers: AC-7 (the fakes spec 0004 names), AC-16 (the badge fake) If these are weak, every worker test built on them proves nothing, so
// each is exercised the way the worker uses it, including the ways it can go wrong.

describe('fake webRequest', () => {
  it('delivers a fired response to a registered listener', () => {
    const fake = createFakeWebRequest()
    const seen: FakeResponseDetails[] = []
    fake.onHeadersReceived.addListener((details) => seen.push(details))

    fake.control.respond({ url: 'https://cdn.example.com/a.mp4', tabId: 1 })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('https://cdn.example.com/a.mp4')
    expect(seen[0]?.statusCode).toBe(200)
  })

  it('builds the header list the way a server states it', () => {
    const fake = createFakeWebRequest()
    let seen: FakeResponseDetails | undefined
    fake.onHeadersReceived.addListener((details) => {
      seen = details
    })

    fake.control.respond({
      url: 'https://cdn.example.com/a.mp4',
      tabId: 1,
      contentType: 'video/mp4',
      contentLength: '1024',
    })

    expect(seen?.responseHeaders).toEqual([
      { name: 'Content-Type', value: 'video/mp4' },
      { name: 'Content-Length', value: '1024' },
    ])
  })

  it('carries a content encoding when the body was compressed', () => {
    const fake = createFakeWebRequest()
    let seen: FakeResponseDetails | undefined
    fake.onHeadersReceived.addListener((details) => {
      seen = details
    })

    fake.control.respond({
      url: 'https://cdn.example.com/a.mp4',
      tabId: 1,
      contentLength: '1024',
      contentEncoding: 'gzip',
    })

    expect(seen?.responseHeaders).toContainEqual({ name: 'Content-Encoding', value: 'gzip' })
  })

  it('delivers a failure status, so the 2xx rule can be exercised', () => {
    const fake = createFakeWebRequest()
    let seen: FakeResponseDetails | undefined
    fake.onHeadersReceived.addListener((details) => {
      seen = details
    })

    fake.control.respond({ url: 'https://cdn.example.com/a.mp4', tabId: 1, statusCode: 404 })

    expect(seen?.statusCode).toBe(404)
  })

  it('gives every event its own request id', () => {
    // Chrome reuses a request id across a redirect chain, so a worker keying anything
    // on it would conflate the 302 with the 200 that followed.
    const fake = createFakeWebRequest()
    const ids: string[] = []
    fake.onHeadersReceived.addListener((details) => ids.push(details.requestId))

    fake.control.respond({ url: 'https://cdn.example.com/a.mp4', tabId: 1 })
    fake.control.respond({ url: 'https://cdn.example.com/a.mp4', tabId: 1 })

    expect(new Set(ids).size).toBe(2)
  })

  it('reports the filter and extra info spec the listener registered with', () => {
    // Response headers arrive only when `responseHeaders` is in the extra info spec.
    // A fake that dropped it would let a worker which never asked for them pass.
    const fake = createFakeWebRequest()

    fake.onHeadersReceived.addListener(
      () => {},
      { urls: ['<all_urls>'] },
      ['responseHeaders']
    )

    expect(fake.control.registration()).toEqual({
      urls: ['<all_urls>'],
      extraInfoSpec: ['responseHeaders'],
    })
  })

  it('has no registration before anything listens', () => {
    expect(createFakeWebRequest().control.registration()).toBeNull()
  })

  it('delivers nothing once the listener is removed', () => {
    const fake = createFakeWebRequest()
    let calls = 0
    const listener = () => {
      calls += 1
    }
    fake.onHeadersReceived.addListener(listener)
    fake.onHeadersReceived.removeListener(listener)

    fake.control.respond({ url: 'https://cdn.example.com/a.mp4', tabId: 1 })

    expect(calls).toBe(0)
    expect(fake.onHeadersReceived.hasListener(listener)).toBe(false)
  })
})

describe('fake action', () => {
  let fake: ReturnType<typeof createFakeAction>

  beforeEach(() => {
    fake = createFakeAction()
  })

  it('reads back the badge text it was given', () => {
    fake.setBadgeText({ tabId: 1, text: '12' })

    expect(fake.control.badgeText(1)).toBe('12')
  })

  it('keeps one badge per tab', () => {
    fake.setBadgeText({ tabId: 1, text: '3' })
    fake.setBadgeText({ tabId: 2, text: '7' })

    expect(fake.control.badgeText(1)).toBe('3')
    expect(fake.control.badgeText(2)).toBe('7')
  })

  it('reads back a cleared badge as empty rather than as the last count', () => {
    fake.setBadgeText({ tabId: 1, text: '3' })
    fake.setBadgeText({ tabId: 1, text: '' })

    expect(fake.control.badgeText(1)).toBe('')
  })

  it('has no badge for a tab it was never told about', () => {
    expect(fake.control.badgeText(9)).toBe('')
  })

  it('records the capped text as it was written, so a test can prove the cap', () => {
    fake.setBadgeText({ tabId: 1, text: '99+' })

    expect(fake.control.calls()).toEqual([
      { method: 'setBadgeText', tabId: 1, value: '99+' },
    ])
  })

  it('forgets everything on reset', () => {
    fake.setBadgeText({ tabId: 1, text: '3' })
    fake.control.reset()

    expect(fake.control.badgeText(1)).toBe('')
    expect(fake.control.calls()).toEqual([])
  })
})

describe('fake scripting', () => {
  it('resolves when the page allows injection', async () => {
    await expect(createFakeScripting().executeScript({ target: { tabId: 1 } })).resolves.toEqual(
      []
    )
  })

  it('rejects when injection fails, with Chrome wording', async () => {
    // This is the path that makes the read path answer `unsupported` rather than
    // showing an empty list on a page it simply cannot read.
    const fake = createFakeScripting()
    fake.control.setInjectionFails(true)

    await expect(fake.executeScript({ target: { tabId: 1 } })).rejects.toThrow(INJECTION_FAILED)
  })

  it('records what was injected where', async () => {
    const fake = createFakeScripting()

    await fake.executeScript({ target: { tabId: 4 }, files: ['content.js'] })

    expect(fake.control.calls()).toEqual([{ tabId: 4, files: ['content.js'] }])
  })

  it('records a failed attempt too, so a test can prove it was tried', async () => {
    const fake = createFakeScripting()
    fake.control.setInjectionFails(true)

    await expect(fake.executeScript({ target: { tabId: 4 } })).rejects.toThrow()

    expect(fake.control.calls()).toHaveLength(1)
  })
})
