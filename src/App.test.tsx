// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";

// Spec 0003's runtime criteria for the popup itself. The extension API is the boundary
// here, so it is faked and nothing below it is.
//
// covers: AC-2, AC-9, AC-10

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

interface Video {
  url: string;
  type: "video" | "audio";
  title: string;
  quality?: string;
  mime?: string;
  size?: string;
  timestamp: number;
}

const VIDEO_1080: Video = {
  url: "https://cdn.example.com/s1080.mp4",
  type: "video",
  title: "Interview",
  quality: "1080p",
  mime: "video/mp4",
  size: "48.2 MB",
  timestamp: 1,
};
const VIDEO_720: Video = { ...VIDEO_1080, url: "https://cdn.example.com/s720.mp4", quality: "720p" };
const AUDIO: Video = {
  url: "https://cdn.example.com/audio.m4a",
  type: "audio",
  title: "Audio",
  quality: "128kbps",
  mime: "audio/mp4",
  size: "3.1 MB",
  timestamp: 2,
};

const VIDEO_WEBM: Video = { ...VIDEO_1080, url: "https://cdn.example.com/s.webm", mime: "video/webm" };
const AUDIO_NO_MIME: Video = { ...AUDIO, url: "https://cdn.example.com/plain-audio", mime: undefined };

let listeners: Array<(message: unknown) => void>;
let sendMessage: ReturnType<typeof vi.fn>;
let root: Root;
let container: HTMLDivElement;

function installChrome(videos: Video[], pageTitle = "Documentary Stream"): void {
  listeners = [];
  sendMessage = vi.fn((message: { type?: string }, callback?: (r: unknown) => void) => {
    if (message?.type === "GET_VIDEOS") callback?.({ videos });
    // The popup sends DOWNLOAD_VIDEO with no callback at all, so tolerate its absence.
    else if (typeof callback === "function") callback?.({ success: true });
  });

  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      lastError: undefined,
      onMessage: {
        addListener: (fn: (m: unknown) => void) => listeners.push(fn),
        removeListener: () => {},
      },
      sendMessage,
    },
    tabs: {
      query: (_query: unknown, callback: (tabs: unknown[]) => void) =>
        callback([{ id: 1, url: "https://example.com/watch" }]),
      sendMessage: (_id: unknown, _message: unknown, callback?: (r: unknown) => void) =>
        callback?.({ title: pageTitle, url: "https://example.com/watch" }),
    },
  };
}

function accessibleName(element: Element): string {
  return element.getAttribute("aria-label")?.trim() || element.textContent?.trim() || "";
}

function buttons(): HTMLButtonElement[] {
  return [...container.querySelectorAll("button")] as HTMLButtonElement[];
}

async function render(videos: Video[], pageTitle?: string): Promise<void> {
  installChrome(videos, pageTitle);
  await act(async () => {
    root.render(<App />);
  });
}

function filenameOf(mock: ReturnType<typeof vi.fn>): string | undefined {
  return mock.mock.calls.find((c) => c[0]?.type === "DOWNLOAD_VIDEO")?.[0]?.filename;
}

async function clickDownload(labelPrefix: string): Promise<void> {
  const target = buttons().find((b) => accessibleName(b).startsWith(labelPrefix));
  if (!target) throw new Error(`no control named like "${labelPrefix}"`);
  await act(async () => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (globalThis as { chrome?: unknown }).chrome;
});

describe("accessible names on the popup controls", () => {
  it("gives every control a name, so an icon only button is not a mystery", async () => {
    await render([VIDEO_1080, VIDEO_720, AUDIO]);

    expect(buttons().length).toBeGreaterThan(0);
    expect(buttons().filter((b) => accessibleName(b) === "")).toEqual([]);
  });

  it("names the rescan control for what it does", async () => {
    await render([VIDEO_1080]);

    expect(buttons().map(accessibleName)).toContain("Rescan this page");
  });

  it("tells a video row and an audio row apart by name, not by colour", async () => {
    await render([VIDEO_1080, AUDIO]);

    const names = buttons().map(accessibleName);
    expect(names.some((n) => n.includes("video"))).toBe(true);
    expect(names.some((n) => n.includes("audio"))).toBe(true);
  });

  it("carries the quality into the name, so two video rows are not interchangeable", async () => {
    await render([VIDEO_1080, VIDEO_720]);

    const names = buttons().map(accessibleName);
    expect(names).toContain("Download video 1080p");
    expect(names).toContain("Download video 720p");
  });
});

describe("the colour the popup renders", () => {
  it("uses no default palette colour anywhere in the resting list", async () => {
    await render([VIDEO_1080, VIDEO_720, AUDIO]);

    const offenders = container.innerHTML.match(
      /\b(?:accent|bg|border|ring|fill|stroke|text|from|via|to)-(?:slate|zinc|neutral|gray|stone|purple|blue|red|emerald)-\d+/g
    );
    expect(offenders ?? []).toEqual([]);
  });

  it("keeps the palette's single hue out of a resting row", async () => {
    await render([VIDEO_1080]);

    expect(container.innerHTML).not.toContain("text-destructive");
  });

  it("spends that hue only once a transfer has actually failed", async () => {
    await render([VIDEO_1080]);
    await clickDownload("Download video");

    await act(async () => {
      for (const listener of listeners) {
        listener({
          type: "DOWNLOAD_PROGRESS",
          url: VIDEO_1080.url,
          downloadId: 1,
          bytesReceived: 3,
          totalBytes: 10,
          state: "interrupted",
        });
      }
    });

    expect(container.innerHTML).toContain("text-destructive");
  });
});

