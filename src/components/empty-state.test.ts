import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Search } from "lucide-react";
import { describe, expect, it } from "vitest";

import { EmptyState } from "./empty-state";

// Spec 0003 keeps this component free of status awareness on purpose: `observing` is
// skeleton rows and `ready` with nothing found is this, and the caller owns the wording
// because it is the only thing that knows whether the page was YouTube. So the contract
// here is narrow: say what the caller said, add nothing, and paint from tokens only.
//
// covers: AC-11

// Every class attribute in the markup, not just the first: the contract under test
// lives on a nested element in each of these components.
function classesOf(html: string): string[] {
  return [...html.matchAll(/class="([^"]*)"/g)]
    .flatMap((match) => match[1].split(/\s+/))
    .filter(Boolean);
}

describe("the empty state", () => {
  it("renders the caller's title and description verbatim", () => {
    const html = renderToStaticMarkup(
      createElement(EmptyState, {
        icon: Search,
        title: "No media found on this page",
        description: "Play a video and we will catch the stream.",
      })
    );

    expect(html).toContain("No media found on this page");
    expect(html).toContain("Play a video and we will catch the stream.");
  });

  it("carries no status of its own, so it cannot claim to be loading", () => {
    const html = renderToStaticMarkup(
      createElement(EmptyState, {
        icon: Search,
        title: "No media found on this page",
        description: "Play a video and we will catch the stream.",
      })
    );

    expect(html).not.toContain("role=");
    expect(html).not.toMatch(/aria-live|aria-busy/);
    expect(html).not.toContain("animate-");
  });

  it("hides the decorative icon from assistive technology", () => {
    const html = renderToStaticMarkup(
      createElement(EmptyState, { icon: Search, title: "Nothing", description: "Yet" })
    );

    expect(html).toContain("aria-hidden");
  });

  it("paints from tokens only, never a raw palette value", () => {
    const classes = classesOf(
      renderToStaticMarkup(
        createElement(EmptyState, { icon: Search, title: "Nothing", description: "Yet" })
      )
    );

    expect(classes.filter((n) => /(slate|zinc|purple|blue|emerald|red)-\d/.test(n))).toEqual([]);
    expect(classes).toContain("bg-card");
    expect(classes).toContain("border-border");
  });

  it("keeps the description at the size the typography table names for empty copy", () => {
    const html = renderToStaticMarkup(
      createElement(EmptyState, { icon: Search, title: "Nothing", description: "Yet" })
    );

    expect(html).toContain("text-muted-foreground");
    expect(html).toContain("text-sm");
  });
});