// Builds one fresh set of fakes and puts it where the extension expects the
// browser to be. The returned object is the handle: a test reaches
// `fake.storage`, `fake.downloads.control` and so on directly.
//
// Tests call this explicitly rather than through a setup file, so a test that
// wants no browser global at all simply never calls it.

import { createFakeAction } from './action'
import { createFakeDownloads } from './downloads'
import { createFakeRuntime } from './runtime'
import { createFakeScripting } from './scripting'
import { createFakeStorage } from './storage'
import { createFakeTabs } from './tabs'
import type { FakeChrome, FakeTab } from './types'
import { createFakeWebRequest } from './web-request'

/**
 * Installs the fakes as the global `chrome` object and returns them.
 *
 * The one cast in the whole fake lives here. `chrome` is a declared namespace of
 * roughly forty sub namespaces and has no value form, so it cannot be assigned
 * to directly and a partial fake can never satisfy it. Assigning through a
 * narrowed global is the smallest honest way to give the production code the
 * global it expects, and it is confined to this one line on purpose.
 */
export function installFakeChrome(tabs: FakeTab[] = []): FakeChrome {
  const runtime = createFakeRuntime()

  const fake: FakeChrome = {
    storage: createFakeStorage(),
    runtime,
    downloads: createFakeDownloads(),
    action: createFakeAction(),
    webRequest: createFakeWebRequest(),
    scripting: createFakeScripting(),
    // A failed tab message is reported through the same `runtime.lastError` the
    // runtime fake owns, rather than through a second error channel of its own.
    tabs: createFakeTabs(tabs, {
      clear: () => {
        runtime.lastError = undefined
      },
      report: (message) => {
        runtime.lastError = { message }
      },
    }),
  }

  const target = globalThis as unknown as { chrome: FakeChrome }
  target.chrome = fake

  return fake
}
