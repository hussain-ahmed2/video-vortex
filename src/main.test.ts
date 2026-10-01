// @vitest-environment jsdom

import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const VIDEO = {
  url: "https://cdn.example.com/s1080.mp4",
  type: "video" as const,
  title: "Interview",
  quality: "1080p",
  mime: "video/mp4",
  size: "48.2 MB",
  timestamp: 1,
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

function stubExtensionApi(): void {
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      lastError: undefined,
      onMessage: { addListener: () => {}, removeListener: () => {} },
      sendMessage: (message: { type?: string }, callback?: (r: unknown) => void) => {
        if (message?.type === "GET_VIDEOS") callback?.({ videos: [VIDEO] });
        else if (typeof callback === "function") callback?.({ success: true });
      },
    },
    tabs: {
      query: (_query: unknown, callback: (tabs: unknown[]) => void) =>
        callback([{ id: 1, url: "https://example.com/watch" }]),
      sendMessage: (_id: unknown, _message: unknown, callback?: (r: unknown) => void) =>
        callback?.({ title: "Documentary Stream", url: "https://example.com/watch" }),
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  stubReducedMotion();
  stubExtensionApi();
  document.body.innerHTML = '<div id="root"></div>';
});

describe("the popup under a reduced motion preference", () => {
  it("mounts the list", async () => {
    await import("./main");
    await act(async () => {});

    expect(document.body.textContent).toContain("Secure Downloader");
  });

  it("applies no transform to a row that is entering, so nothing travels", async () => {
    await import("./main");
    await act(async () => {});

    const rows = [...document.querySelectorAll<HTMLElement>('[data-slot="card"]')];
    expect(rows.length).toBeGreaterThan(0);

    const transformed = rows.filter((row) => {
      const wrapper = row.closest<HTMLElement>("[style*='transform']");
      const style = row.style.transform || wrapper?.style.transform || "";
      return style !== "" && style !== "none";
    });
    expect(transformed).toEqual([]);
  });

  it("leaves the row's opacity animation alone, so a row still appears", async () => {
    await import("./main");
    await act(async () => {});

    const row = document.querySelector<HTMLElement>('[data-slot="card"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("1080p");
  });
});