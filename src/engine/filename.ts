// Owns the six step rule that turns a row into a file name. One place, because the
// popup and the worker must never disagree about what a file is called, and because
// this is the single seam scope feature 13 replaces with a template and a settings
// store.
//
// It produces a name, never a path. Choosing the folder is feature 13's job, and until
// then a download must not be able to write outside the download directory.

import { isStreamUrl } from './identity'
import { containerFromPath, KNOWN_CONTAINERS } from './media-rules'

/** The characters a file system rejects, named one at a time by spec 0001 step 4. */
const REJECTED = /[/\\:*?"<>|]/g

/** The last code point a name may contain before it counts as a control character. */
const LAST_PRINTABLE_CODE_POINT = 31

/** Above this the name stops being readable in a download list. */
const MAX_LENGTH = 180

/** Used when sanitising has left nothing to name the file after. */
const FALLBACK_BASE = 'video'

export interface FilenameInput {
  /** The page title. Empty on a page that never set one. */
  pageTitle: string
  url: string
  container: string
  quality: string
  /**
   * The file name the media element's own address carried, for a stream.
   *
   * A stream has no address and therefore no name of its own, so this is the next best
   * thing after the page title. Absent for a file entry, whose url already has one.
   */
  mediaElementName?: string | null
}

/**
 * The last segment of a URL's path, which is the next best thing to a page title.
 *
 * The segment's own extension comes off, because step 3 puts one back. Left on, an
 * untitled page saves every file as `clip.mp4.mp4`.
 */
function baseFromUrl(url: string): string {
  let segment: string
  try {
    const { pathname } = new URL(url)
    segment = decodeURIComponent(pathname.slice(pathname.lastIndexOf('/') + 1))
  } catch {
    return ''
  }

  const dot = segment.lastIndexOf('.')
  if (dot <= 0) return segment

  const extension = segment.slice(dot + 1).toLowerCase()
  return KNOWN_CONTAINERS.includes(extension) ? segment.slice(0, dot) : segment
}

/** The container when it is one we can name, else the URL's own extension, else none. */
function extensionFor(container: string, url: string): string {
  const known = container.toLowerCase()
  if (KNOWN_CONTAINERS.includes(known)) return known

  return containerFromPath(url) ?? ''
}

/**
 * Drops control characters, which a file system rejects on the same grounds as the
 * punctuation above.
 *
 * Written as a filter rather than a range in a character class, because a name that
 * cannot be typed is a name nobody can debug.
 */
function stripControlCharacters(value: string): string {
  return [...value]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0
      return code > LAST_PRINTABLE_CODE_POINT && code !== 127
    })
    .join('')
}

/** The stem with everything a file system rejects taken out. */
function sanitise(value: string): string {
  return stripControlCharacters(value).replace(REJECTED, '').replace(/\s+/g, '_')
}

/**
 * The file name for one entry.
 *
 * The stem is sanitised before the extension is joined on, not after. A page title of
 * `!!!` sanitises to nothing exactly as an empty title does, and doing it the other
 * way round would produce `.mp4`: a hidden file with no name, on every untitled or
 * punctuation only page.
 */
export function buildFilename({
  pageTitle,
  url,
  container,
  quality,
  mediaElementName,
}: FilenameInput): string {
  // 1. Base: the page's own title, else the name the media element's address carried,
  //    else the last segment of the path.
  //
  //    A stream's url is one we minted and its path names the page rather than the media,
  //    so it is never read as a name. The percent encoding means it could not even be
  //    cleaned into something usable, and a name built from the page's own address would
  //    be the same for every stream on the page.
  const base = pageTitle.trim() || mediaElementName?.trim() || (isStreamUrl(url) ? '' : baseFromUrl(url))

  // 2. Quality, only when there is one. `unknown` is the fallback's standing answer
  //    throughout this slice, so appending it would put an underscore and the word
  //    unknown on the end of every file the extension saves.
  const suffix = quality && quality !== 'unknown' ? `_${quality}` : ''

  // 3. Extension from what is known, never from what a file of this kind usually is.
  const extension = extensionFor(container, url)

  // 4. Strip what a file system rejects, collapse runs of whitespace to one
  //    underscore, and leave room for the extension inside the length limit.
  const room = MAX_LENGTH - (extension ? extension.length + 1 : 0)
  const stem = sanitise(`${base}${suffix}`).slice(0, Math.max(1, room)) || FALLBACK_BASE

  const name = extension ? `${stem}.${extension}` : stem

  // 5. No path separator can survive the strip above, and this asserts that rather
  //    than providing it: a name that somehow still holds one is not a name, because
  //    honouring it would let a download write outside the download directory.
  if (/[/\\]/.test(name)) return FALLBACK_BASE

  // 6. Belt and braces for the empty case the stem already covers.
  return name || FALLBACK_BASE
}
