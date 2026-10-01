// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createElement, type ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";

// Spec 0003 gives the tooltip one job: be supplementary. Its content is the palette's
// high contrast inversion, so a tooltip can never be the only thing carrying a meaning
// that also has to be legible elsewhere. These tests pin the shape and the tokens, and
// deliberately do not assert any timing, because the trigger delay is presentation.
//
// covers: AC-4, AC-11

let root: Root;
let container: HTMLDivElement;

// jsdom implements no ResizeObserver, and Radix's tooltip arrow measures its trigger with
// one. A no-op stub fills the environment gap; nothing here depends on the measurement.
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function render(node: ReactNode): void {
  act(() => root.render(node));
}

beforeEach(() => {
  globalThis.ResizeObserver = globalThis.ResizeObserver ?? NoopResizeObserver;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

function classesIn(selector: string): string[] {
  return [...document.querySelectorAll(selector)].flatMap((el) =>
    [...el.classList]
  );
}

describe("the tooltip, opened", () => {
  it("puts its content in the document, not inside the trigger", () => {
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(
          Tooltip,
          { open: true },
          createElement(TooltipTrigger, null, createElement("button", null, "Rescan")),
          createElement(TooltipContent, null, "Check this page again")
        )
      )
    );

    expect(document.body.textContent).toContain("Check this page again");
  });

  it("keeps the trigger's own label intact, so the tooltip only adds to it", () => {
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(
          Tooltip,
          { open: true },
          createElement(TooltipTrigger, null, createElement("button", null, "Rescan")),
          createElement(TooltipContent, null, "Check this page again")
        )
      )
    );

    const button = document.querySelector("button");
    expect(button?.textContent).toBe("Rescan");
  });

  it("inverts with the token pair rather than a raw palette value", () => {
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(
          Tooltip,
          { open: true },
          createElement(TooltipTrigger, null, createElement("button", null, "Rescan")),
          createElement(TooltipContent, null, "Check this page again")
        )
      )
    );

    const classes = classesIn("[data-slot='tooltip-content']");
    expect(classes).toContain("bg-foreground");
    expect(classes).toContain("text-background");
  });

  it("emits no default palette colour, so a raw value cannot reach it", () => {
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(
          Tooltip,
          { open: true },
          createElement(TooltipTrigger, null, createElement("button", null, "Rescan")),
          createElement(TooltipContent, null, "Check this page again")
        )
      )
    );

    const palette = classesIn("[data-slot='tooltip-content']").filter((name) =>
      /(slate|zinc|purple|blue|red|emerald|white|black)/.test(name)
    );
    expect(palette).toEqual([]);
  });

  it("renders its arrow from the same token as its surface", () => {
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(
          Tooltip,
          { open: true },
          createElement(TooltipTrigger, null, createElement("button", null, "Rescan")),
          createElement(TooltipContent, null, "Check this page again")
        )
      )
    );

    expect(classesIn("[data-slot='tooltip-content'] svg")).toContain("fill-foreground");
  });
});