describe("the download filename", () => {
  it.each([
    ["a page title with spaces", [VIDEO_1080], "Documentary Stream", "Documentary_Stream_1080p.mp4"],
    ["a webm source", [VIDEO_WEBM], "Documentary Stream", "Documentary_Stream_1080p.webm"],
    ["an audio row with no usable mime", [AUDIO_NO_MIME], "Documentary Stream", "Documentary_Stream_128kbps.mp3"],
    ["punctuation in the page title", [VIDEO_1080], "Ep. 4: The Cut!", "Ep_4_The_Cut_1080p.mp4"],
  ])("derives %s", async (_case, videos, pageTitle, expected) => {
    await render(videos as Video[], pageTitle as string);
    await clickDownload("Download");

    const call = sendMessage.mock.calls.find((c) => c[0]?.type === "DOWNLOAD_VIDEO");
    expect(call?.[0]).toMatchObject({ type: "DOWNLOAD_VIDEO", filename: expected });
  });

  it.each([
    ["an empty page title", ""],
    ["a whitespace only page title", "   "],
    ["a page title that is only punctuation", "!!!"],
    ["a page title that is only dashes", "— —"],
  ])(
    "keeps an identifying stem when the page gives %s",
    async (_case, pageTitle) => {
      await render([VIDEO_1080], pageTitle);
      await clickDownload("Download");

      const call = sendMessage.mock.calls.find((c) => c[0]?.type === "DOWNLOAD_VIDEO");
      const filename = (call?.[0] as { filename?: string } | undefined)?.filename ?? "";

      expect(filename).not.toMatch(/^_/);
      expect(filename).toContain(".mp4");
    }
  );

  it("falls back to a stem that says the page was untitled, not to an empty one", async () => {
    await render([VIDEO_1080], "");
    await clickDownload("Download");

    expect(filenameOf(sendMessage)).toBe("Unknown_Page_1080p.mp4");
  });

  it("asks the worker to download the row's own url", async () => {
    await render([VIDEO_1080]);
    await clickDownload("Download video");

    const call = sendMessage.mock.calls.find((c) => c[0]?.type === "DOWNLOAD_VIDEO");
    expect(call?.[0]).toMatchObject({ url: VIDEO_1080.url });
  });
});

describe("a download in flight", () => {
  it("replaces that row's download control while the transfer runs", async () => {
    await render([VIDEO_1080, VIDEO_720]);
    expect(buttons().map(accessibleName)).toContain("Download video 1080p");

    await clickDownload("Download video 1080p");

    const names = buttons().map(accessibleName);
    expect(names).not.toContain("Download video 1080p");
    expect(names).toContain("Download video 720p");
  });

  it("offers the control again once the transfer completes", async () => {
    await render([VIDEO_1080]);
    await clickDownload("Download video");

    await act(async () => {
      for (const listener of listeners) {
        listener({
          type: "DOWNLOAD_PROGRESS",
          url: VIDEO_1080.url,
          downloadId: 1,
          bytesReceived: 10,
          totalBytes: 10,
          state: "complete",
        });
      }
    });

    expect(buttons().map(accessibleName)).not.toContain("Download video 1080p");
    expect(container.innerHTML).not.toContain("text-destructive");
  });

  it("clamps a percentage past 100 rather than running past its own track", async () => {
    // `totalBytes` is the declared size and `bytesReceived` counts the whole body, so a
    // redirect or a resumed transfer reports more than was promised.
    await render([VIDEO_1080]);
    await clickDownload("Download video");

    await act(async () => {
      for (const listener of listeners) {
        listener({
          type: "DOWNLOAD_PROGRESS",
          url: VIDEO_1080.url,
          downloadId: 1,
          bytesReceived: 140,
          totalBytes: 100,
          state: "in_progress",
        });
      }
    });

    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("100");
  });

  it("shows no invented fill when the total size is unknown", async () => {
    await render([VIDEO_1080]);
    await clickDownload("Download video");

    await act(async () => {
      for (const listener of listeners) {
        listener({
          type: "DOWNLOAD_PROGRESS",
          url: VIDEO_1080.url,
          downloadId: 1,
          bytesReceived: 5,
          totalBytes: 0,
          state: "in_progress",
        });
      }
    });

    const bar = container.querySelector('[role="progressbar"]');
    // An unknown total is not zero out of a hundred, so it claims no value at all.
    expect(bar?.hasAttribute("aria-valuenow")).toBe(false);
    // This bar used to paint a fixed 30%, so a transfer of unknown length looked 30%
    // done and never moved.
    expect(container.innerHTML).not.toContain("30%");
  });
});

describe("the popup with nothing on the page", () => {
  it("says so, rather than showing an empty list", async () => {
    await render([]);

    expect(container.textContent).toContain("No media detected");
  });

  it("still names every control it does render", async () => {
    await render([]);

    expect(buttons().filter((b) => accessibleName(b) === "")).toEqual([]);
  });
});