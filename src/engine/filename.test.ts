import { describe, expect, it } from 'vitest'

import { buildFilename } from './filename'
import { streamEntryUrl } from './identity'

// Spec 0001's filename rule, the six steps. It matters before a browser is involved: a
// name that is wrong is written to disk, and step 5 is the reason a download cannot
// escape the download directory.

const PAGE_TITLE = 'Documentary Stream'
const MP4 = 'https://cdn.example.com/media/clip.mp4'

function name(overrides: Partial<Parameters<typeof buildFilename>[0]> = {}): string {
  return buildFilename({
    pageTitle: PAGE_TITLE,
    url: MP4,
    container: 'mp4',
    quality: 'unknown',
    ...overrides,
  })
}

describe('step 1, the base of the name', () => {
  it('uses the page title when there is one', () => {
    expect(name()).toBe('Documentary_Stream.mp4')
  })

  it('falls back to the last segment of the url path', () => {
    expect(name({ pageTitle: '' })).toBe('clip.mp4')
  })

  it('collapses the spaces a title is full of into one underscore', () => {
    expect(name({ pageTitle: 'A   Long    Title' })).toBe('A_Long_Title.mp4')
  })
})

describe('step 2, the quality', () => {
  it('is left off entirely when the quality is unknown', () => {
    // `unknown` is the fallback's standing answer throughout this slice, so appending
    // it would put an underscore and the word unknown on the end of every file.
    expect(name()).not.toContain('unknown')
  })

  it('is appended when a site has named one', () => {
    expect(name({ quality: '1080p' })).toBe('Documentary_Stream_1080p.mp4')
  })
})

describe('step 3, the extension', () => {
  it('comes from the container the engine derived', () => {
    expect(name({ container: 'webm' })).toBe('Documentary_Stream.webm')
  })

  it('falls back to the extension in the url when the container is unknown', () => {
    expect(name({ container: 'unknown', url: 'https://cdn.example.com/a.webm' })).toBe(
      'Documentary_Stream.webm'
    )
  })

  it('is left off when neither knows one, rather than guessed', () => {
    // Never guess mp4. A file named .mp4 that is not one is worse than a file with no
    // extension, which the browser can still open.
    expect(name({ container: 'unknown', url: 'https://cdn.example.com/stream' })).toBe(
      'Documentary_Stream'
    )
  })

  it('keeps a manifest own extension, since a manifest can be named even if not saved', () => {
    expect(name({ container: 'm3u8', url: 'https://cdn.example.com/master.m3u8' })).toBe(
      'Documentary_Stream.m3u8'
    )
  })
})

describe('step 4, what a file system rejects', () => {
  it.each([
    ['a slash', 'Episode/One', 'EpisodeOne'],
    ['a backslash', 'Episode\\One', 'EpisodeOne'],
    ['a colon', 'Ep. 4: The Cut', 'Ep._4_The_Cut'],
    ['an asterisk', 'What a *Title*', 'What_a_Title'],
    ['a question mark', 'Who? What?', 'Who_What'],
    ['a quote', 'The "Best" Bit', 'The_Best_Bit'],
    ['a less than sign', '1 < 2', '1_2'],
    ['a greater than sign', '2 > 1', '2_1'],
    ['a pipe', 'A | B', 'A_B'],
  ])('strips %s and keeps the rest of the title', (_label, title, expected) => {
    expect(name({ pageTitle: title })).toBe(`${expected}.mp4`)
  })

  it('keeps punctuation a file system accepts, because sanitising is not deleting', () => {
    // `!` is legal in a file name. A rule that strips everything non alphanumeric
    // throws away the part of a title a person recognises.
    expect(name({ pageTitle: 'Wow! (2024)' })).toBe('Wow!_(2024).mp4')
  })

  it('strips control characters', () => {
    // Built rather than typed: a raw control character in a test file is invisible in
    // a diff and turns the file into binary to every tool that reads it.
    const title = `Before${String.fromCharCode(1)}After`

    expect(name({ pageTitle: title })).toBe('BeforeAfter.mp4')
  })

  it('trims to 180 characters, extension included', () => {
    const long = name({ pageTitle: 'x'.repeat(400) })

    expect(long).toHaveLength(180)
    expect(long.endsWith('.mp4')).toBe(true)
  })
})

