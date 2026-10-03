// Fakes `chrome.scripting`: injecting a file onto a tab on demand, in either world.
//
// Injection failing is a real outcome, not an edge case: it is how the read path learns
// that a tab cannot host a content script, which is the difference between saying "this
// page cannot be watched" and showing an empty list on a page that is playing something.
//
// The world is recorded because this extension injects into two of them and the difference
// is the whole of the stream feature. A content script runs isolated from the page and
// cannot read the page's own variables; the page hook runs in the page's world, shares
// `window` with the site, and is the only place a `SourceBuffer` can be copied from. An
// injection recorded without its world would make those two indistinguishable in a test.

export interface FakeScriptingCall {
  tabId: number
  files: string[]
  /** Absent when the caller did not ask for one, which is what an isolated injection is. */
  world?: 'MAIN' | 'ISOLATED'
}

/** Test side driver for injection. Not part of the API. */
export interface FakeScriptingControl {
  /**
   * Makes injections reject, as Chrome does on a blocked page.
   *
   * `files` narrows the failure to named ones, because a page can refuse one file and not
   * another and this extension treats the two worlds differently: a refused content script
   * means the page cannot be watched, while a refused hook only means streams are not.
   */
  setInjectionFails(fails: boolean, files?: string[]): void
  /** Every injection attempted, in order. */
  calls(): FakeScriptingCall[]
}

export interface FakeScripting {
  executeScript(injection: {
    target: { tabId: number }
    files?: string[]
    world?: 'MAIN' | 'ISOLATED'
  }): Promise<unknown>
  control: FakeScriptingControl
}

/** Chrome's own wording, so a test that asserts on it is asserting the real thing. */
export const INJECTION_FAILED =
  'Cannot access contents of the page. Extension manifest must request permission to access the respective host.'

export function createFakeScripting(): FakeScripting {
  const calls: FakeScriptingCall[] = []
  let fails = false
  let onlyThese: string[] | undefined

  return {
    control: {
      setInjectionFails(next, files) {
        fails = next
        onlyThese = files
      },
      calls() {
        return [...calls]
      },
    },

    executeScript({ target, files: requested = [], world }) {
      calls.push({
        tabId: target.tabId,
        files: [...requested],
        ...(world ? { world } : {}),
      })

      const refused =
        fails && (!onlyThese || requested.some((file) => onlyThese?.includes(file)))
      return refused ? Promise.reject(new Error(INJECTION_FAILED)) : Promise.resolve([])
    },
  }
}
