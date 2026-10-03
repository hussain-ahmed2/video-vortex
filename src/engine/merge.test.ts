import { describe, expect, it } from 'vitest'

import { FALLBACK_EXTRACTOR_ID, FALLBACK_EXTRACTOR_REASON, streamEntryUrl } from './identity'
import {
  applyReport,
  createRecord,
  createSerialQueue,
  dropUnknownStreams,
  dropVariantPlaylists,
  MAX_ENTRIES_PER_TAB,
  mergeDrafts,
  strongestStatus,
} from './merge'
import {
  CONTRACT_VERSION,
  hiddenCountFor,
  type MediaEntryDraft,
  type StreamSignals,
  type TabMedia,
} from './types'
import type { EntriesReportedRequest } from './messages'

// Spec 0004 AC-9 and AC-10: merges for one tab are serialised, the list is capped at
// fifty, and the hidden count is derived rather than accumulated, so a dropped entry
// seen again does not inflate it.

const PAGE = 'https://example.com/watch'
const NOW = 1_700_000_000_000

function draft(overrides: Partial<MediaEntryDraft> = {}): MediaEntryDraft {
  return {
    url: 'https://cdn.example.com/a.mp4',
    container: 'mp4',
    quality: 'unknown',
    kind: 'video',
    sizeBytes: 1024,
    sources: [FALLBACK_EXTRACTOR_ID],
    reason: FALLBACK_EXTRACTOR_REASON,
    ...overrides,
  }
}

function report(overrides: Partial<EntriesReportedRequest> = {}): EntriesReportedRequest {
  return {
    contractVersion: CONTRACT_VERSION,
    pageUrl: PAGE,
    pageTitle: 'Documentary Stream',
    status: 'ready',
    entries: [],
    ...overrides,
  }
}

const BASE = createRecord({
  tabId: 1,
  pageUrl: PAGE,
  pageTitle: 'Documentary Stream',
  status: 'observing',
  lastWriter: FALLBACK_EXTRACTOR_ID,
  updatedAt: NOW,
})

function recordWith(entries: number): TabMedia {
  const base = createRecord({
    tabId: 1,
    pageUrl: PAGE,
    pageTitle: 'Documentary Stream',
    status: 'observing',
    lastWriter: FALLBACK_EXTRACTOR_ID,
    updatedAt: NOW,
  })

  return mergeDrafts(
    base,
    Array.from({ length: entries }, (_unused, index) =>
      draft({ url: `https://cdn.example.com/${index}.mp4` })
    ),
    NOW
  )
}

describe('merging a finding into a record', () => {
  it('adds a finding nothing matched', () => {
    const merged = mergeDrafts(recordWith(0), [draft()], NOW)

    expect(merged.entries).toHaveLength(1)
    expect(merged.entries[0]?.url).toBe('https://cdn.example.com/a.mp4')
  })

  it('folds a repeat finding into the entry rather than listing the file twice', () => {
    const once = mergeDrafts(recordWith(0), [draft()], NOW)
    const twice = mergeDrafts(once, [draft()], NOW + 1000)

    expect(twice.entries).toHaveLength(1)
  })

  it('unions the sources, so two finders naming one file say so', () => {
    const once = mergeDrafts(recordWith(0), [draft()], NOW)
    const twice = mergeDrafts(once, [draft({ sources: ['site-extractor'] })], NOW)

    expect(twice.entries[0]?.sources).toEqual([FALLBACK_EXTRACTOR_ID, 'site-extractor'])
  })

  it('never lets a null size overwrite a known one', () => {
    const known = mergeDrafts(recordWith(0), [draft({ sizeBytes: 2048 })], NOW)
    const unknown = mergeDrafts(known, [draft({ sizeBytes: null })], NOW + 1)

    expect(unknown.entries[0]?.sizeBytes).toBe(2048)
  })

  it('takes a newer size when one is offered', () => {
    const known = mergeDrafts(recordWith(0), [draft({ sizeBytes: 2048 })], NOW)
    const updated = mergeDrafts(known, [draft({ sizeBytes: 4096 })], NOW + 1)

    expect(updated.entries[0]?.sizeBytes).toBe(4096)
  })

  it('keeps the first classification, so a row cannot change lists', () => {
    // Reclassifying the same file is not new information, and letting it move would
    // put a row in the audio list on one report and the video list on the next.
    const video = mergeDrafts(recordWith(0), [draft({ kind: 'video' })], NOW)
    const reclassified = mergeDrafts(video, [draft({ kind: 'audio' })], NOW + 1)

    expect(reclassified.entries[0]?.kind).toBe('video')
  })

  it('refreshes discoveredAt, because it is a last seen time', () => {
    const once = mergeDrafts(recordWith(0), [draft()], NOW)
    const twice = mergeDrafts(once, [draft()], NOW + 5000)

    expect(twice.entries[0]?.discoveredAt).toBe(NOW + 5000)
  })

  it('names the last writer, which is what a diagnostics view reads', () => {
    const merged = mergeDrafts(recordWith(0), [draft({ sources: ['site-extractor'] })], NOW)

    expect(merged.lastWriter).toBe('site-extractor')
  })
})

