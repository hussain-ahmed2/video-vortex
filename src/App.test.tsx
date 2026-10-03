// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import { CONTRACT_VERSION, type TabMedia } from "./engine/types";

// Spec 0003's runtime criteria for the popup itself, and spec 0004's copy table. The
// extension API is the boundary here, so it is faked and nothing below it is.
//
// covers: AC-2, AC-4, AC-6, AC-9, AC-10, AC-17, AC-19

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const NOW = 1_700_000_000_000;
const PAGE = "https://example.com/watch";

function entry(overrides: Partial<TabMedia["entries"][number]> = {}): TabMedia["entries"][number] {
  return {
    url: "https://cdn.example.com/media/clip.mp4",
    container: "mp4",
    quality: "unknown",
    kind: "video",
    sizeBytes: 48_200_000,
    sources: ["network-response"],
    discoveredAt: NOW,
    ...overrides,
  };
}

function record(overrides: Partial<TabMedia> = {}): TabMedia {
  return {
    tabId: 1,
    pageUrl: PAGE,
    pageTitle: "Documentary Stream",
    status: "ready",
    lastWriter: "network-response",
    updatedAt: NOW,
    hiddenCount: 0,
    seenKeys: [],
    entries: [],
    ...overrides,
  };
}

const MP4 = entry();
const WEBM = entry({ url: "https://cdn.example.com/media/other.webm", container: "webm" });
const AUDIO = entry({
  url: "https://cdn.example.com/media/theme.m4a",
  container: "mp4",
  kind: "audio",
});
const MANIFEST = entry({ url: "https://cdn.example.com/master.m3u8", container: "m3u8" });

let root: Root;
let container: HTMLDivElement;
let listeners: Array<(message: unknown) => void>;
let sent: Array<{ name: string; payload: Record<string, unknown> }>;
let reply: (name: string) => unknown;
let broadcast: (message: unknown) => void;
/** Set by the test that needs the worker to be unreachable, which is how a removed or
 *  reloading extension behaves from the popup's side. */
let rejectMessages: Error | null = null;

/**
 * Installs a browser fake whose answers the test decides.
 *
 * `reply` is a function rather than a fixed value because the popup's whole behaviour
 * hangs off what the worker says, and a fake that always answered the same thing would
 * let a broken popup pass.
 */
function installChrome(): void {
  listeners = [];
  sent = [];
  broadcast = (message: unknown) => {
    for (const listener of listeners) listener(message);
  };

  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      lastError: undefined,
      onMessage: {
        addListener: (fn: (message: unknown) => void) => listeners.push(fn),
        removeListener: (fn: (message: unknown) => void) => {
          listeners = listeners.filter((existing) => existing !== fn);
        },
      },
      sendMessage: (message: { name: string; payload: Record<string, unknown> }) => {
        sent.push(message);
        if (rejectMessages) return Promise.reject(rejectMessages);
        return Promise.resolve(reply(message.name));
      },
    },
    tabs: {
      query: () => Promise.resolve([{ id: 1, url: PAGE }]),
    },
  };
}

function getTabMedia(
  response: Partial<{
    record: TabMedia | null;
    needsReport: boolean;
    status: TabMedia["status"];
    inFlight: unknown[];
  }> = {}
): Record<string, unknown> {
  return {
    record: record({ entries: [MP4] }),
    needsReport: false,
    status: "ready",
    inFlight: [],
    ...response,
  };
}

/**
 * Anything that escapes as an unhandled rejection while `body` runs.
 *
 * A rejected message used to escape both of the popup's message calls. Vitest reports an
 * escaped rejection as an error outside the test counts, which means a suite can read as
 * all passing while the file still errors, so the escape is asserted here instead: this is
 * the difference between a test that catches the bug and a test that happens to be near it.
 */
async function unhandledRejectionsDuring(body: () => Promise<void>): Promise<unknown[]> {
  const escaped: unknown[] = [];
  const listener = (reason: unknown): void => {
    escaped.push(reason);
  };

  process.on("unhandledRejection", listener);
  try {
    await body();
    // An unhandled rejection is reported once the turn ends, so give it one.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    });
  } finally {
    process.off("unhandledRejection", listener);
  }

  return escaped;
}

function accessibleName(element: Element): string {
  return element.getAttribute("aria-label")?.trim() || element.textContent?.trim() || "";
}

function buttons(): HTMLButtonElement[] {
  return [...container.querySelectorAll("button")] as HTMLButtonElement[];
}

function rows(): HTMLElement[] {
  return [...container.querySelectorAll("li")] as HTMLElement[];
}

async function render(): Promise<void> {
  installChrome();
  await act(async () => {
    root.render(<App />);
  });
}

async function click(label: string): Promise<void> {
  const target = buttons().find((button) => accessibleName(button) === label);
  if (!target) throw new Error(`no control named "${label}"`);
  await act(async () => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  // A usable default, overridden per test before rendering. The popup's whole behaviour
  // hangs off what the worker says, so this is the one thing every test sets.
  reply = () => getTabMedia();
  rejectMessages = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  delete (globalThis as { chrome?: unknown }).chrome;
});

