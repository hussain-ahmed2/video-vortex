import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Spec 0003's token layer is the contract every primitive depends on, so its properties
// are pinned here rather than left to a grep someone has to remember. Three criteria are
// automatable and were verified by hand in `/check verify`, which is exactly the kind of
// check that quietly stops being run.
//
// `src/index.css` is excluded from the usual test scope because styling is assumed
// untestable. For a design token standard it is the primary artefact, so it is tested here.
//
// covers: AC-4, AC-11, AC-12

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)));
const cssPath = join(srcDir, "index.css");
const css = readFileSync(cssPath, "utf8");

/** Custom properties the token layer actually declares on :root. */
function definedTokens(): Set<string> {
  return new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));
}

/**
 * Utility prefixes that take a colour, plus the ones that do not, because `text-` and
 * `border-` are overloaded and `text-sm` is a font size rather than a raw colour.
 */
const COLOUR_PREFIXES = [
  "accent",
  "bg",
  "border",
  "caret",
  "decoration",
  "divide",
  "fill",
  "from",
  "outline",
  "placeholder",
  "ring",
  "shadow",
  "stroke",
  "text",
  "to",
  "via",
];
const SIDE_SEGMENT = /^[xytrblse]-/;
/** Tailwind v4's own text sizes and border styles, which share the overloaded prefixes. */
const NOT_COLOURS = new Set([
  "none",
  "transparent",
  "inherit",
  "current",
  "solid",
  "dashed",
  "dotted",
  "double",
  "hidden",
  "clip-padding",
  "border-box",
  "padding-box",
  "content-box",
  "text-box",
  "xs",
  "sm",
  "base",
  "lg",
  "xl",
  // `text-` is overloaded: these are alignment and wrapping, not colour.
  "left",
  "center",
  "right",
  "justify",
  "start",
  "end",
  "wrap",
  "nowrap",
  "balance",
  "pretty",
  "ellipsis",
  "clip",
  "uppercase",
  "lowercase",
  "capitalize",
]);

/**
 * Every non test component under `src`, paired with its path relative to `src`.
 *
 * The whole of `src`, not `components/ui`. Scoping this to the primitives left
 * `--subtle-foreground` unchecked, because that token is referenced only from
 * `App.tsx`: deleting its value kept all 205 tests green while the built
 * stylesheet still emitted `var(--subtle-foreground)` and defined it nowhere, so
 * every metadata line in the popup silently inherited its colour.
 */
function colourSources(): Array<{ file: string; source: string }> {
  const found: Array<{ file: string; source: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      // The fixtures in this file and the suites beside it are where a literal
      // token name is supposed to appear, so they are not scanned for real usage.
      if (!entry.name.endsWith(".tsx") || /\.test\.tsx$/.test(entry.name)) continue;
      found.push({ file: relative(srcDir, full), source: readFileSync(full, "utf8") });
    }
  };
  walk(srcDir);
  return found;
}

/** Every colour position name a component asks for, paired with the file it came from. */
function colourReferences(): Array<{ file: string; name: string }> {
  const found: Array<{ file: string; name: string }> = [];
  for (const { file, source } of colourSources()) {
    const literals = source.match(/"[^"]*"|`[^`]*`/g) ?? [];
    for (const literal of literals) {
      for (const token of literal.slice(1, -1).split(/\s+/)) {
        const className = token.split(":").pop() as string;
      for (const prefix of COLOUR_PREFIXES) {
        if (!className.startsWith(`${prefix}-`)) continue;
        let name = className.slice(prefix.length + 1).split("/")[0];
        if (prefix === "border" || prefix === "divide") name = name.replace(SIDE_SEGMENT, "");
        if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) continue;
        if (NOT_COLOURS.has(name) || name.length < 3) continue;
        // `bg-gradient-to-t` and `bg-linear-to-t` are directions, and `bg-clip-text`
        // is a clip mode. The `bg-` prefix is overloaded the same way `text-` is, so
        // these are read by shape: the ones that matter are the ones that would
        // otherwise be reported as an undeclared token on every ordinary use.
        if (/^(gradient|linear)-to-/.test(name) || name === "clip-text") continue;
          found.push({ file, name });
        }
      }
    }
  }
  return found;
}

