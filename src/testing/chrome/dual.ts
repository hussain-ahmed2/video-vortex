// The one place that knows a Chrome call can be made two ways.
//
// Every fake call accepts a trailing callback and returns `undefined`, or takes
// no callback and returns a promise. Today's production code is written in the
// callback style and reads `runtime.lastError` afterwards, so a fake that only
// spoke promises would make it hang.

import type { FakeCallback } from './types'

/** Pulls a trailing callback off an argument list. */
export function splitCallback(args: unknown[]): {
  callback: FakeCallback | undefined
  rest: unknown[]
} {
  const last = args[args.length - 1]
  if (typeof last === 'function') {
    return { callback: last as FakeCallback, rest: args.slice(0, -1) }
  }
  return { callback: undefined, rest: args }
}

/** Delivers a result in whichever form the caller asked for. */
export function deliver<R>(
  result: R,
  callback: FakeCallback | undefined
): Promise<R> | undefined {
  if (callback) {
    callback(result as never)
    return undefined
  }
  return Promise.resolve(result)
}

/** The rejection Chrome uses when a message has no receiving end. */
export const NO_RECEIVING_END =
  'Could not establish connection. Receiving end does not exist.'