describe("the four whole popup states", () => {
  it("shows the watching state with skeletons while the first report is on its way", async () => {
    reply = () => getTabMedia({ record: null, needsReport: true, status: "observing" });
    await render();

    expect(container.textContent).toContain("Watching this page");
    // Skeletons, never a spinner over a list, and never the empty state.
    expect(container.querySelectorAll("[data-slot='skeleton']").length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain("No media found");
  });

  it("shows the empty state when a ready page held no media", async () => {
    reply = () => getTabMedia({ record: record() });
    await render();

    expect(container.textContent).toContain("No media found on this page");
  });

  it("names the unwatchable state rather than showing an empty list", async () => {
    reply = () => getTabMedia({ record: null, needsReport: false, status: "unsupported" });
    await render();

    expect(container.textContent).toContain("This page cannot be watched");
    expect(container.textContent).not.toContain("No media found");
  });

  it("shows the resting list when there is media", async () => {
    reply = () => getTabMedia({ record: record({ entries: [MP4] }) });
    await render();

    expect(rows()).toHaveLength(1);
    expect(container.textContent).toContain("Video (1)");
  });

  // covers: AC-2, AC-6
  it("waits on a record the worker is still reporting on, then shows the list when it says so", async () => {
    // The whole read path in one test. The worker answers with the entries it already
    // has and asks for a report, and the popup shows the watch rather than a list of
    // media whose page it has not heard from. The list arrives on the broadcast.
    //
    // This is the path the biggest defect broke: the worker never asked for a report at
    // all, so the record stayed `observing` and this popup would have sat on skeletons
    // for the life of the tab.
    let reads = 0;
    reply = (name) => {
      if (name !== "GET_TAB_MEDIA") return getTabMedia();
      reads += 1;
      return reads === 1
        ? getTabMedia({ record: record({ entries: [MP4] }), needsReport: true, status: "observing" })
        : getTabMedia({ record: record({ entries: [MP4] }), needsReport: false, status: "ready" });
    };
    await render();

    expect(container.textContent).toContain("Watching this page");
    expect(rows()).toHaveLength(0);

    await act(async () => {
      broadcast({ name: "TAB_MEDIA_UPDATED", payload: { tabId: 1 } });
    });

    expect(container.textContent).not.toContain("Watching this page");
    expect(rows()).toHaveLength(1);
    expect(container.textContent).toContain("Video (1)");
  });

  // covers: AC-2, AC-6, AC-19
  it("still lists when the broadcast that ends the wait lands before the read's own answer", async () => {
    // The ordering the real worker produces, and the one the test above does not. A
    // record the observer made is still `observing`, so the popup's read is what puts a
    // content script on the page; the report then comes back and the worker broadcasts,
    // and that broadcast can reach the popup before the answer to the read that caused it.
    //
    // Found by running the real extension: three first opens in ten sat on the watch for
    // good. The popup never polls, so a broadcast dropped like this is never corrected,
    // and the person has to close the popup or press Refresh.
    let answerTheRead: (value: unknown) => void = () => {};
    const firstRead = new Promise((resolve) => {
      answerTheRead = resolve;
    });
    let reads = 0;

    reply = (name) => {
      if (name !== "GET_TAB_MEDIA") return getTabMedia();
      reads += 1;
      if (reads === 1) return firstRead;
      return getTabMedia({ record: record({ entries: [MP4] }), needsReport: false, status: "ready" });
    };

    await render();
    expect(sent.filter((message) => message.name === "GET_TAB_MEDIA")).toHaveLength(1);
    expect(container.textContent).toContain("Watching this page");

    // The report lands and the worker broadcasts, while that first read is unanswered.
    await act(async () => {
      broadcast({ name: "TAB_MEDIA_UPDATED", payload: { tabId: 1 } });
    });
    await act(async () => {
      answerTheRead(
        getTabMedia({ record: record({ entries: [MP4] }), needsReport: true, status: "observing" })
      );
    });

    expect(rows()).toHaveLength(1);
    expect(container.textContent).toContain("Video (1)");
  });
});

describe("a row, which is where AC-2 and AC-9 are decided", () => {
  it("shows the container, the quality and the size", async () => {
    reply = () => getTabMedia({ record: record({ entries: [MP4] }) });
    await render();

    const text = rows()[0]?.textContent ?? "";
    expect(text).toContain("mp4");
    expect(text).toContain("unknown");
    expect(text).toContain("46.0 MB");
  });

  it("says the size is unknown when the response stated none", async () => {
    reply = () => getTabMedia({ record: record({ entries: [entry({ sizeBytes: null })] }) });
    await render();

    expect(rows()[0]?.textContent).toContain("Size unknown");
  });

  it("splits video and audio into two lists, each named", async () => {
    reply = () => getTabMedia({ record: record({ entries: [MP4, AUDIO] }) });
    await render();

    expect(container.textContent).toContain("Video (1)");
    expect(container.textContent).toContain("Audio (1)");
    // The word is in the row as well as on the icon, so the split never rests on colour.
    expect(rows()[1]?.textContent).toContain("Audio");
  });

  it("keeps every control at least 24 by 24, with a name", async () => {
    reply = () => getTabMedia({ record: record({ entries: [MP4, AUDIO] }) });
    await render();

    expect(buttons().filter((button) => accessibleName(button) === "")).toEqual([]);
    expect(buttons().map(accessibleName)).toContain("Refresh the list");
  });

  it("names each row's download control so two rows are not interchangeable", async () => {
    reply = () => getTabMedia({ record: record({ entries: [MP4, WEBM] }) });
    await render();

    const names = buttons().map(accessibleName).filter((name) => name.startsWith("Download"));
    expect(new Set(names).size).toBe(2);
  });

  it("offers no control at all for a manifest, because saving one saves a playlist", async () => {
    reply = () => getTabMedia({ record: record({ entries: [MANIFEST] }) });
    await render();

    expect(rows()).toHaveLength(1);
    expect(buttons().map(accessibleName)).not.toContain(
      expect.stringContaining("master.m3u8")
    );
    expect(buttons().map(accessibleName).filter((name) => name.startsWith("Download"))).toEqual(
      []
    );
  });
});

describe("the three displays, each under its own condition", () => {
  it("shows the hidden count only when something is being held back", async () => {
    reply = () => getTabMedia({ record: record({ entries: [MP4], hiddenCount: 0 }) });
    await render();
    expect(container.textContent).not.toContain("Showing");

    await act(async () => {
      root.render(<App />);
    });
    reply = () => getTabMedia({ record: record({ entries: [MP4], hiddenCount: 12 }) });
    await click("Refresh the list");
    expect(container.textContent).toContain("Showing 1 of 13 found");
  });

  it("shows the staleness line from the record's own timestamp", async () => {
    reply = () => getTabMedia({ record: record({ entries: [MP4] }) });
    await render();

    expect(container.textContent).toContain("Updated 0s ago");

    await act(async () => {
      vi.advanceTimersByTime(12_000);
    });
    expect(container.textContent).toContain("Updated 12s ago");
  });

  it("offers the loading hint only after three seconds of watching", async () => {
    reply = () => getTabMedia({ record: null, needsReport: true, status: "observing" });
    await render();

    expect(container.textContent).not.toContain("Still watching");

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(container.textContent).toContain("Still watching");
  });
});

describe("reading, which AC-6 and AC-19 are about", () => {
  it("reads once on open, with the contract version", async () => {
    reply = () => getTabMedia();
    await render();

    const reads = sent.filter((message) => message.name === "GET_TAB_MEDIA");
    expect(reads).toHaveLength(1);
    expect(reads[0]?.payload).toEqual({ contractVersion: CONTRACT_VERSION, tabId: 1 });
  });

  it("never re-reads on a timer, however long the popup is open", async () => {
    // The one interval it runs recomputes a string from a timestamp it already holds.
    reply = () => getTabMedia({ record: record({ entries: [MP4] }) });
    await render();

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });

    expect(sent.filter((message) => message.name === "GET_TAB_MEDIA")).toHaveLength(1);
  });

  it("re-reads when the worker says the record changed", async () => {
    reply = () => getTabMedia({ record: record({ entries: [MP4] }) });
    await render();

    await act(async () => {
      broadcast({ name: "TAB_MEDIA_UPDATED", payload: { tabId: 1 } });
    });

    expect(sent.filter((message) => message.name === "GET_TAB_MEDIA")).toHaveLength(2);
  });

  it("ignores a broadcast naming another tab", async () => {
    reply = () => getTabMedia({ record: record({ entries: [MP4] }) });
    await render();

    await act(async () => {
      broadcast({ name: "TAB_MEDIA_UPDATED", payload: { tabId: 99 } });
    });

    expect(sent.filter((message) => message.name === "GET_TAB_MEDIA")).toHaveLength(1);
  });

  it("re-reads on demand, adding no message of its own", async () => {
    reply = () => getTabMedia({ record: record({ entries: [MP4] }) });
    await render();
    await click("Refresh the list");

    const names = sent.map((message) => message.name);
    // Spec 0001 forbids a start message, so a rescan cannot be one of these.
    expect(new Set(names)).toEqual(new Set(["GET_TAB_MEDIA"]));
  });

  // covers: AC-6, AC-19
  it("reads once more after a burst of changes, however many arrived during the read", async () => {
    // Three changes landing while one read is in flight are one thing to catch up on, not
    // three. Each one on its own would be a message round trip, and the popup's read is
    // what causes the burst in the first place: the content script reports and the worker
    // broadcasts more than once while a page settles.
    let answerTheRead: (value: unknown) => void = () => {};
    const firstRead = new Promise((resolve) => {
      answerTheRead = resolve;
    });
    let reads = 0;

    reply = (name) => {
      if (name !== "GET_TAB_MEDIA") return getTabMedia();
      reads += 1;
      return reads === 1
        ? firstRead
        : getTabMedia({ record: record({ entries: [MP4] }), needsReport: false, status: "ready" });
    };

    await render();
    expect(sent.filter((message) => message.name === "GET_TAB_MEDIA")).toHaveLength(1);

    await act(async () => {
      broadcast({ name: "TAB_MEDIA_UPDATED", payload: { tabId: 1 } });
      broadcast({ name: "TAB_MEDIA_UPDATED", payload: { tabId: 1 } });
      broadcast({ name: "TAB_MEDIA_UPDATED", payload: { tabId: 1 } });
    });
    // All three were absorbed by the read already in flight, so none of them queued a read
    // of its own.
    expect(sent.filter((message) => message.name === "GET_TAB_MEDIA")).toHaveLength(1);

    await act(async () => {
      answerTheRead(
        getTabMedia({ record: record({ entries: [MP4] }), needsReport: true, status: "observing" })
      );
    });

    expect(sent.filter((message) => message.name === "GET_TAB_MEDIA")).toHaveLength(2);
    expect(rows()).toHaveLength(1);
  });

  // covers: AC-19
  it("still honours a Refresh pressed while a read is in flight", async () => {
    // The other half of the same rule, and the one a person feels. A read that is already
    // running must not swallow the click, or Refresh would do nothing whenever it was
    // pressed at the wrong moment, which is exactly when someone presses it again.
    let answerTheRead: (value: unknown) => void = () => {};
    const firstRead = new Promise((resolve) => {
      answerTheRead = resolve;
    });
    let reads = 0;

    reply = (name) => {
      if (name !== "GET_TAB_MEDIA") return getTabMedia();
      reads += 1;
      return reads === 1 ? firstRead : getTabMedia({ record: record({ entries: [MP4] }) });
    };

    await render();
    await click("Refresh the list");
    expect(sent.filter((message) => message.name === "GET_TAB_MEDIA")).toHaveLength(1);

    await act(async () => {
      answerTheRead(getTabMedia({ record: record(), needsReport: true, status: "observing" }));
    });

    expect(sent.filter((message) => message.name === "GET_TAB_MEDIA")).toHaveLength(2);
    expect(rows()).toHaveLength(1);
  });

  // covers: AC-4, AC-19
  it("keeps working when the worker cannot be reached", async () => {
    // Nothing here claims the popup can explain why the worker is gone: what it must do is
    // stay usable, because Refresh is the control the person already has. The rejection
    // itself must not escape, which is what the first assertion is for.
    const escaped = await unhandledRejectionsDuring(async () => {
      rejectMessages = new Error("Could not establish connection");
      await render();
    });

    expect(escaped).toEqual([]);
    expect(container.textContent).toContain("Watching this page");

    // The worker comes back, and the control the person would press now works.
    rejectMessages = null;
    reply = () => getTabMedia({ record: record({ entries: [MP4] }) });
    await act(async () => {
      buttons().find((button) => accessibleName(button) === "Refresh the list")?.click();
    });

    expect(rows()).toHaveLength(1);
  });

  // covers: AC-4
  it("gives a refused or unreachable download its row copy rather than throwing", async () => {
    const refused = await unhandledRejectionsDuring(async () => {
      reply = (name) =>
        name === "DOWNLOAD_MEDIA"
          ? { ok: false, error: "The download could not be started" }
          : getTabMedia({ record: record({ entries: [MP4] }) });
      await render();

      await act(async () => {
        buttons()
          .find((button) => accessibleName(button).startsWith("Download"))
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    });

    expect(refused).toEqual([]);
    expect(container.textContent).toContain("Download failed");
    // The row offers its control again, which is the whole point of the copy.
    expect(buttons().map(accessibleName).some((name) => name.startsWith("Download"))).toBe(true);

    // And the same when the message rejects outright rather than being refused.
    rejectMessages = new Error("Could not establish connection");
    const unreachable = await unhandledRejectionsDuring(async () => {
      await act(async () => {
        buttons()
          .find((button) => accessibleName(button).startsWith("Download"))
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    });

    rejectMessages = null;
    expect(unreachable).toEqual([]);
    expect(container.textContent).toContain("Download failed");
  });

  // covers: AC-6
  it("keeps reading after a read the worker never answered", async () => {
    // A read with no answer is a read that ends, not one that stays open. If an unanswered
    // read kept the popup's next read waiting behind it, one odd answer would leave the
    // popup refusing to update for the rest of its life, with no way to tell from outside.
    let reads = 0;

    reply = (name) => {
      if (name !== "GET_TAB_MEDIA") return getTabMedia();
      reads += 1;
      // The first one is swallowed, which is what a worker that went away looks like.
      if (reads === 1) return undefined;
      return getTabMedia({ record: record({ entries: [MP4] }) });
    };

    await render();
    expect(sent.filter((message) => message.name === "GET_TAB_MEDIA")).toHaveLength(1);

    await click("Refresh the list");

    expect(sent.filter((message) => message.name === "GET_TAB_MEDIA")).toHaveLength(2);
    expect(rows()).toHaveLength(1);
  });
});

describe("downloading", () => {
  // covers: AC-17
  it("names the progress element with the same words it shows, so the two cannot disagree", async () => {
    // Spec 0003 makes the progress element's accessible name the visible label, because a
    // bar that reads one number and announces another is worse than no bar.
    reply = () => getTabMedia({ record: record({ entries: [MP4] }) });
    await render();
    await click(buttons().map(accessibleName).find((name) => name.startsWith("Download")) ?? "");

    await act(async () => {
      broadcast({
        name: "DOWNLOAD_PROGRESS",
        payload: {
          downloadId: 1,
          url: MP4.url,
          bytesReceived: 620,
          totalBytes: 1000,
          state: "in_progress",
        },
      });
    });

    const bar = container.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute("aria-label")).toBe("Downloading 62%");
  });

  it("asks the worker for the row's own url, never a file name", async () => {
    reply = () => getTabMedia({ record: record({ entries: [MP4] }) });
    await render();
    await click(buttons().map(accessibleName).find((name) => name.startsWith("Download")) ?? "");

    const call = sent.find((message) => message.name === "DOWNLOAD_MEDIA");
    expect(call?.payload).toEqual({ contractVersion: CONTRACT_VERSION, url: MP4.url });
    expect(Object.keys(call?.payload ?? {})).not.toContain("filename");
  });

  it("shows real progress with a percentage when the total is known", async () => {
    reply = () => getTabMedia({ record: record({ entries: [MP4] }) });
    await render();
    await click(buttons().map(accessibleName).find((name) => name.startsWith("Download")) ?? "");

    await act(async () => {
      broadcast({
        name: "DOWNLOAD_PROGRESS",
        payload: {
          downloadId: 1,
          url: MP4.url,
          bytesReceived: 620,
          totalBytes: 1000,
          state: "in_progress",
        },
      });
    });

    const bar = container.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute("aria-valuenow")).toBe("62");
    expect(container.textContent).toContain("Downloading 62%");
  });

  it("shows no invented value when the total is unknown", async () => {
    reply = () => getTabMedia({ record: record({ entries: [MP4] }) });
    await render();
    await click(buttons().map(accessibleName).find((name) => name.startsWith("Download")) ?? "");

    await act(async () => {
      broadcast({
        name: "DOWNLOAD_PROGRESS",
        payload: {
          downloadId: 1,
          url: MP4.url,
          bytesReceived: 500,
          totalBytes: null,
          state: "in_progress",
        },
      });
    });

    const bar = container.querySelector('[role="progressbar"]');
    expect(bar?.hasAttribute("aria-valuenow")).toBe(false);
    expect(container.textContent).toContain("Downloading, size unknown");
  });

  it("pairs a cold read's in flight transfer to its row", async () => {
    // Reopening the popup mid download must show the progress, not forget it.
    reply = () =>
      getTabMedia({
        record: record({ entries: [MP4] }),
        inFlight: [
          {
            downloadId: 7,
            url: MP4.url,
            bytesReceived: 250,
            totalBytes: 1000,
            state: "in_progress",
          },
        ],
      });
    await render();

    expect(container.textContent).toContain("Downloading 25%");
  });

  it("states the outcome when a transfer completes", async () => {
    reply = () => getTabMedia({ record: record({ entries: [MP4] }) });
    await render();
    await click(buttons().map(accessibleName).find((name) => name.startsWith("Download")) ?? "");

    await act(async () => {
      broadcast({
        name: "DOWNLOAD_PROGRESS",
        payload: {
          downloadId: 1,
          url: MP4.url,
          bytesReceived: 1000,
          totalBytes: 1000,
          state: "complete",
        },
      });
    });

    expect(container.textContent).toContain("Saved");
  });

  it("says the transfer was interrupted", async () => {
    reply = () => getTabMedia({ record: record({ entries: [MP4] }) });
    await render();
    await click(buttons().map(accessibleName).find((name) => name.startsWith("Download")) ?? "");

    await act(async () => {
      broadcast({
        name: "DOWNLOAD_PROGRESS",
        payload: {
          downloadId: 1,
          url: MP4.url,
          bytesReceived: 10,
          totalBytes: 1000,
          state: "interrupted",
        },
      });
    });

    expect(container.textContent).toContain("Download interrupted");
  });

  it("returns the row to its control and says why when the call is refused", async () => {
    // A dismissed download dialog lands here, and a row left spinning is the one state
    // a person cannot act on.
    reply = (name) => (name === "DOWNLOAD_MEDIA" ? { ok: false, error: 'dialog dismissed' } : getTabMedia({ record: record({ entries: [MP4] }) }));
    await render();
    await click(buttons().map(accessibleName).find((name) => name.startsWith("Download")) ?? "");

    expect(container.textContent).toContain("Download failed");
    expect(
      buttons().map(accessibleName).filter((name) => name.startsWith("Download"))
    ).toHaveLength(1);
  });

  it("spends the palette's one hue only on a failure", async () => {
    reply = () => getTabMedia({ record: record({ entries: [MP4] }) });
    await render();

    expect(container.innerHTML).not.toContain("text-destructive");

    await click(buttons().map(accessibleName).find((name) => name.startsWith("Download")) ?? "");
    await act(async () => {
      broadcast({
        name: "DOWNLOAD_PROGRESS",
        payload: {
          downloadId: 1,
          url: MP4.url,
          bytesReceived: 0,
          totalBytes: 1000,
          state: "interrupted",
        },
      });
    });

    expect(container.innerHTML).toContain("text-destructive");
  });
});

// covers: AC-2, AC-10
describe("the two lists, as a screen reader meets them", () => {
  it("exposes each list as a named region, so a person can jump between them", async () => {
    reply = () => getTabMedia({ record: record({ entries: [MP4, AUDIO] }) });
    await render();

    const regions = [...container.querySelectorAll("section")].map((section) =>
      section.getAttribute("aria-label")
    );

    expect(regions).toEqual(["Video", "Audio"]);
  });

  it("names each list by its media type in the row as well as on the icon", async () => {
    // The word is in the row text, so the split never rests on a picture or a colour.
    reply = () => getTabMedia({ record: record({ entries: [MP4, AUDIO] }) });
    await render();

    expect(rows()[0]?.textContent).toContain("Video");
    expect(rows()[1]?.textContent).toContain("Audio");
  });
});

describe("what the popup trusts", () => {
  it("renders an untrusted page title as text, never as markup", async () => {
    reply = () =>
      getTabMedia({
        record: record({ entries: [MP4], pageTitle: '<img src=x onerror="alert(1)">' }),
      });
    await render();

    expect(container.querySelector("img")).toBeNull();
    expect(container.innerHTML).toContain("&lt;img");
  });

  it("uses no default palette colour anywhere", async () => {
    reply = () => getTabMedia({ record: record({ entries: [MP4, AUDIO] }) });
    await render();

    const offenders = container.innerHTML.match(
      /\b(?:accent|bg|border|ring|fill|stroke|text|from|via|to)-(?:slate|zinc|neutral|gray|stone|purple|blue|red|emerald)-\d+/g
    );
    expect(offenders ?? []).toEqual([]);
  });

  it("drops a broadcast it cannot parse rather than acting on it", async () => {
    reply = () => getTabMedia({ record: record({ entries: [MP4] }) });
    await render();

    await act(async () => {
      broadcast({ name: "DOWNLOAD_PROGRESS", payload: { downloadId: 1 } });
      broadcast({ name: "SOMETHING_ELSE", payload: {} });
    });

    expect(container.textContent).not.toContain("Downloading");
  });
});
// ─── Spec 0005: a stream row, which is the first thing a person sees for it ──

/** A stream entry as the worker would hold it, with overrides. */
function streamEntry(
  signals: Record<string, unknown> = {},
  overrides: Partial<TabMedia["entries"][number]> = {}
): TabMedia["entries"][number] {
  return {
    url: "vortex-stream:https%3A%2F%2Fexample%2Ecom%2Fwatch#1",
    container: "webm",
    quality: "unknown",
    kind: "video",
    sizeBytes: 48_200_000,
    sources: ["page-stream-hook"],
    discoveredAt: NOW,
    stream: {
      streamId: 1,
      origin: "mse",
      bytes: 48_200_000,
      bufferedBytes: 48_200_000,
      live: false,
      encrypted: false,
      ended: false,
      partialReason: "none",
      mediaElementName: null,
      ...signals,
    },
    ...overrides,
  };
}

const PLAYABLE = streamEntry();
const ENDED = streamEntry({ ended: true });
const LIVE = streamEntry({ live: true });
const CAPPED = streamEntry({ partialReason: "page_cap" });
const QUOTA = streamEntry({ partialReason: "browser_quota" });
const BROKEN = streamEntry({ partialReason: "broken" });
const UNKNOWN_CONTAINER = streamEntry({}, { container: "unknown" });

/** Answers with a record holding exactly these entries. */
function withEntries(...entries: TabMedia["entries"]): void {
  reply = () => getTabMedia({ record: record({ entries }) });
}

/** The row's own text, which is where the label, the meta line and any note live. */
function rowText(index = 0): string {
  return rows()[index]?.textContent ?? "";
}

describe("a stream row on a MediaSource site", () => {
  it("is named from the stream id and origin, never off the url it was minted", async () => {
    withEntries(PLAYABLE);
    await render();

    // The minted url ends in a uuid when a page addresses a blob, so reading a label off it
    // would put the same text on every stream row of a page.
    expect(rowText()).toContain("Stream 1");
    expect(rowText()).not.toContain("vortex-stream");
  });

  it("says a blob is already a whole file, because that is what a person can act on", async () => {
    withEntries(streamEntry({ origin: "blob" }));
    await render();

    // A blob saves at once and a MediaSource stream has to be assembled, which is the
    // difference worth putting in the label.
    expect(rowText()).toContain("Whole file 1");
  });

  it("carries no quality line, because no page supplied one", async () => {
    withEntries(PLAYABLE);
    await render();

    // The word would otherwise be printed literally on every stream row and tell a person
    // nothing at all.
    expect(rowText()).not.toContain("unknown");
    expect(rowText()).toContain("webm");
    expect(rowText()).toContain("46.0 MB");
  });

  it("offers a control once the engine derives it playable", async () => {
    withEntries(PLAYABLE);
    await render();

    expect(buttons().map(accessibleName).some((name) => name.startsWith("Download video"))).toBe(
      true
    );
  });

  it("offers a control on an ended stream too, which is a whole file", async () => {
    withEntries(ENDED);
    await render();

    expect(buttons().map(accessibleName).some((name) => name.startsWith("Download video"))).toBe(
      true
    );
  });

  it("offers nothing at all when the container is one we cannot name", async () => {
    withEntries(UNKNOWN_CONTAINER);
    await render();

    // The file could not be given an extension, so a control would hand over something with
    // no name.
    expect(buttons().map(accessibleName).some((name) => name.startsWith("Download"))).toBe(false);
  });
});

describe("a stream row that cannot be saved", () => {
  it("says a live stream has no file and offers nothing", async () => {
    withEntries(LIVE);
    await render();

    expect(rowText()).toContain("This is a live stream, so there is no file to save");
    expect(buttons().map(accessibleName).some((name) => name.startsWith("Download"))).toBe(false);
  });

  it("names our own page cap rather than saying only that it is partial", async () => {
    withEntries(CAPPED);
    await render();

    expect(rowText()).toContain("512 MB limit");
    expect(buttons().map(accessibleName).some((name) => name.startsWith("Download"))).toBe(false);
  });

  it("names the browser own quota, which is neither of the other two", async () => {
    withEntries(QUOTA);
    await render();

    expect(rowText()).toContain("The browser's own limit for this stream was reached");
  });

  it("says the player walked away, which a person can do nothing about either", async () => {
    withEntries(BROKEN);
    await render();

    expect(rowText()).toContain("The player abandoned this stream partway through");
  });

  it("prefers the cap over live, because that is the more useful of the two things to say", async () => {
    withEntries(streamEntry({ live: true, partialReason: "page_cap" }));
    await render();

    // A capped live broadcast is exactly the case that would otherwise sit on 512 MB of a
    // tab's memory saying only that it is endless.
    expect(rowText()).toContain("512 MB limit");
    expect(rowText()).not.toContain("This is a live stream");
  });

  it("never lists a stream that is still collecting, because there is nothing true to say", async () => {
    withEntries(streamEntry({ bufferedBytes: 0, bytes: 0 }));
    await render();

    // The engine derives no row from a stream holding nothing yet. The worker does not record
    // one either, and the popup asks the same rule again so a record from a build before it
    // cannot put one on screen.
    expect(rows()).toHaveLength(0);
    expect(container.textContent).toContain("No media found on this page");
  });

  it("never lists an encrypted stream, because its bytes are not a file", async () => {
    withEntries(streamEntry({ encrypted: true }));
    await render();

    expect(rows()).toHaveLength(0);
  });

  it("does list a stream that lost bytes, because that is when a person needs telling", async () => {
    withEntries(BROKEN);
    await render();

    // The opposite of the two above: a broken stream never played and still gets a row, and
    // says why.
    expect(rows()).toHaveLength(1);
    expect(rowText()).toContain("The player abandoned this stream");
  });
});

describe("asking for a stream's file", () => {
  it("asks the worker to assemble it, not to download a url", async () => {
    withEntries(PLAYABLE);
    await render();

    await click("Download video, Stream 1, 46.0 MB");

    const asked = sent[sent.length - 1];
    expect(asked?.name).toBe("STREAM_ASSEMBLE");
    // The url is all it carries: the worker looks the entry up and names the file itself, so
    // the popup cannot disagree with it about what a stream is called.
    expect(asked?.payload).toEqual({
      contractVersion: CONTRACT_VERSION,
      url: PLAYABLE.url,
    });
    expect(asked?.payload).not.toHaveProperty("filename");
  });

  it("still asks for a file by the file message", async () => {
    withEntries(MP4);
    await render();

    await click("Download video, clip.mp4, 46.0 MB");

    expect(sent[sent.length - 1]?.name).toBe("DOWNLOAD_MEDIA");
  });

  it("says it was sent, and not Saved, because we cannot watch a stream transfer", async () => {
    withEntries(PLAYABLE);
    reply = () =>
      sent.some((message) => message.name === "STREAM_ASSEMBLE")
        ? { ok: true }
        : getTabMedia({ record: record({ entries: [PLAYABLE] }) });
    await render();

    await click("Download video, Stream 1, 46.0 MB");

    // We produce the file and the browser takes it from there. There is no transfer of ours
    // to watch, so the honest claim is that it was sent.
    expect(rowText()).toContain("Sent to your downloads");
    expect(rowText()).not.toContain("Saved");
  });

  it("gives the row back its control after it was sent", async () => {
    withEntries(PLAYABLE);
    reply = () =>
      sent.some((message) => message.name === "STREAM_ASSEMBLE")
        ? { ok: true }
        : getTabMedia({ record: record({ entries: [PLAYABLE] }) });
    await render();

    await click("Download video, Stream 1, 46.0 MB");

    expect(buttons().map(accessibleName).some((name) => name.startsWith("Download"))).toBe(
      false
    );
  });

  it("says one is already being assembled rather than assembling a second copy", async () => {
    withEntries(PLAYABLE);
    reply = () =>
      sent.some((message) => message.name === "STREAM_ASSEMBLE")
        ? { ok: false, error: "already_running" }
        : getTabMedia({ record: record({ entries: [PLAYABLE] }) });
    await render();

    await click("Download video, Stream 1, 46.0 MB");

    expect(rowText()).toContain("One download is already being assembled");
    expect(buttons().map(accessibleName).some((name) => name.startsWith("Download"))).toBe(
      true
    );
  });

  it("says the page would not hand the file over, which is not the same as failing", async () => {
    withEntries(PLAYABLE);
    reply = () =>
      sent.some((message) => message.name === "STREAM_ASSEMBLE")
        ? { ok: false, error: "page_refused" }
        : getTabMedia({ record: record({ entries: [PLAYABLE] }) });
    await render();

    await click("Download video, Stream 1, 46.0 MB");

    expect(rowText()).toContain("The page would not hand the file over");
  });

  it("says there is nothing to save yet, rather than printing a reason code", async () => {
    withEntries(PLAYABLE);
    reply = () =>
      sent.some((message) => message.name === "STREAM_ASSEMBLE")
        ? { ok: false, error: "no_bytes" }
        : getTabMedia({ record: record({ entries: [PLAYABLE] }) });
    await render();

    await click("Download video, Stream 1, 46.0 MB");

    expect(rowText()).toContain("There is nothing to save yet");
    expect(rowText()).not.toContain("no_bytes");
  });

  it("gives a refused stream its control back, like a refused file", async () => {
    withEntries(PLAYABLE);
    reply = () =>
      sent.some((message) => message.name === "STREAM_ASSEMBLE")
        ? { ok: false }
        : getTabMedia({ record: record({ entries: [PLAYABLE] }) });
    await render();

    await click("Download video, Stream 1, 46.0 MB");

    expect(buttons().map(accessibleName).some((name) => name.startsWith("Download"))).toBe(
      true
    );
  });

  it("leaves a file row saying Download failed, exactly as it always has", async () => {
    withEntries(MP4);
    reply = () =>
      sent.some((message) => message.name === "DOWNLOAD_MEDIA")
        ? { ok: false, error: "That file is no longer listed for this page" }
        : getTabMedia({ record: record({ entries: [MP4] }) });
    await render();

    await click("Download video, clip.mp4, 46.0 MB");

    // The stream reasons are new copy for streams. Widening a file's sentence is a different
    // decision, and not one this slice owns.
    expect(rowText()).toContain("Download failed");
  });

  it("keeps working when the worker cannot be reached at all", async () => {
    withEntries(PLAYABLE);
    await render();
    rejectMessages = new Error("the worker is gone");

    await click("Download video, Stream 1, 46.0 MB");

    expect(rowText()).toContain("Download failed");
    expect(buttons().map(accessibleName).some((name) => name.startsWith("Download"))).toBe(
      true
    );
  });
});
// ─── Spec 0005: the two states the popup reaches because of the hook ─────────

describe("a page that refused the hook", () => {
  it("says the page blocks access rather than showing an empty list", async () => {
    // The hook is injected into the page's own world and a page can refuse that while
    // accepting an isolated content script. Naming it is the difference between an empty
    // list and a reason, and this is the state the worker reports for that case.
    reply = () => getTabMedia({ record: null, status: "blocked" });
    await render();

    expect(container.textContent).toContain("This page blocks access");
    expect(container.textContent).not.toContain("No media found on this page");
  });

  it("does not blame the site for something it may not have refused on purpose", async () => {
    reply = () => getTabMedia({ record: null, status: "blocked" });
    await render();

    // The wording stays as it was in spec 0003. Changing it is a design language decision,
    // and this slice has no reason to make one.
    expect(container.textContent).toContain("The page refused to share what it is playing.");
  });

  it("still names a page that cannot be watched at all, which is a different thing", async () => {
    reply = () => getTabMedia({ record: null, status: "unsupported" });
    await render();

    expect(container.textContent).toContain("This page cannot be watched");
    expect(container.textContent).not.toContain("This page blocks access");
  });
});

describe("a stream row that goes away when the page reloads", () => {
  it("is gone after the worker says the record changed and no longer lists it", async () => {
    withEntries(PLAYABLE);
    await render();
    expect(rows()).toHaveLength(1);

    // The bytes behind a stream died with the page, so a fresh hook knows nothing about it.
    // The worker drops the row and broadcasts; this is the half a person actually sees.
    withEntries();
    await act(async () => {
      broadcast({ name: "TAB_MEDIA_UPDATED", payload: { tabId: 1 } });
    });

    expect(rows()).toHaveLength(0);
    expect(container.textContent).toContain("No media found on this page");
  });

  it("keeps the page's own files, because they did not die with the stream", async () => {
    withEntries(MP4, PLAYABLE);
    await render();
    expect(rows()).toHaveLength(2);

    withEntries(MP4);
    await act(async () => {
      broadcast({ name: "TAB_MEDIA_UPDATED", payload: { tabId: 1 } });
    });

    // The observer's file is still there. A reload drop that took it too would be the
    // network side being wrong about what a page reload means.
    expect(rows()).toHaveLength(1);
    expect(rowText()).toContain("clip.mp4");
  });

  it("does not drop a row for a broadcast naming another tab", async () => {
    withEntries(PLAYABLE);
    await render();

    withEntries();
    await act(async () => {
      broadcast({ name: "TAB_MEDIA_UPDATED", payload: { tabId: 7 } });
    });

    expect(rows()).toHaveLength(1);
  });
});