describe("AC-4, every colour a primitive asks for is declared", () => {
  it("has components to check, so this file cannot pass by finding nothing", () => {
    expect(colourSources().length).toBeGreaterThan(0);
    expect(colourReferences().length).toBeGreaterThan(0);
  });

  it("reaches past components/ui, which is where the gap was", () => {
    // A token consumed only by the popup is the case that escaped: no primitive
    // names it, so a scan limited to the primitives never sees it at all.
    const outsideUi = new Set(
      colourReferences()
        .filter((ref) => !ref.file.startsWith("components/ui/"))
        .map((ref) => ref.name)
    );
    expect(outsideUi).toContain("subtle-foreground");
  });

  it("resolves every colour reference to a token the stylesheet declares", () => {
    const defined = definedTokens();
    const unresolved = colourReferences()
      .filter((ref) => !defined.has(`--${ref.name}`))
      .map((ref) => `${ref.file}: ${ref.name}`);

    expect(unresolved).toEqual([]);
  });
});

describe("AC-11, the inventory the Components section names exists", () => {
  it.each([
    ["components/ui/skeleton.tsx", "Skeleton"],
    ["components/ui/progress.tsx", "Progress"],
    ["components/ui/tooltip.tsx", "Tooltip"],
    ["components/empty-state.tsx", "EmptyState"],
    ["components/notice.tsx", "Notice"],
  ])("has %s exporting %s", (path, exported) => {
    const full = join(srcDir, path);
    expect(existsSync(full)).toBe(true);

    // A file may export several names, so match the name inside the export list
    // rather than expecting a single export statement.
    const source = readFileSync(full, "utf8");
    const names = (source.match(/export\s*\{([^}]*)\}/)?.[1] ?? "")
      .split(",")
      .map((name) => name.trim());

    expect(names).toContain(exported);
  });
});

