import { describe, expect, it } from 'vitest'

import { createMemoryStateStore, recordKey, TABS_INDEX_KEY } from './state-port'
import type { TabMedia } from './types'

// The four state operations, and the keys they live under. The port is the only reason
// the merge, the cap and the identity rules can be proven with no browser at all.

describe('the state port', () => {
  const record = (tabId: number): TabMedia => ({
    tabId,
    pageUrl: `https://example.com/${tabId}`,
    pageTitle: 'Documentary Stream',
    status: 'ready',
    lastWriter: 'network-response',
    updatedAt: 1_700_000_000_000,
    hiddenCount: 0,
    seenKeys: [],
    entries: [],
  })

  it('keys one record per tab and names the index key once', () => {
    // The index is how the worker enumerates tabs without reading every record, so a
    // second spelling of either key is how the two drift apart.
    expect(recordKey(7)).toBe('vv:tab:7')
    expect(TABS_INDEX_KEY).toBe('vv:tabs')
  })

  it('reads back what it saved, which is the whole point of the port', async () => {
    const store = createMemoryStateStore()

    await store.save(record(1))

    expect(await store.load(1)).toEqual(record(1))
  })

  it('has no record for a tab it has never seen', async () => {
    expect(await createMemoryStateStore().load(99)).toBeNull()
  })

  it('removes a record and leaves the tab out of the index', async () => {
    const store = createMemoryStateStore([record(1), record(2)])

    await store.remove(1)

    expect(await store.load(1)).toBeNull()
    expect(await store.tabs()).toEqual([2])
  })

  it('lists only the tabs it holds, never by reading every key', async () => {
    expect(await createMemoryStateStore([record(3)]).tabs()).toEqual([3])
  })
})
