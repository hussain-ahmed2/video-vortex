// Fakes the page's own media APIs, which the page hook patches: `MediaSource`,
// `SourceBuffer`, the blob addresses `URL.createObjectURL` hands out, and the players a
// page plays through.
//
// These are here because jsdom implements none of it. `MediaSource` and `SourceBuffer`
// are absent entirely, and a `<video>` element reports an empty `currentSrc` and a `NaN`
// duration whether or not it was given a source, because jsdom loads no media. So a hook
// tested against jsdom alone would run against a browser that does not exist, and the
// two facts a stream row is derived from, the buffered ranges and the infinite duration,
// would be untestable.
//
// The fakes are deliberately thin. The hook patches the prototypes of the objects
// exported here, and a test drives them through those same patched methods, so what a
// test exercises is the hook's real interception path rather than a side door into its
// state.
//
// Needs a DOM: `EventTarget`, `Blob` and `URL` are read at module scope.

// ─── SourceBuffer ───────────────────────────────────────────────────────────

export interface FakeTimeRanges {
  readonly length: number
  start(index: number): number
  end(index: number): number
}

export interface FakeSourceBufferOptions {
  /** Refuse every append against the browser's own per buffer quota, as Chrome does. */
  quotaExceeded?: boolean
}

/** Test side driver for one buffer. Not part of the page's API. */
export interface FakeSourceBufferControl {
  /** Appends bytes the way a player does, through whatever wraps this method now. */
  append(bytes: Uint8Array<ArrayBuffer>): Promise<void>
  /** Tears a hole in the buffered ranges, as `SourceBuffer.remove` does. */
  remove(start: number, end: number): void
  /** Abandons the buffer, which is what a player giving up on a stream does. */
  abort(): void
  /** Fires the event a browser fires once it learns the stream is encrypted. */
  emitEncrypted(): void
  /** What the buffer reports buffered, which is what a row's appearance reads from. */
  bufferedRanges(): FakeTimeRanges
  /** The bytes this buffer was given, in order. */
  accepted(): Uint8Array<ArrayBuffer>[]
  setQuotaExceeded(exceeded: boolean): void
}

export class FakeSourceBuffer extends EventTarget implements FakeSourceBufferControl {
  /** The name Chrome gives the error it throws when an append is over quota. */
  static readonly QUOTA_ERROR = 'QuotaExceededError'

  readonly mimeType: string
  updating = false

  private readonly ranges: { start: number; end: number }[] = []
  private readonly acceptedBytes: Uint8Array<ArrayBuffer>[] = []
  private quotaExceeded: boolean

  constructor(mimeType: string, options: FakeSourceBufferOptions = {}) {
    super()
    this.mimeType = mimeType
    this.quotaExceeded = options.quotaExceeded ?? false
  }

  get buffered(): FakeTimeRanges {
    return timeRangesOf(this.ranges)
  }

  /**
   * Appends, refusing when the buffer is over its own quota.
   *
   * The refusal throws rather than rejects, because Chrome throws a `QuotaExceededError`
   * out of `appendBuffer` synchronously. The hook has to see the same shape or it will
   * handle a real site wrongly.
   *
   * Refused bytes are not recorded as buffered, because the browser did not keep them.
   * That is the whole reason the browser's quota is a cause of its own rather than a
   * flavour of ours.
   */
  appendBuffer(data: BufferSource): void {
    if (this.quotaExceeded) {
      throw new DOMException('This buffer is over its quota', FakeSourceBuffer.QUOTA_ERROR)
    }

    const bytes = toBytes(data)
    this.acceptedBytes.push(bytes)

    // One byte counts as one second of buffered range. A real browser derives a duration
    // from the container it is decoding, which no fake can do honestly, and the hook only
    // ever asks how much is buffered rather than when. Keeping the two the same number
    // makes a test's arithmetic the arithmetic on screen.
    //
    // Appends that follow on from each other coalesce into one range, because that is
    // what a browser reports and a hook summing range ends would otherwise count a
    // stream as many separate pieces.
    const from = this.totalBuffered()
    const last = this.ranges[this.ranges.length - 1]
    if (last && last.end === from) last.end = from + bytes.byteLength
    else this.ranges.push({ start: from, end: from + bytes.byteLength })
  }

  /** Drops everything buffered. A player abandoning a stream leaves the buffer empty. */
  abort(): void {
    this.ranges.length = 0
  }

