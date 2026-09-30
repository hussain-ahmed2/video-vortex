import { describe, expect, it } from 'vitest'
import { installFakeChrome, NO_RECEIVING_END, splitCallback } from './index'

// The harness's public surface, exercised the way slice 1 will consume it: one
// import path, not four internal ones. A re-export that is renamed or dropped
// breaks every test written after this one, so the barrel is worth a check.

describe('the testing barrel', () => {
  it('exposes the installer as the single entry point', () => {
    expect(typeof installFakeChrome).toBe('function')
  })

  it('installs fakes that are reachable through the returned object', () => {
    // covers: AC-3
    const fake = installFakeChrome([{ id: 4, url: 'https://example.com/a' }])

    expect(fake).toBe(globalThis.chrome)
    expect(typeof fake.storage.session.get).toBe('function')
    expect(typeof fake.runtime.sendMessage).toBe('function')
    expect(typeof fake.tabs.query).toBe('function')
    expect(typeof fake.downloads.download).toBe('function')
  })

  it('re-exports the callback helper and the Chrome error wording', () => {
    // A test that imports these from the barrel proves slice 1 can too.
    expect(typeof splitCallback).toBe('function')
    expect(NO_RECEIVING_END).toContain('Receiving end does not exist')
  })
})
