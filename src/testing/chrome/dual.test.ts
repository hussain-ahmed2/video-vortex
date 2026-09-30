import { describe, expect, it } from 'vitest'
import { deliver, NO_RECEIVING_END, splitCallback } from './dual'
import type { FakeCallback } from './types'

// The callback or promise helper every fake call goes through. Today's
// production code is written in the callback style and reads `runtime.lastError`
// afterwards, so if this helper is wrong every fake built on it is wrong too.

describe('splitCallback', () => {
  it('pulls a trailing function off as the callback', () => {
    // covers: AC-3
    const callback = (() => {}) as FakeCallback
    const { callback: found, rest } = splitCallback(['a', 1, callback])

    expect(found).toBe(callback)
    expect(rest).toEqual(['a', 1])
  })

  it('leaves every argument in rest when the last one is not a function', () => {
    const { callback, rest } = splitCallback(['a', 1])

    expect(callback).toBeUndefined()
    expect(rest).toEqual(['a', 1])
  })

  it('handles being called with no arguments at all', () => {
    // The `get()` with no key case in the storage fake reaches here.
    const { callback, rest } = splitCallback([])

    expect(callback).toBeUndefined()
    expect(rest).toEqual([])
  })

  it('treats a function that is not last as an ordinary argument', () => {
    const notTheCallback = (() => {}) as FakeCallback
    const { callback, rest } = splitCallback([notTheCallback, 'key'])

    expect(callback).toBeUndefined()
    expect(rest).toHaveLength(2)
  })
})

describe('deliver', () => {
  it('calls the callback and returns undefined when a callback was given', () => {
    // covers: AC-3
    const received: unknown[] = []
    const callback = ((value: unknown) => {
      received.push(value)
    }) as FakeCallback

    const returned = deliver('value', callback)

    expect(returned).toBeUndefined()
    expect(received).toEqual(['value'])
  })

  it('resolves a promise and calls nothing when no callback was given', async () => {
    expect(await deliver('value', undefined)).toBe('value')
  })

  it('resolves undefined rather than throwing, so a void call is safe', async () => {
    expect(await deliver(undefined, undefined)).toBeUndefined()
  })
})

describe('the no receiving end message', () => {
  it('is the exact wording Chrome uses', () => {
    // Production code cannot branch on this string, but a test can, and a test
    // that drifts from Chrome is worse than no constant at all.
    expect(NO_RECEIVING_END).toBe(
      'Could not establish connection. Receiving end does not exist.'
    )
  })
})
