import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Skeleton } from "./skeleton";

// Spec 0003 allows no looping animation the user did not ask for, and a shimmer is a
// loop, so it is gated behind `motion-safe:`. The shadcn CLI generates the ungated
// `animate-pulse`, so this asserts the exact pair: the gated form present, the bare form
// absent. Checking only for absence would pass on a skeleton that never animates at all.
//
// covers: AC-8

// Every class attribute in the markup, not just the first: the contract under test
// lives on a nested element in each of these components.
function classesOf(html: string): string[] {
  return [...html.matchAll(/class="([^"]*)"/g)]
    .flatMap((match) => match[1].split(/\s+/))
    .filter(Boolean);
}

describe("the skeleton shimmer", () => {
  it("animates only when motion is welcome", () => {
    const classes = classesOf(renderToStaticMarkup(createElement(Skeleton)));

    expect(classes).toContain("motion-safe:animate-pulse");
    expect(classes).not.toContain("animate-pulse");
  });

  it("still renders a box, so a gated shimmer has not become no shimmer", () => {
    const html = renderToStaticMarkup(createElement(Skeleton));

    expect(html).toContain("<div");
    expect(classesOf(html)).toContain("rounded-md");
  });
});