describe('the cap at fifty', () => {
  it('keeps every entry while the page stays under it', () => {
    expect(recordWith(MAX_ENTRIES_PER_TAB).entries).toHaveLength(MAX_ENTRIES_PER_TAB)
  })

  it('drops the oldest once the page exceeds it', () => {
    const merged = mergeDrafts(
      recordWith(MAX_ENTRIES_PER_TAB),
      [draft({ url: 'https://cdn.example.com/newest.mp4' })],
      NOW + 1
    )

    expect(merged.entries).toHaveLength(MAX_ENTRIES_PER_TAB)
    expect(merged.entries.map((entry) => entry.url)).not.toContain(
      'https://cdn.example.com/0.mp4'
    )
  })

  it('keeps the entry the page keeps re-requesting', () => {
    // discoveredAt is refreshed on every merge, so a source the page is actively
    // playing is never the one thrown away.
    const full = recordWith(MAX_ENTRIES_PER_TAB)
    const refreshed = mergeDrafts(full, [draft({ url: 'https://cdn.example.com/0.mp4' })], NOW + 1)
    const overflowed = mergeDrafts(
      refreshed,
      [draft({ url: 'https://cdn.example.com/newest.mp4' })],
      NOW + 2
    )

    expect(overflowed.entries.map((entry) => entry.url)).toContain(
      'https://cdn.example.com/0.mp4'
    )
  })

  it('says how many it is holding back', () => {
    const merged = mergeDrafts(
      recordWith(MAX_ENTRIES_PER_TAB),
      [draft({ url: 'https://cdn.example.com/newest.mp4' })],
      NOW + 1
    )

    expect(merged.hiddenCount).toBe(1)
    expect(hiddenCountFor(merged)).toBe(merged.hiddenCount)
  })

  it('does not inflate the hidden count when a dropped entry is seen again', () => {
    // The case a scalar seenCount could not do. The count has to remember which
    // entries it has already counted, or every re-request of a dropped file would
    // make the popup claim it is hiding one more than it is.
    const full = recordWith(MAX_ENTRIES_PER_TAB)
    const dropped = 'https://cdn.example.com/0.mp4'

    const overflowed = mergeDrafts(
      full,
      [draft({ url: 'https://cdn.example.com/newest.mp4' })],
      NOW + 1
    )
    const reappeared = mergeDrafts(overflowed, [draft({ url: dropped })], NOW + 2)

    expect(reappeared.hiddenCount).toBe(1)
  })

  it('keeps the hidden count equal to what it says, over a long noisy page', () => {
    let record = recordWith(MAX_ENTRIES_PER_TAB)
    for (let round = 0; round < 25; round += 1) {
      record = mergeDrafts(
        record,
        [draft({ url: `https://cdn.example.com/extra-${round}.mp4` })],
        NOW + round + 1
      )
    }

    expect(record.entries).toHaveLength(MAX_ENTRIES_PER_TAB)
    expect(record.hiddenCount).toBe(record.seenKeys.length - record.entries.length)
  })
})

describe('the stronger of two statuses', () => {
  it('does not let a later ready undo a blocked or unsupported', () => {
    expect(strongestStatus('blocked', 'ready')).toBe('blocked')
    expect(strongestStatus('unsupported', 'ready')).toBe('unsupported')
  })

  it('promotes observing to ready, which is progress', () => {
    expect(strongestStatus('observing', 'ready')).toBe('ready')
  })

  it('leaves a stronger status alone when the weaker arrives', () => {
    expect(strongestStatus('ready', 'observing')).toBe('ready')
  })
})

