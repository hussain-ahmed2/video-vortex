// @vitest-environment jsdom

import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CONTRACT_VERSION } from "./engine/types";

// Spec 0003 requires the popup to honour `prefers-reduced-motion` for `motion/react` as
// well as for CSS, and `motion-safe:` cannot do that: it only gates CSS transitions. The
// only thing that covers the library is `<MotionConfig reducedMotion="user">` around the
// popup, which lives in the entry point and is easy to drop in a refactor without any
// other test noticing.
//
// The entry really mounts and motion really runs. Rows enter with `initial={{ y: 8 }}`,
// so without the config motion writes a translate onto the element. With the config and a
// reduced motion preference it must not. That makes the assertion behavioural rather than
// structural, and it needs no mocking: `motion/react` is externalised by the runner, so
// `vi.mock` cannot intercept it.
//
// covers: AC-8

const NOW = 1_700_000_000_000;

const RECORD = {
  tabId: 1,
  pageUrl: "https://example.com/watch",
  pageTitle: "Documentary Stream",
  status: "ready" as const,
  lastWriter: "network-response",
  updatedAt: NOW,
  hiddenCount: 0,
  seenKeys: [],
  entries: [
    {
      url: "https://cdn.example.com/media/clip.mp4",
      container: "mp4",
      quality: "unknown",
      kind: "video" as const,
      sizeBytes: 48_200_000,
      sources: ["network-response"],
      discoveredAt: NOW,
    },
  ],
};

function stubReducedMotion(): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

/** Every message the popup sent, so a test can read what it actually put on the wire. */
const sentMessages: { name?: string; payload?: { contractVersion?: number } }[] = [];

/** The two calls the popup makes on open, in the promise form it now uses. */
function stubExtensionApi(): void {
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      lastError: undefined,
      onMessage: { addListener: () => {}, removeListener: () => {} },
      sendMessage: (message: { name?: string; payload?: { contractVersion?: number } }) => {
        sentMessages.push(message);
        return Promise.resolve(
          message?.name === "GET_TAB_MEDIA"
            ? { record: RECORD, needsReport: false, status: "ready", inFlight: [] }
            : undefined
        );
      },
    },
    tabs: {
      query: () => Promise.resolve([{ id: 1, url: "https://example.com/watch" }]),
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  sentMessages.length = 0;
  stubReducedMotion();
  stubExtensionApi();
  document.body.innerHTML = '<div id="root"></div>';
});

/**
 * Mounts the real entry point and waits until the popup has rendered what the test is
 * here to look at.
 *
 * The popup asks the browser for the tab and then asks the worker for the record before
 * it has anything to show, so how many turns it takes is the popup's business and not
 * something a test should guess. One turn was not always enough and twenty five were
 * always paid for, which is how this file came to need more than the default five second
 * budget and fail about one run in three under the load of the whole suite. Waiting for
 * the thing being asserted costs a turn or two when nothing is competing, and is not a
 * race when everything is.
 */
async function mountPopup(ready: (text: string) => boolean): Promise<void> {
  await import("./main");

  for (let turn = 0; turn < 60; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (ready(document.body.textContent ?? "")) return;
  }

  throw new Error("the popup never rendered what this test was waiting for");
}

/** The page title reaches the header only once the record has been read. */
const listIsUp = (text: string): boolean => text.includes("Documentary Stream");
/** The footer is static, so its presence means the popup itself has mounted. */
const popupHasMounted = (text: string): boolean => text.includes("leaves your browser");

/** Generous, because this file mounts the real entry and the machine may be busy. */
const MOUNT_TIMEOUT = 30_000;

/**
 * Lets motion finish its first frames.
 *
 * Motion writes a style on the frame a row mounts, so reading the DOM in the same tick
 * as the render can catch a transform that is about to be dropped. The rule being
 * tested is about where the row settles, and waiting for that is also what stops this
 * test going flaky when the whole suite runs at once.
 */
async function settle(): Promise<void> {
  await act(async () => {
    for (let frame = 0; frame < 3; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    }
  });
}

describe("the popup under a reduced motion preference", () => {
  it("mounts the list", async () => {
    await mountPopup(listIsUp);

    expect(document.body.textContent).toContain("Documentary Stream");
  }, MOUNT_TIMEOUT);

  it("applies no transform to a row that is entering, so nothing travels", async () => {
    await mountPopup(listIsUp);
    await settle();

    const rows = [...document.querySelectorAll<HTMLElement>("li")];
    expect(rows.length).toBeGreaterThan(0);

    const transformed = rows.filter((row) => {
      const style = row.style.transform || row.closest<HTMLElement>("[style*='transform']")?.style.transform || "";
      return style !== "" && style !== "none";
    });
    expect(transformed).toEqual([]);
  }, MOUNT_TIMEOUT);

  it("leaves the row's opacity animation alone, so a row still appears", async () => {
    await mountPopup(listIsUp);
    await settle();

    const row = document.querySelector<HTMLElement>("li");
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("mp4");
  }, MOUNT_TIMEOUT);
});

// The version is not in the popup any more: it used to be hardcoded in the footer, which
// is the trap `src/AGENTS.md` warns about, and scope feature 17 owns giving it one source
// of truth. Asserted here so its removal is a decision on the record rather than an
// oversight, and so the footer copy that replaced it stays put.
describe("the popup footer", () => {
  it("states that nothing leaves the browser", async () => {
    await mountPopup(popupHasMounted);

    expect(document.body.textContent).toContain("Nothing you see here leaves your browser");
  }, MOUNT_TIMEOUT);

  it("carries no hardcoded version string", async () => {
    await mountPopup(popupHasMounted);

    expect(document.body.textContent).not.toMatch(/v\d+\.\d+\.\d+/);
  }, MOUNT_TIMEOUT);
});

describe("the contract version the popup sends", () => {
  it("is the one constant in the engine", async () => {
    // Behavioural rather than a pinned literal. Asserting `toBe(1)` would have been
    // the hardcoding this test exists to catch: every bump would have broken a test
    // whose stated purpose was not about the number, and the next bump would have
    // tempted whoever hit it into pasting the new one instead of reading why.
    await mountPopup(popupHasMounted);

    const read = sentMessages.find((message) => message.name === "GET_TAB_MEDIA");
    expect(read?.payload?.contractVersion).toBe(CONTRACT_VERSION);
  }, MOUNT_TIMEOUT);
});
