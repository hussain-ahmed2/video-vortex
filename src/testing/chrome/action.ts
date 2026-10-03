// Fakes `chrome.action`: the toolbar badge, which is the only part of this extension
// a person sees when the popup is closed.
//
// The badge count is a claim about what the popup is not showing, so a test has to be
// able to read back exactly what was written. Nothing is asserted about colours here:
// no spec fixes a badge colour, and the design language governs the popup surface.

export interface FakeActionCall {
  method: 'setBadgeText' | 'setBadgeBackgroundColor'
  tabId: number | undefined
  value: string
}

/** Test side reader for the badge. Not part of the API. */
export interface FakeActionControl {
  /** The text last written for a tab, or an empty string when it was cleared. */
  badgeText(tabId: number): string
  /** Every call in order, so a test can assert a badge was never left set. */
  calls(): FakeActionCall[]
  reset(): void
}

export interface FakeAction {
  setBadgeText(details: { tabId?: number; text: string }): unknown
  setBadgeBackgroundColor(details: { color: string }): unknown
  control: FakeActionControl
}

export function createFakeAction(): FakeAction {
  const text = new Map<number, string>()
  const calls: FakeActionCall[] = []

  const control: FakeActionControl = {
    badgeText(tabId) {
      return text.get(tabId) ?? ''
    },
    calls() {
      return [...calls]
    },
    reset() {
      text.clear()
      calls.length = 0
    },
  }

  return {
    control,

    setBadgeText({ tabId, text: value }) {
      calls.push({ method: 'setBadgeText', tabId, value })
      // Chrome keeps the text per tab and treats an empty string as "no badge", so
      // storing it rather than deleting it is what a test reads back as cleared.
      if (tabId !== undefined) text.set(tabId, value)
      return undefined
    },

    setBadgeBackgroundColor({ color }) {
      calls.push({ method: 'setBadgeBackgroundColor', tabId: undefined, value: color })
      return undefined
    },
  }
}