describe('applying a report to a tab', () => {
  it('creates a record when the tab has none', () => {
    const { record, changed } = applyReport({ tabId: 4, existing: null, report: report(), now: NOW })

    expect(record.tabId).toBe(4)
    expect(record.status).toBe('ready')
    expect(changed).toBe(true)
  })

  it('keeps what is already there and says it changed', () => {
    const existing = recordWith(1)
    const { record, changed } = applyReport({
      tabId: 1,
      existing,
      report: report({ entries: [draft({ url: 'https://cdn.example.com/b.mp4' })] }),
      now: NOW + 1,
    })

    expect(record.entries).toHaveLength(2)
    expect(changed).toBe(true)
  })

  it('drops a variant playlist when the master that names it arrives', () => {
    // The variants were recorded first, before anything knew they were qualities of
    // one video, so the drop cannot happen when they arrive. It happens when the master
    // does, which is the one report that knows what they are.
    const existing = recordWith(0)
    const first = applyReport({
      tabId: 1,
      existing,
      report: report({ entries: [masterEntry('https://cdn/720.m3u8'), masterEntry('https://cdn/master.m3u8', true)] }),
      now: NOW,
    })

    expect(first.record.entries.map((entry) => entry.url)).toEqual(['https://cdn/master.m3u8'])
    expect(first.changed).toBe(true)
  })

  it('reports no change when the page re-reports exactly what is stored', () => {
    // The broadcast goes out only when something moved, so a page re-requesting the
    // same file every few seconds does not become a re-read every few seconds.
    const existing = recordWith(0)
    const first = applyReport({ tabId: 1, existing, report: report({ entries: [draft()] }), now: NOW })
    const second = applyReport({ tabId: 1, existing: first.record, report: report(), now: NOW + 1 })

    expect(first.changed).toBe(true)
    expect(second.changed).toBe(false)
  })

  it('reports no change when the page re-requests the file it is already playing', () => {
    // The burst this comparison exists to absorb: a last seen time moves on every
    // re-request, and a reader can see no difference at all.
    const existing = recordWith(0)
    const first = applyReport({ tabId: 1, existing, report: report({ entries: [draft()] }), now: NOW })
    const second = applyReport({
      tabId: 1,
      existing: first.record,
      report: report({ entries: [draft()] }),
      now: NOW + 4000,
    })

    expect(second.changed).toBe(false)
    expect(second.record.entries[0]?.discoveredAt).toBe(NOW + 4000)
  })

  it('reports a change when the page title changed, which the popup shows', () => {
    const existing = recordWith(1)
    const { changed, record } = applyReport({
      tabId: 1,
      existing,
      report: report({ pageTitle: 'A Different Page' }),
      now: NOW + 1,
    })

    expect(changed).toBe(true)
    expect(record.pageTitle).toBe('A Different Page')
  })

  it('does not move the clock on a report that saw no media', () => {
    // Otherwise the staleness line reads "Updated 0s ago" on a page that found
    // nothing at all, which is a measurement of nothing.
    const existing = recordWith(1)
    const { record } = applyReport({ tabId: 1, existing, report: report(), now: NOW + 60_000 })

    expect(record.updatedAt).toBe(NOW)
  })

  it('replaces the record when the report is for another page', () => {
    // A report still in flight from a page the user has already left must not land on
    // the new page's list.
    const existing = recordWith(3)
    const { record } = applyReport({
      tabId: 1,
      existing,
      report: report({ pageUrl: 'https://example.com/other' }),
      now: NOW + 1,
    })

    expect(record.pageUrl).toBe('https://example.com/other')
    expect(record.entries).toHaveLength(0)
    expect(record.seenKeys).toHaveLength(0)
    expect(record.hiddenCount).toBe(0)
  })

  it('takes the page title from the report, which is the only place it is read', () => {
    const { record } = applyReport({
      tabId: 1,
      existing: null,
      report: report({ pageTitle: '<img src=x onerror=alert(1)>' }),
      now: NOW,
    })

    // Untrusted page text, kept as text. The popup renders it as text and never as
    // markup, which is the other half of that.
    expect(record.pageTitle).toBe('<img src=x onerror=alert(1)>')
  })
})