describe("AC-12, the token layer carries no dead rules and one typeface", () => {
  it("has no rule left over from the old look", () => {
    expect(css).not.toContain("vortex-gradient");
    expect(css).not.toContain(".glass");
    expect(css).not.toMatch(/^\.dark\s*\{/m);
  });

  it("names one typeface, and it is the one that is actually loaded", () => {
    expect(css).toContain('@import "@fontsource-variable/geist"');
    expect(css).not.toContain("Inter");
  });

  it("keeps the imports and the base rules the primitives depend on", () => {
    // Each of these was dropped or broken at some point, and each broke a primitive.
    expect(css).toContain('@import "tailwindcss"');
    expect(css).toContain('@import "tw-animate-css"');
    expect(css).toContain('@import "shadcn/tailwind.css"');
    expect(css).toContain("@custom-variant dark");
    expect(css).toContain("--font-heading");
    expect(css).toMatch(/@layer base\s*\{/);
    expect(css).toContain("border-border outline-ring/50");
  });

  it("paints the page from the token rather than a literal that cannot resolve", () => {
    // The old rule was `hsl(var(--background))` against an oklch value, which is invalid,
    // so the property fell back to transparent and the popup sat on the white canvas.
    expect(css).not.toMatch(/hsl\(var\(--/);
    expect(css).toContain("bg-background");
    expect(css).toContain("color-scheme: dark");
  });
});

// These read source rather than a rendered snapshot, which is the same trade the token
// rules above make. A row overshoots because of how its transition was authored, and
// jsdom never runs the animation, so no amount of rendering can tell an overshooting row
// from a still one. What is assertable is that the popup keeps saying what it means.
describe("the motion rules", () => {
  /**
   * Source with its comments removed.
   *
   * Without this, a comment that quotes the pattern it warns about trips the rule that
   * quotes it, and the tempting fix is to reword the comment rather than the code. That
   * turns a guard into something you satisfy by editing prose.
   */
  const code = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  const popup = code(readFileSync(join(srcDir, "App.tsx"), "utf8"));
  const skeleton = code(readFileSync(join(srcDir, "components", "ui", "skeleton.tsx"), "utf8"));

  it("gives every motion transition a duration", () => {
    // Motion reads a transition carrying only orchestration keys as undefined and then
    // applies its own default, which is a spring for `y` and `scale` at damping ratios
    // 0.559 and 0.640. A bare `transition={{ delay }}` is exactly such a transition, so
    // every row in the list overshot its final position and settled back.
    const bare = [...popup.matchAll(/transition=\{\{([^}]*)\}\}/g)]
      .map((match) => match[1].trim())
      .filter((inner) => !inner.includes("duration"));

    expect(bare).toEqual([]);
  });

  it("keeps no spring and no bounce anywhere in the popup", () => {
    // Spec 0003: entrances ease out, exits ease in, and nothing bounces on a list.
    expect(popup).not.toMatch(/type:\s*["']spring["']/);
    expect(popup).not.toMatch(/bounce:/);
  });

  it("keeps every duration inside the 200ms ceiling", () => {
    const durations = [...popup.matchAll(/duration:\s*([\d.]+)/g)].map((match) => Number(match[1]));

    expect(durations.length).toBeGreaterThan(0);
    expect(Math.max(...durations)).toBeLessThanOrEqual(0.2);
  });

  it("gates every looping animation behind motion-safe", () => {
    // An infinite animation is the one thing the popup may not contain, so each survivor
    // has to sit behind the variant rather than merely being short.
    const loops = [popup, skeleton].flatMap((source) =>
      [...source.matchAll(/[a-z-]*:?animate-(?:spin|ping|pulse|bounce)/g)].map((match) => match[0])
    );

    expect(loops.length).toBeGreaterThan(0);
    expect(loops.filter((name) => !name.startsWith("motion-safe:"))).toEqual([]);
  });
});
// ─── The colour maths ──────────────────────────────────────────────────────
//
// The spec's token table records seventeen measured contrast ratios, and until now
// every one of them was checked by hand in a browser. Nothing recomputed them, so a
// token could be nudged and the suite would stay green while the popup quietly lost
// contrast. These helpers exist so the numbers are derived rather than believed.
//
// The model matters more than it looks. A colour is converted oklch to linear sRGB,
// then to the gamma encoded form, because that is the space a browser composites in.
// An alpha value is blended there, and only then is the result taken back to linear
// for the WCAG weights. Compositing first and weighting afterwards gives the wrong
// answer, and so does interpolating lightness in oklab, which is what
// `color-mix(in oklab, …)` looks like but is not what reaches the screen: mixing a
// colour with `transparent` keeps the colour and halves its alpha.
//
// All seventeen pairs were reproduced against the recorded table before any of them
// were used to assert anything, the closest landing 0.02 away and the furthest 0.06.
function toLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function toGamma(channel: number): number {
  return channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
}

type Rgb = [number, number, number];

/** oklch to the gamma encoded sRGB a browser composites in. */
function toEncoded(lightness: number, chroma = 0, hue = 0): Rgb {
  const a = chroma * Math.cos((hue * Math.PI) / 180);
  const b = chroma * Math.sin((hue * Math.PI) / 180);

  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;

  const channels = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return channels.map((value) => toGamma(Math.min(1, Math.max(0, value)))) as Rgb;
}

/** WCAG relative luminance, which is defined on linear channels. */
function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: Rgb, background: Rgb): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

/** An alpha blended in the gamma encoded space, which is what a renderer does. */
function over(foreground: Rgb, background: Rgb, alpha: number): Rgb {
  return foreground.map(
    (channel, index) => channel * alpha + background[index] * (1 - alpha)
  ) as Rgb;
}

interface Oklch {
  L: number;
  C: number;
  H: number;
}

/** Every token the `:root` block declares as a literal oklch colour. */
function declaredTokens(): Map<string, Oklch> {
  const found = new Map<string, Oklch>();
  for (const match of css.matchAll(
    /(--[a-z0-9-]+):\s*oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/g
  )) {
    found.set(match[1], { L: Number(match[2]), C: Number(match[3]), H: Number(match[4]) });
  }
  return found;
}

function token(name: string): Rgb {
  const value = declaredTokens().get(name);
  if (!value) throw new Error(`no literal oklch declaration for ${name} in :root`);
  return toEncoded(value.L, value.C, value.H);
}

describe("AC-1, the namespace reset is declared", () => {
  it("resets the colour namespace inside @theme, where Tailwind reads it", () => {
    // Outside `@theme` this is just a custom property nothing consumes, so the rule
    // would look present and delete nothing.
    const themeBlocks = [...css.matchAll(/@theme\s*(?:inline\s*)?\{([^}]*)\}/g)].map((m) => m[1]);

    expect(themeBlocks.some((block) => block.includes("--color-*: initial"))).toBe(true);
  });

  it("leaves the token namespace alone, so a token can still be mapped", () => {
    expect(css).toMatch(/@theme inline\s*\{/);
    expect(css).toContain("--color-background: var(--background)");
  });
});

describe("AC-5, the palette is near monochrome", () => {
  it("declares exactly one chromatic token, and it is the destructive one", () => {
    const chromatic = [...declaredTokens()]
      .filter(([, value]) => value.C > 0)
      .map(([name]) => name);

    expect(chromatic).toEqual(["--destructive"]);
  });

  it("leaves every other token at zero chroma, so none of them can carry a hue", () => {
    const tinted = [...declaredTokens()]
      .filter(([name, value]) => name !== "--destructive" && value.C !== 0)
      .map(([name, value]) => `${name} at C ${value.C}`);

    expect(tinted).toEqual([]);
  });

  it("gives the destructive hue enough chroma to read as a state, not a tint", () => {
    // A hue at a trace amount is indistinguishable from the greys it sits beside, which
    // would leave a failed transfer communicated by nothing at all.
    expect(declaredTokens().get("--destructive")?.C).toBeGreaterThanOrEqual(0.1);
  });
});

describe("AC-6, every rendered pair clears the floor recorded for it", () => {
  const TEXT = 4.5;
  const NON_TEXT = 3;

  it.each([
    ["foreground on background", "foreground", "background", TEXT],
    ["foreground on card", "foreground", "card", TEXT],
    ["muted-foreground on background", "muted-foreground", "background", TEXT],
    ["muted-foreground on card", "muted-foreground", "card", TEXT],
    ["subtle-foreground on background", "subtle-foreground", "background", TEXT],
    ["subtle-foreground on card", "subtle-foreground", "card", TEXT],
    ["primary-foreground on primary", "primary-foreground", "primary", TEXT],
    ["secondary-foreground on secondary", "secondary-foreground", "secondary", TEXT],
    ["destructive on background", "destructive", "background", TEXT],
    ["input on card", "input", "card", NON_TEXT],
  ])("%s holds its floor", (_label, foreground, background, floor) => {
    const ratio = contrast(token(`--${foreground}`), token(`--${background}`));

    expect(ratio).toBeGreaterThanOrEqual(floor);
  });

  it("keeps the focus ring at 3:1 once it is composited at the 50% it renders", () => {
    // SC 2.4.11 and 1.4.11. The raw token is far above this; the rendered ring is what
    // has to clear it, and the two differ because the primitives paint it at half alpha.
    for (const surface of ["background", "card"] as const) {
      const backdrop = token(`--${surface}`);

      expect(contrast(over(token("--ring"), backdrop, 0.5), backdrop)).toBeGreaterThanOrEqual(
        NON_TEXT
      );
    }
  });

  it("keeps a raised panel and a row edge visible against what they sit on", () => {
    // Neither is a WCAG non-text contrast case, since a separator and a 1.15:1 panel
    // edge are decorative. These are the spec's measured values less a small margin, so
    // the edges cannot quietly stop reading as edges.
    expect(contrast(token("--card"), token("--background"))).toBeGreaterThanOrEqual(1.1);
    expect(contrast(token("--border"), token("--card"))).toBeGreaterThanOrEqual(1.4);
    expect(contrast(token("--border"), token("--background"))).toBeGreaterThanOrEqual(1.6);
  });

  it("keeps the hover fill a real change of surface", () => {
    // `bg-muted/50` is the hover on a row, and the spec measured it at 1.08:1. It is a
    // hover cue, not a boundary, so the floor is simply that it stays distinguishable.
    const backdrop = token("--card");

    expect(contrast(over(token("--muted"), backdrop, 0.5), backdrop)).toBeGreaterThanOrEqual(1.05);
  });
});
