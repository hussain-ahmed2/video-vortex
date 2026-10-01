import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Progress } from "./progress";

// Spec 0003 reserves `--primary` for the one action surface in a resting row, so the
// progress fill must not use it: a row in flight was otherwise the brightest thing on
// screen. The class is the observable here, because a token name maps one to one onto a
// design token and the token is this design system's public surface. No user visible text
// or role stands in for it.
//
// covers: AC-5

// Every class attribute in the markup, not just the first: the contract under test
// lives on a nested element in each of these components.
function classesOf(html: string): string[] {
  return [...html.matchAll(/class="([^"]*)"/g)]
    .flatMap((match) => match[1].split(/\s+/))
    .filter(Boolean);
}

describe("the progress fill", () => {
  it("uses the muted foreground token rather than the action token", () => {
    const classes = classesOf(renderToStaticMarkup(createElement(Progress, { value: 40 })));

    expect(classes).toContain("bg-muted-foreground");
    expect(classes).not.toContain("bg-primary");
  });

  it("paints its track from the muted token, so the track is never transparent", () => {
    const classes = classesOf(renderToStaticMarkup(createElement(Progress, { value: 40 })));

    expect(classes).toContain("bg-muted");
  });

  it("resolves to no default palette colour, so a raw value cannot reach the bar", () => {
    const classes = classesOf(renderToStaticMarkup(createElement(Progress, { value: 40 })));

    expect(classes.filter((name) => /(slate|zinc|purple|blue|red|emerald)-\d/.test(name))).toEqual([]);
  });
});

/** The inline transform on the indicator, which is what the clamp is protecting. */
function indicatorTransform(value: number | undefined): string {
  const html = renderToStaticMarkup(createElement(Progress, { value }));
  return /data-slot="progress-indicator"[^>]*style="([^"]*)"/.exec(html)?.[1] ?? "";
}

describe("the progress value", () => {
  it("clamps above 100 rather than emitting a transform the parser drops", () => {
    // `totalBytes` is the declared size and `bytesReceived` counts the whole body, so a
    // redirect or a resumed transfer reports more than promised. Unclamped this read
    // `translateX(--40%)`, which is not a transform, so the bar fell back to full width
    // and claimed to be complete.
    expect(indicatorTransform(140)).toBe("transform:translateX(-0%)");
    expect(indicatorTransform(140)).not.toContain("--");
  });

  it("clamps below 0, so the bar cannot travel off the wrong end", () => {
    expect(indicatorTransform(-20)).toBe("transform:translateX(-100%)");
  });

  it("rounds, so the transform never carries a fraction the spec did not ask for", () => {
    expect(indicatorTransform(33.4)).toBe("transform:translateX(-67%)");
    expect(indicatorTransform(66.7)).toBe("transform:translateX(-33%)");
  });

  it("reports the real value to a screen reader, which it never did before", () => {
    // The value used to be destructured out and used only for the transform, so Radix
    // received nothing and every bar announced itself as indeterminate.
    const html = renderToStaticMarkup(createElement(Progress, { value: 40 }));

    expect(html).toContain('aria-valuenow="40"');
    expect(html).toContain('data-state="loading"');
  });

  it("calls an unknown length indeterminate, and shows no invented fill", () => {
    const html = renderToStaticMarkup(createElement(Progress, { value: undefined }));

    expect(html).toContain('data-state="indeterminate"');
    expect(html).not.toContain("aria-valuenow");
    // Spec 0003 rules out a faked 30%. The bar is empty and the row's own label is
    // where the "size unknown" wording belongs.
    expect(indicatorTransform(undefined)).toBe("transform:translateX(-100%)");
  });

  it("gates the tween, so reduced motion reaches a CSS transition", () => {
    const classes = classesOf(renderToStaticMarkup(createElement(Progress, { value: 40 })));

    expect(classes).toContain("transition-transform");
    expect(classes).toContain("motion-reduce:transition-none");
  });
});