describe('serialising merges for one tab', () => {
  it('runs two reports in order, so neither loses an entry', async () => {
    const queue = createSerialQueue()
    const store = new Map<number, TabMedia>()

    const apply = async (url: string): Promise<void> => {
      await queue.run(1, async () => {
        const existing = store.get(1) ?? null
        // The read and the write are separated by an await on purpose: that is the
        // window two interleaved reports would slip through.
        const loaded = existing ?? recordWith(0)
        const { record } = applyReport({
          tabId: 1,
          existing: loaded,
          report: report({ entries: [draft({ url })] }),
          now: NOW,
        })
        await Promise.resolve()
        store.set(1, record)
      })
    }

    await Promise.all([
      apply('https://cdn.example.com/one.mp4'),
      apply('https://cdn.example.com/two.mp4'),
    ])

    expect(store.get(1)?.entries).toHaveLength(2)
  })

  it('keeps one tab waiting behind another tab without blocking it', async () => {
    const queue = createSerialQueue()
    const order: string[] = []

    const slow = queue.run(1, async () => {
      order.push('slow:start')
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push('slow:end')
    })
    const fast = queue.run(2, async () => {
      order.push('fast')
    })

    await Promise.all([slow, fast])

    expect(order).toEqual(['slow:start', 'fast', 'slow:end'])
  })

  it('keeps running a tab after one of its tasks threw', async () => {
    // A rejected chain would skip every later report for that tab, which reads as
    // detection having silently stopped working.
    const queue = createSerialQueue()

    const failed = queue.run(1, async () => {
      throw new Error('storage went away')
    })
    const after = queue.run(1, async () => 'ran anyway')

    await expect(failed).rejects.toThrow('storage went away')
    await expect(after).resolves.toBe('ran anyway')
  })
})

// Spec 0005 AC-15 and AC-21. A hook report is a full snapshot, so anything absent
// from it is gone, and `mergeDrafts` can fold and cap but cannot delete.

function streamSignals(streamId: number, overrides: Partial<StreamSignals> = {}): StreamSignals {
  return {
    streamId,
    origin: 'mse',
    bytes: 100,
    bufferedBytes: 100,
    live: false,
    encrypted: false,
    ended: false,
    partialReason: 'none',
    mediaElementName: null,
    ...overrides,
  }
}

function streamDraft(streamId: number, overrides: Partial<StreamSignals> = {}): MediaEntryDraft {
  const url = streamEntryUrl('https://example.com/watch', streamId)
  return {
    url,
    container: 'mp4',
    quality: 'unknown',
    kind: 'video',
    sizeBytes: 100,
    sources: ['page-hook'],
    reason: 'page stream',
    stream: streamSignals(streamId, overrides),
  }
}

describe('carrying a stream through a merge', () => {
  // covers: AC-5
  it('keeps the signals on a brand new entry', () => {
    const record = mergeDrafts(createRecord(BASE), [streamDraft(1)], 10)
    expect(record.entries[0]?.stream?.streamId).toBe(1)
  })

  // covers: AC-5, AC-9
  it('takes the newest snapshot whole rather than merging signal fields', () => {
    // Merging field by field could produce a combination the page never observed:
    // a latched page_cap beside a fresh bufferedBytes from before the stream broke.
    const first = mergeDrafts(createRecord(BASE), [streamDraft(1)], 10)
    const second = mergeDrafts(first, [streamDraft(1, { partialReason: 'page_cap', bufferedBytes: 40 })], 20)

    expect(second.entries).toHaveLength(1)
    expect(second.entries[0]?.stream?.partialReason).toBe('page_cap')
    expect(second.entries[0]?.stream?.bufferedBytes).toBe(40)
  })

  // covers: AC-3
  it('keeps two streams on one page as two rows', () => {
    const record = mergeDrafts(createRecord(BASE), [streamDraft(1), streamDraft(2)], 10)
    expect(record.entries.map((entry) => entry.stream?.streamId)).toEqual([1, 2])
  })
})