describe('steps 5 and 6, the two safety steps', () => {
  it('never lets a path separator through, whatever the title held', () => {
    for (const title of ['../../etc/passwd', 'a/b/c', '..\\..\\windows']) {
      expect(name({ pageTitle: title })).not.toMatch(/[/\\]/)
    }
  })

  it('leaves no extension of its own on the url fallback, so nothing doubles', () => {
    // Step 3 puts the extension back, so a base that kept the segment's own would save
    // an untitled page's every file as `clip.mp4.mp4`.
    expect(name({ pageTitle: '' })).toBe('clip.mp4')
  })

  it('falls back to video when the title sanitises away to nothing', () => {
    // A title made only of rejected characters sanitises to nothing exactly as an empty
    // title does. Doing this the other way round produced `.mp4`, a hidden file with no
    // name at all.
    expect(name({ pageTitle: '<<>>' })).toBe('video.mp4')
  })

  it('falls back to video when there is nothing left to name it from at all', () => {
    const input = { pageTitle: '<<>>', url: 'https://cdn.example.com/stream', container: 'unknown' }

    expect(buildFilename({ ...input, quality: 'unknown' })).toBe('video')
  })

  it('produces a name for every combination that reaches it', () => {
    const cases = [
      { pageTitle: '', url: 'not a url', container: 'unknown', quality: 'unknown' },
      { pageTitle: '...', url: '', container: '', quality: '720p' },
      { pageTitle: 'ok', url: MP4, container: 'mp4', quality: '' },
    ]

    for (const input of cases) {
      expect(buildFilename(input).length).toBeGreaterThan(0)
    }
  })
})
// ─── Spec 0005: the stream branch of the same rule ──────────────────────────

/** A stream's url is one we minted, so the rule has to treat it differently from an address. */
const STREAM_URL = streamEntryUrl('https://example.com/watch/episode-2.html', 3)

function streamName(overrides: Partial<Parameters<typeof buildFilename>[0]> = {}): string {
  return buildFilename({
    pageTitle: '',
    url: STREAM_URL,
    container: 'webm',
    quality: 'unknown',
    ...overrides,
  })
}

describe('naming a stream, which has no address of its own', () => {
  it('uses the page title first, exactly as a file does', () => {
    expect(streamName({ pageTitle: PAGE_TITLE })).toBe(`${PAGE_TITLE.replace(/ /g, '_')}.webm`)
  })

  it('falls back to the name the media element carried', () => {
    // The only thing between an untitled page and a fixed word. A stream has no url to read
    // a name off, so this is the page's own answer about what it is playing.
    expect(streamName({ mediaElementName: 'Episode_Two' })).toBe('Episode_Two.webm')
  })

  it('falls back to a fixed word, having nothing else to go on', () => {
    expect(streamName()).toBe('video.webm')
  })

  it('never reads a name off the url it minted', () => {
    // The minted url carries the page address, so reading its path would name every stream
    // on a page after that page rather than after the media.
    expect(streamName()).not.toContain('episode-2')
    expect(streamName()).not.toContain('example.com')
  })

  it('treats an element name that sanitises away as no name at all', () => {
    // The same case as a page title of `!!!`: sanitising to nothing has to read as nothing,
    // or the extension writes `.webm`, a hidden file with no name.
    expect(streamName({ mediaElementName: '///' })).toBe('video.webm')
  })

  it("keeps the extension the container names", () => {
    expect(streamName({ container: 'mp4', mediaElementName: 'Episode_Two' })).toBe(
      'Episode_Two.mp4'
    )
  })

  it('leaves a file entry exactly as it was', () => {
    // The branch is only for a url we minted. A file's url is an address and is read as one.
    expect(name({ pageTitle: '', url: 'https://cdn.example.com/media/clip.mp4' })).toBe(
      'clip.mp4'
    )
    expect(name({ pageTitle: '' })).toBe('clip.mp4')
  })

  it('refuses an element name that would escape the download directory', () => {
    // The page is the only party that supplies this string, and step five is the reason a
    // download cannot write outside the download directory.
    for (const attempt of ['../../etc/passwd', 'a/b', 'a\\b', '..']) {
      const built = streamName({ mediaElementName: attempt })
      expect(built).not.toMatch(/[/\\]/)
      expect(built.endsWith('.webm')).toBe(true)
    }
  })
})