  remove(start: number, end: number): void {
    const kept: { start: number; end: number }[] = []
    for (const range of this.ranges) {
      if (range.end <= start || range.start >= end) {
        kept.push(range)
        continue
      }
      if (range.start < start) kept.push({ start: range.start, end: start })
      if (range.end > end) kept.push({ start: end, end: range.end })
    }
    this.ranges.length = 0
    this.ranges.push(...kept)
  }

  emitEncrypted(): void {
    this.dispatchEvent(new Event('encrypted'))
  }

  append(bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    this.appendBuffer(bytes)
    return Promise.resolve()
  }

  bufferedRanges(): FakeTimeRanges {
    return this.buffered
  }

  accepted(): Uint8Array<ArrayBuffer>[] {
    return [...this.acceptedBytes]
  }

  setQuotaExceeded(exceeded: boolean): void {
    this.quotaExceeded = exceeded
  }

  private totalBuffered(): number {
    return this.ranges.reduce((total, range) => total + (range.end - range.start), 0)
  }
}

/**
 * The `TimeRanges` a buffer hands back.
 *
 * A real one cannot be constructed, and the hook only ever reads `length` and the ends of
 * each range, so an object with those three members is the whole of the surface in use.
 */
function timeRangesOf(ranges: readonly { start: number; end: number }[]): FakeTimeRanges {
  return {
    length: ranges.length,
    start: (index: number) => ranges[index]?.start ?? 0,
    end: (index: number) => ranges[index]?.end ?? 0,
  }
}

function toBytes(data: BufferSource): Uint8Array<ArrayBuffer> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength)
  }
  return new Uint8Array(0)
}

// ─── MediaSource ────────────────────────────────────────────────────────────

/** Test side driver for one MediaSource. Not part of the page's API. */
export interface FakeMediaSourceControl {
  /** Adds a buffer through whatever wraps this method now. */
  addSourceBuffer(mimeType: string, options?: FakeSourceBufferOptions): FakeSourceBuffer
  /** Ends the stream, which is what makes a browser fire `sourceended`. */
  endOfStream(): void
  /** Every buffer added, in order. */
  buffers(): FakeSourceBuffer[]
}

export class FakeMediaSource extends EventTarget implements FakeMediaSourceControl {
  readyState: 'closed' | 'open' | 'ended' = 'closed'

  private readonly added: FakeSourceBuffer[] = []

  /**
   * A real `SourceBufferList`, near enough.
   *
   * A plain array, because the hook reads it by `length` and index on purpose so that
   * this and the browser's own list are read the same way. An array has both.
   */
  get sourceBuffers(): FakeSourceBuffer[] {
    return this.added
  }

  /** Puts the source in the open state a player puts it in before adding a buffer. */
  open(): void {
    this.readyState = 'open'
    this.dispatchEvent(new Event('sourceopen'))
  }

  addSourceBuffer(mimeType: string, options: FakeSourceBufferOptions = {}): FakeSourceBuffer {
    if (this.readyState !== 'open') {
      throw new DOMException('This MediaSource is not open', 'InvalidStateError')
    }

    const buffer = new FakeSourceBuffer(mimeType, options)
    this.added.push(buffer)
    return buffer
  }

  endOfStream(): void {
    this.readyState = 'ended'
    this.dispatchEvent(new Event('sourceended'))
  }

  buffers(): FakeSourceBuffer[] {
    return [...this.added]
  }
}

// ─── Putting them on the page ───────────────────────────────────────────────

export interface FakePageMediaControl {
  /** A MediaSource already in the open state, which is the state a player creates. */
  open(): FakeMediaSource
  /** Puts the constructors back the way they were, so one test cannot reach the next. */
  restore(): void
}

/**
 * Puts `MediaSource` and `SourceBuffer` on the global the page reads.
 *
 * `MediaSource` is a constructor the page calls with `new`, so the properties are writable
 * rather than only definable. The hook patches the prototypes of these classes rather
 * than replacing the constructors, which is what lets a site that captured the real
 * `MediaSource` before the hook was injected still be caught.
 */
export function installFakePageMedia(): FakePageMediaControl {
  const globals = globalThis as Record<string, unknown>
  globals.MediaSource = FakeMediaSource
  globals.SourceBuffer = FakeSourceBuffer

  return {
    open() {
      const source = new FakeMediaSource()
      source.open()
      return source
    },

    restore() {
      delete globals.MediaSource
      delete globals.SourceBuffer
    },
  }
}