describe('dropping the streams a snapshot does not list', () => {
  // covers: AC-15, AC-21
  it('drops a stream the page no longer holds', () => {
    const record = mergeDrafts(createRecord(BASE), [streamDraft(1), streamDraft(2)], 10)
    const kept = dropUnknownStreams(record, new Set([1]))

    expect(kept.entries.map((entry) => entry.stream?.streamId)).toEqual([1])
  })

  // covers: AC-21
  it('clears the counted key too, or the hidden count lies forever', () => {
    // The half that is easy to miss. hiddenCount is counted less held, so a dead
    // stream left in seenKeys keeps inflating what the cap claims to hold back.
    const record = mergeDrafts(createRecord(BASE), [streamDraft(1), streamDraft(2)], 10)
    expect(record.seenKeys).toHaveLength(2)

    const kept = dropUnknownStreams(record, new Set([1]))
    expect(kept.seenKeys).toHaveLength(1)
    expect(hiddenCountFor(kept)).toBe(0)
  })

  // covers: AC-21
  it('reports a real hidden count when a dropped stream had been capped away', () => {
    const many = Array.from({ length: MAX_ENTRIES_PER_TAB + 2 }, (_, index) =>
      streamDraft(index + 1)
    )
    const record = mergeDrafts(createRecord(BASE), many, 10)
    // The cap keeps the fifty newest, so the two it dropped are ids 1 and 2.
    expect(record.entries).toHaveLength(MAX_ENTRIES_PER_TAB)
    expect(record.hiddenCount).toBe(2)

    const kept = dropUnknownStreams(record, new Set([3, 4]))
    expect(kept.entries.map((entry) => entry.stream?.streamId)).toEqual([3, 4])
    expect(kept.seenKeys).toHaveLength(2)
    expect(hiddenCountFor(kept)).toBe(0)
  })

  // covers: AC-15
  it('never touches a file entry, whose observer has no snapshot', () => {
    const withFile = mergeDrafts(
      createRecord(BASE),
      [
        {
          url: 'https://cdn.example.com/a.mp4',
          container: 'mp4',
          quality: 'unknown',
          kind: 'video',
          sizeBytes: 10,
          sources: ['network-response'],
          reason: 'network response',
        },
        streamDraft(1),
      ],
      10
    )

    const kept = dropUnknownStreams(withFile, new Set())
    expect(kept.entries.map((entry) => entry.url)).toEqual(['https://cdn.example.com/a.mp4'])
  })

  // covers: AC-21
  it('returns the same record when nothing was dropped', () => {
    const record = mergeDrafts(createRecord(BASE), [streamDraft(1)], 10)
    expect(dropUnknownStreams(record, new Set([1]))).toBe(record)
  })
})

// covers: AC-4
describe('dropping a quality playlist a master names', () => {
  function masterDraft(url: string, variants: string[]): MediaEntryDraft {
    return {
      url,
      container: 'm3u8',
      quality: 'unknown',
      kind: 'video',
      sizeBytes: null,
      sources: ['network-response'],
      reason: 'network response',
      playlist: {
        live: false,
        encrypted: false,
        byteRanged: false,
        manifest: 'hls',
        segments: 'mp4',
        variants,
      },
    }
  }

  function variantDraft(url: string): MediaEntryDraft {
    return {
      url,
      container: 'm3u8',
      quality: 'unknown',
      kind: 'video',
      sizeBytes: null,
      sources: ['network-response'],
      reason: 'network response',
    }
  }

  it('keeps the master and drops the variants it points at', () => {
    const record = dropVariantPlaylists(
      mergeDrafts(
        createRecord(BASE),
        [variantDraft('https://cdn/720.m3u8'), variantDraft('https://cdn/360.m3u8'), masterDraft('https://cdn/master.m3u8', ['https://cdn/720.m3u8', 'https://cdn/360.m3u8'])],
        10
      )
    )

    // The person wants one row for the video. Four qualities of it are not four saves.
    expect(record.entries.map((entry) => entry.url)).toEqual(['https://cdn/master.m3u8'])
  })

  it('clears the counted keys of dropped variants, so the hidden count stays honest', () => {
    const record = dropVariantPlaylists(
      mergeDrafts(
        createRecord(BASE),
        [variantDraft('https://cdn/720.m3u8'), masterDraft('https://cdn/master.m3u8', ['https://cdn/720.m3u8'])],
        10
      )
    )

    // hiddenCount is counted less held, so a variant left in seenKeys would permanently
    // read as one the cap is holding back.
    expect(record.hiddenCount).toBe(0)
    expect(record.seenKeys).toEqual(['https://cdn/master.m3u8|m3u8|unknown'])
  })

  it('leaves a playlist that is not a variant alone', () => {
    const record = dropVariantPlaylists(
      mergeDrafts(
        createRecord(BASE),
        [masterDraft('https://cdn/master.m3u8', ['https://cdn/720.m3u8']), masterDraft('https://cdn/other.m3u8', [])],
        10
      )
    )

    expect(record.entries).toHaveLength(2)
  })

  it('returns the same record when nothing was dropped', () => {
    const record = mergeDrafts(createRecord(BASE), [masterDraft('https://cdn/master.m3u8', [])], 10)
    expect(dropVariantPlaylists(record)).toBe(record)
  })
})

function masterEntry(url: string, isMaster = false): MediaEntryDraft {
  return {
    url,
    container: 'm3u8',
    quality: 'unknown',
    kind: 'video',
    sizeBytes: null,
    sources: ['network-response'],
    reason: 'network response',
    playlist: isMaster
      ? {
          live: false,
          encrypted: false,
          byteRanged: false,
          manifest: 'hls',
          segments: 'mp4',
          variants: ['https://cdn/720.m3u8'],
        }
      : undefined,
  }
}
