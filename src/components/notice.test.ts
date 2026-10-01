import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TriangleAlert } from "lucide-react";
import { describe, expect, it } from "vitest";

import { Notice } from "./notice";

// Spec 0003 states the role follows the variant, so a page that merely refuses access is
// announced politely and only a genuine failure interrupts. That distinction is the whole
// point of the component, and it is invisible to a screenshot.
//
// covers: AC-4, AC-11

// Every class attribute in the markup, not just the first: the contract under test
// lives on a nested element in each of these components.
function classesOf(html: string): string[] {
  return [...html.matchAll(/class="([^"]*)"/g)]
    .flatMap((match) => match[1].split(/\s+/))
    .filter(Boolean);
}

describe("the notice role", () => {
  it("announces politely by default, because a blocked page is information not failure", () => {
    const html = renderToStaticMarkup(
      createElement(Notice, {
        icon: TriangleAlert,
        title: "This page blocks access",
      })
    );

    expect(html).toContain('role="status"');
    expect(html).not.toContain('role="alert"');
  });

  it("interrupts only when something actually failed", () => {
    const html = renderToStaticMarkup(
      createElement(Notice, {
        icon: TriangleAlert,
        title: "Download interrupted",
        variant: "destructive",
      })
    );

    expect(html).toContain('role="alert"');
  });

  it("uses the palette's single hue only on the destructive variant", () => {
    const neutral = renderToStaticMarkup(
      createElement(Notice, { icon: TriangleAlert, title: "This page blocks access" })
    );
    const destructive = renderToStaticMarkup(
      createElement(Notice, {
        icon: TriangleAlert,
        title: "Download interrupted",
        variant: "destructive",
      })
    );

    expect(classesOf(neutral)).not.toContain("text-destructive");
    expect(classesOf(destructive)).toContain("text-destructive");
  });
});

describe("the notice content", () => {
  it("renders the caller's title and description", () => {
    const html = renderToStaticMarkup(
      createElement(Notice, {
        icon: TriangleAlert,
        title: "This page blocks access",
        description: "Play a video and we will try again.",
      })
    );

    expect(html).toContain("This page blocks access");
    expect(html).toContain("Play a video and we will try again.");
  });

  it("omits the description paragraph entirely when there is no description", () => {
    const html = renderToStaticMarkup(
      createElement(Notice, { icon: TriangleAlert, title: "This page cannot be watched" })
    );

    expect(html).toContain("This page cannot be watched");
    expect(html.match(/<p[ >]/g) ?? []).toHaveLength(1);
  });

  it("hides the decorative icon from assistive technology", () => {
    const html = renderToStaticMarkup(
      createElement(Notice, { icon: TriangleAlert, title: "This page blocks access" })
    );

    expect(html).toContain("aria-hidden");
  });

  it("emits no default palette colour, so the reset cannot be defeated here", () => {
    const html = renderToStaticMarkup(
      createElement(Notice, {
        icon: TriangleAlert,
        title: "Download interrupted",
        variant: "destructive",
      })
    );

    expect(classesOf(html).filter((n) => /(slate|zinc|purple|blue|emerald|red)-\d/.test(n))).toEqual([]);
  });
});