// ─── The addresses URL.createObjectURL hands out ────────────────────────────

/** Test side driver for blob addresses. Not part of the page's API. */
export interface FakeBlobUrlsControl {
  /** The address the page was given for an object, or undefined when it has none. */
  urlFor(object: object): string | undefined
  /** The object an address stands for, which is how a test reads a file back. */
  objectFor(address: string): Blob | MediaSource | undefined
  /** Every address that has been revoked. */
  revoked(): string[]
  /** How many addresses have been minted, which is how a test sees the hook's own. */
  minted(): number
  restore(): void
}

/**
 * Records which object each blob address stands for.
 *
 * A `MediaSource` and a `Blob` both become a `blob:` address at `URL.createObjectURL`, and
 * telling them apart is the whole difference between a stream the page is still building
 * and a finished file the page already holds. Deciding it by which hook path happened to
 * see the call would send a `MediaSource` down the blob path, where the type test rejects
 * it and the stream disappears.
 */
export function installFakeBlobUrls(): FakeBlobUrlsControl {
  const nativeCreate = URL.createObjectURL.bind(URL)
  const nativeRevoke = URL.revokeObjectURL.bind(URL)
  const byObject = new Map<string, object>()
  const revoked: string[] = []
  const origin = typeof location === 'undefined' ? 'https://example.com' : location.origin
  let minted = 0
  let sequence = 0

  // A `MediaSource` is handed to `URL.createObjectURL` on every MSE site, and jsdom's own
  // refuses anything that is not a real Blob. So a real Blob goes to the browser's
  // function, which keeps the assembly path honest end to end, and anything else gets a
  // minted address of the same shape. The address is what the hook matches players on, and
  // its shape is all that has to be true.
  const addressFor = (object: Blob | MediaSource): string => {
    if (typeof Blob !== 'undefined' && object instanceof Blob) return nativeCreate(object)
    sequence += 1
    return `blob:${origin}/vortex-fake-${sequence}`
  }

  URL.createObjectURL = (object: Blob | MediaSource): string => {
    const url = addressFor(object)
    minted += 1
    byObject.set(url, object)
    return url
  }

  URL.revokeObjectURL = (url: string): void => {
    revoked.push(url)
    byObject.delete(url)
    // Only the browser's own addresses are handed back to it. A minted one it has never
    // heard of would throw, and a fake must not fail the code under test.
    if (url.includes('/vortex-fake-')) return
    nativeRevoke(url)
  }

  return {
    urlFor: (object) => [...byObject.entries()].find(([, held]) => held === object)?.[0],
    objectFor: (address) => byObject.get(address) as Blob | MediaSource | undefined,
    revoked: () => [...revoked],
    minted: () => minted,
    restore() {
      URL.createObjectURL = nativeCreate
      URL.revokeObjectURL = nativeRevoke
      byObject.clear()
    },
  }
}

// ─── The players on the page ────────────────────────────────────────────────

/** Test side driver for the media elements a page plays through. */
export interface FakeMediaElementsControl {
  /**
   * A player bound to an address, the way a page binds one.
   *
   * `currentSrc` and `duration` are defined on the element because jsdom derives neither:
   * it loads no media, so both stay empty however the element is set up. A stream row is
   * derived from one of them, so a fake that left them alone would make the rule
   * untestable rather than merely untested.
   */
  bind(options: {
    src: string
    duration?: number
    tag?: 'video' | 'audio'
  }): HTMLMediaElement
  /** Takes every player off the page, so one test cannot see another's. */
  restore(): void
}

export function installFakeMediaElements(): FakeMediaElementsControl {
  const created: HTMLMediaElement[] = []

  return {
    bind({ src, duration = 0, tag = 'video' }) {
      const element = document.createElement(tag) as HTMLMediaElement
      // An infinite duration is how a browser reports an endless stream, and it is the one
      // signal that a live broadcast can be read from.
      Object.defineProperty(element, 'currentSrc', { value: src, configurable: true })
      Object.defineProperty(element, 'duration', { value: duration, configurable: true })
      element.setAttribute('src', src)
      // Attached, because the hook finds players by asking the document for them rather
      // than by holding a list, which is the only way it can see a player the site made.
      document.body.append(element)
      created.push(element)
      return element
    },

    restore() {
      for (const element of created) element.remove()
      created.length = 0
    },
  }
}