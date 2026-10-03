import { describe, expect, it } from 'vitest'

import {
  formatBytes,
  formatPlaylistNote,
  formatHiddenCount,
  formatProgressLabel,
  formatStaleness,
  progressPercent,
} from './format'
import type { DownloadStatus } from './messages'

// The popup's computed copy. Each of these was previously only checkable by rendering
// the popup and reading the screen, which is how "48.2" and "48.2 MB" both look right
// to whoever wrote them.

describe('the size on a row', () => {
  it('says the size is unknown rather than showing a zero or a dash', () => {
    expect(formatBytes(null)).toBe('Size unknown')
  })

  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [1024 * 1024, '1.0 MB'],
    [48_200_000, '46.0 MB'],
    [1024 * 1024 * 1024, '1.0 GB'],
  ])('renders %i bytes as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected)
  })
})

describe('how stale the list is', () => {
  const at = (secondsAgo: number): string => formatStaleness(1_000_000, 1_000_000 + secondsAgo * 1000)

  it('counts whole seconds under a minute', () => {
    expect(at(0)).toBe('Updated 0s ago')
    expect(at(12)).toBe('Updated 12s ago')
    expect(at(59)).toBe('Updated 59s ago')
  })

  it('switches to minutes at a minute, rather than showing 60s', () => {
    expect(at(60)).toBe('Updated 1m ago')
    expect(at(119)).toBe('Updated 1m ago')
  })

  it('switches to hours past an hour', () => {
    expect(at(3600)).toBe('Updated 1h ago')
    expect(at(7200)).toBe('Updated 2h ago')
  })

  it('never counts backwards, because a clock that jumped would read as nonsense', () => {
    expect(formatStaleness(2_000_000, 1_000_000)).toBe('Updated 0s ago')
  })
})

describe('what the cap is holding back', () => {
  it('names both the rows on screen and the rows the page exposed', () => {
    // "12 hidden" would leave a person guessing whether the list is complete.
    expect(formatHiddenCount(50, 12)).toBe('Showing 50 of 62 found')
  })

  it('reads sensibly when nothing is held back', () => {
    expect(formatHiddenCount(3, 0)).toBe('Showing 3 of 3 found')
  })
})

describe('a transfer in flight', () => {
  it('rounds to whole percent and clamps at 100', () => {
    expect(progressPercent(0, 1000)).toBe(0)
    expect(progressPercent(333, 1000)).toBe(33)
    // `bytesReceived` counts a whole body while `totalBytes` is the declared size, so a
    // redirect reports more than it was promised.
    expect(progressPercent(1400, 1000)).toBe(100)
    expect(progressPercent(-5, 1000)).toBe(0)
  })

  it('claims no percentage at all when the total is unknown', () => {
    expect(progressPercent(500, null)).toBeNull()
    expect(progressPercent(500, 0)).toBeNull()
  })

  it('labels a determinate transfer with its percentage', () => {
    const status: DownloadStatus = {
      downloadId: 1,
      url: 'https://cdn.example.com/a.mp4',
      bytesReceived: 620,
      totalBytes: 1000,
      state: 'in_progress',
    }

    expect(formatProgressLabel(status)).toBe('Downloading 62%')
  })

  it('labels an indeterminate transfer as size unknown rather than as zero percent', () => {
    const status: DownloadStatus = {
      downloadId: 1,
      url: 'https://cdn.example.com/a.mp4',
      bytesReceived: 500,
      totalBytes: null,
      state: 'in_progress',
    }

    // "Downloading 0%" on a transfer that is visibly progressing is a lie, and the
    // empty track it pairs with would never move.
    expect(formatProgressLabel(status)).toBe('Downloading, size unknown')
  })
})

describe('the sentence a manifest row shows', () => {
  it('says it could not be read when the page never got facts', () => {
    expect(formatPlaylistNote('unread')).toBe('This page streams video we could not read')
  })

  it('reuses the stream sentence for a live playlist, so one broadcast reads the same in both lists', () => {
    expect(formatPlaylistNote('live')).toBe('This is a live stream, so there is no file to save')
  })

  it('says the segments are encrypted rather than pretending to save them', () => {
    expect(formatPlaylistNote('encrypted')).toBe('This stream is encrypted, so there is nothing we can save')
  })

  it('names the reason, which is the whole of what the copy is for', () => {
    expect(formatPlaylistNote('byte_ranged')).toBe(
      'This playlist points into one file in pieces, which we do not follow yet'
    )
    expect(formatPlaylistNote('unsupported_container')).toBe(
      'This page streams video in a format we cannot save yet'
    )
  })

  it('says nothing when the row can simply be joined, because the control is the explanation', () => {
    expect(formatPlaylistNote('assemblable')).toBeNull()
  })
})
