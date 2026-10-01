# 0003. Popup design language

**Date**: 2026-09-30
**Status**: Accepted

## Summary

The popup gets one way to look. A small set of colour tokens, a fixed set of components, and a
stated bar for accessibility and motion. The popup stays dark and nearly monochrome, and colour is
reserved for actions. This replaces the hardcoded colours in the popup today, and two guards make
sure they do not come back. The popup itself is rebuilt on this language in slice 1, where the old
look is deleted rather than kept alongside it.

## Requirements

**User stories**:

- As someone opening the popup to grab a video, I want one consistent look across the extension so
  that it reads as one product rather than a set of screens.
- As a keyboard or low vision user, I want every state, label and focus ring to be legible and
  distinguishable without relying on colour, so that I can use the popup at all.
- As someone who has asked the OS to reduce motion, I want the popup to respect that setting, so
  that nothing moves on its own.
- As a maintainer, I want the palette to be one set of named tokens with a test that fails when a raw
  colour reappears, so that the look does not drift back one value at a time.

**Acceptance criteria** (the contract, each independently checkable):

Each criterion is tagged with how it is proven, because the registers are not interchangeable and
guessing between them produces the wrong verdict. **artefact** means provable from the built CSS, the
guard and the files on disk, with no browser needed. **running popup** means the popup has to be
rendered and observed in Chrome with data in it. **document** means this spec stating a sourced design
is the whole proof and there is nothing to run.

Six criteria are checked against the popup as it stands today, and slice 1 replaces that popup, so
they are re-checked after the rebuild. This spec is what constrains that rebuild: a row that drops
below 40px, or a record type carried by colour alone, fails here and not only in the popup.

- **AC-1** *(artefact)*: `src/index.css` sets `--color-*: initial`, so no default colour utility (`bg-slate-950`,
  `text-purple-300`, any raw palette step) exists in the built CSS.
- **AC-2** *(artefact)*: Every colour the popup renders resolves to a named token. A guard test fails the build on
  any raw colour utility, any literal colour outside the token layer, and any arbitrary value or
  gradient that carries a colour.
- **AC-3** *(running popup)*: The popup's first paint is the dark surface. `body` paints from the token, and no rule
  paints it white.
- **AC-4** *(artefact)*: Every colour token that the existing generated primitives reference is still defined, so
  no primitive renders unstyled after the namespace reset.
- **AC-5** *(running popup)*: The palette is near monochrome. Exactly one hue, reserved for destructive actions.
- **AC-6** *(running popup)*: Every rendered pair in the token table meets or beats the ratio measured for it, measured
  as composited rather than as a raw token, and the measured numbers live in this spec.
- **AC-7** *(document)*: The record states are designed against the engine spec's real vocabulary
  (`observing`, `ready`, `blocked`, `unsupported`) and the download states against
  `in_progress`, `complete`, `interrupted`. Each has a treatment that does not rely on colour. The
  three displays spec 0001 assigns to this feature, the hidden count, the staleness line and the
  loading hint, each have a named source and a stated treatment.
- **AC-8** *(running popup)*: Every animation is finite or opt in, no infinite animation remains, and the popup honours
  `prefers-reduced-motion: reduce` for both CSS transitions and `motion/react` animation.
- **AC-9** *(running popup)*: A media row is at least 40px tall, its controls are at least 24 by 24 CSS pixels, and every
  icon only control carries an accessible name.
- **AC-10** *(running popup)*: Audio and video records are distinguished by icon and text label, never by colour alone.
- **AC-11** *(artefact)*: Every component the Components section marks `new` exists, each stating the guarantee it
  carries: `skeleton`, `progress` and `tooltip` as shadcn primitives under `src/components/ui/`,
  and `empty-state` and `notice` as compositions under `src/components/`, because shadcn has no
  equivalent for those two. The three that section marks `deferred` belong to later features.
- **AC-12** *(artefact)*: `src/index.css` carries no dead rules and names exactly one typeface. Every existing
  import and base rule the primitives depend on survives.

## Decision

**Chosen option**: Adopt shadcn's token vocabulary, redefined as a dark near monochrome palette,
enforced by a build level namespace removal plus a source walking test.

**Implementation skills**: `tailwind-v4-shadcn` (`secondsky/claude-skills`,
`.agents/skills/tailwind-v4-shadcn/`) · `motion-foundations` (`affaan-m/ecc`,
`.agents/skills/motion-foundations/`) · `shadcn` (`.agents/skills/shadcn/`) ·
`chrome-extensions` (`googlechrome/modern-web-guidance`, `.agents/skills/chrome-extensions/`)

## Rationale

Full reasoning, options, the measured evidence and references: [rationale.md](rationale.md).

## Standard definition

**Canonical pattern**, the token layer as it should read. Everything else in the file stays:
`@import 'tailwindcss'`, the `@fontsource-variable/geist` and `tw-animate-css` imports,
`@custom-variant dark`, `--font-heading`, and the `*` base reset.

```css
@theme {
  --color-*: initial; /* deletes every default colour utility */
}

:root {
  color-scheme: dark;

  /* surfaces and fills */
  --background: oklch(0.145 0 0);
  --card: oklch(0.22 0 0);
  --muted: oklch(0.28 0 0);
  --input: oklch(0.55 0 0);

  /* text */
  --foreground: oklch(0.96 0 0);
  --card-foreground: oklch(0.96 0 0);
  --muted-foreground: oklch(0.72 0 0);
  --subtle-foreground: oklch(0.65 0 0);
  --secondary-foreground: oklch(0.96 0 0);

  /* actions */
  --primary: oklch(0.94 0 0);
  --primary-foreground: oklch(0.2 0 0);
  --secondary: oklch(0.32 0 0);
  --destructive: oklch(0.704 0.191 22.216);

  /* lines */
  --border: oklch(0.34 0 0);
  --ring: oklch(0.78 0 0);
}

@theme inline {
  --color-background: var(--background);
  --color-card: var(--card);
  --color-muted: var(--muted);
  --color-input: var(--input);
  --color-foreground: var(--foreground);
  --color-card-foreground: var(--card-foreground);
  --color-muted-foreground: var(--muted-foreground);
  --color-subtle-foreground: var(--subtle-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-ring: var(--ring);
  --font-sans: 'Geist Variable', sans-serif;
}

@layer base {
  body {
    @apply bg-background text-foreground;
  }
}
```

`--popover`, `--sidebar*` and `--chart-1..5` are deleted as unused. `--secondary`,
`--secondary-foreground`, `--input` and `--card-foreground` are kept even though the popup barely
uses them, because the generated primitives reference them today: `bg-secondary`,
`text-secondary-foreground`, `border-input`, `bg-input/30`, `bg-input/50`, `bg-muted/50` and
`text-card-foreground` all appear in `src/components/ui/`. Dropping them would silently unstyle the
secondary button variant, the outline button's border and every card footer hover.

```tsx
// A media row. Rows carry no fill, because the card step is only 1.15:1. The
// separator and the text carry the hierarchy.
<li className="flex min-h-10 items-center gap-3 border-b border-border px-3 text-foreground">
  <Film aria-hidden className="size-4 shrink-0 text-muted-foreground" />
  <span className="min-w-0 flex-1 truncate text-sm font-medium">Interview.mp4</span>
  <span className="text-xs text-subtle-foreground">1080p</span>
  <Button variant="ghost" size="icon" aria-label="Download Interview.mp4">
    <Download aria-hidden className="size-4" />
  </Button>
</li>
```

**Replaces**:

- Raw colour utilities in app code. `src/App.tsx` uses 37 distinct raw colour utility strings built
  from 17 palette values, including alpha variants.
- Literal colour values outside the token layer, which survive the namespace reset: the
  `shadow-[0_0_15px_rgba(168,85,247,0.2)]` glow, and the `from-purple-400 to-blue-400` gradient stop
  pair behind the `bg-clip-text text-transparent` title.
- Two colour systems at once. The shadcn tokens are light on `:root` while the popup paints itself
  dark with utilities, so the token layer and the visible UI disagree.
- A dead dark palette: `.dark` holds a full dark token set that nothing activates, because no element
  is ever given that class.
- `--font-sans: Inter` declared, then overridden by Geist Variable in the next `@theme` block.
- `.vortex-gradient` and `.glass`: decoration kept for a look nothing uses.
- Infinite motion: a logo spinning on a ten second loop and a glow pulsing on a three second loop.
- Ad hoc layout values: `w-[420px]`, `max-h-[600px]`, `text-[9px]`, `text-[10px]`, `max-w-[160px]`,
  `h-8 w-8`, and the `30%` placeholder and `duration: 0.3` spring passed as Motion values rather than
  Tailwind classes.
- `dark:` variant utilities, which cannot fire, because the surface is dark unconditionally.
- **Supersedes** the `AGENTS.md` line reading "The popup is dark by convention. It hardcodes slate and
  purple utilities instead of the shadcn theme tokens, so match that look rather than introducing
  light mode colors." This spec replaces it; the popup now uses the theme tokens.

**Enforcement**:

1. **Build, namespace removal.** `--color-*: initial` deletes every default colour utility. Measured
   on the pinned `tailwindcss@4.2.4`: `bg-slate-950` goes from 1 occurrence in `dist/assets/*.css`
   to 0, and no `bg-{slate,zinc,neutral,gray,red,purple,emerald}-*` utility survives anywhere in the
   output. A token defined after the reset still generates its utility.
2. **Test, source walking.** The reset is silent: with a raw colour utility in the source the build
   still succeeds and the class simply does not exist at run time. So a guard test walks the source
   and fails, written like the existing guards in `src/testing/` so it runs in `npm test` and gates
   `npm run build`. Its match set is specified under Enforcement, below, because the reset alone
   misses three real cases.
3. **Review, the tables below.** Contrast, density, motion and state treatments are stated with
   numbers, so there is something to check a change against.

**Enforcement, the guard's match set.** The namespace reset does not catch everything, so the test
must. It walks every source file including `.css`, and fails on:

- any default palette step, such as `slate-950`, `zinc-800` or `purple-400`, including an
  `/opacity` variant such as `bg-slate-950/80`
- a raw colour name used as a colour, so `bg-white` and `text-black` fail
- `text-transparent`, which would hide the title once its gradient stops stop compiling, while
  `bg-transparent` and `to-transparent` stay legal because they mean "no colour" rather than a choice
- any gradient colour stop, so `from-purple-400` fails
- any arbitrary value containing a colour, so `shadow-[0_0_15px_rgba(168,85,247,0.2)]` and
  `bg-[#7c3aed]` both fail
- any literal colour outside the token layer in `src/index.css`, so the file where colours are
  allowed is also the file that gets checked

Reading class names out of `className`, template literals and `cn()` calls is what the existing
AST helpers in `src/testing/guards/ast.ts` already do. The guard adds a separate `STYLE_EXTENSIONS`
list for stylesheets and passes it to `collectSourceFiles`, leaving `SOURCE_EXTENSIONS` as the
TypeScript list the other two guards read.

**Rollout**: single migration, in slice 1. The token layer lands, the popup is rebuilt against it, and
the old utilities, the dead rules and the font contradiction are deleted in the same pass. The two
looks never coexist, the same rule spec 0001 applies to the old detection pipeline.

**Exceptions**:

- Under `src/components/ui/` the primitives stay exactly as the shadcn CLI generates them, per
  `AGENTS.md`. Even there, colours come from the token names above.
- Literal colour values are allowed in test fixtures and in contrast measurement scripts, which need
  raw values to test against. The guard skips test files for that reason.
- No exception for app code. A raw colour utility in `src/App.tsx` is wrong, not a special case.

## Tokens

Near monochrome. Neutral greys carry the whole interface; the single hue is destructive red. Every
ratio below was computed from the oklch values through sRGB, with alpha composited in device space
before the luminance was taken, because the primitives render `--ring` at 50% and `--border` was
originally written as a 10% alpha value that no boundary would have been visible through.

**Surfaces and fills**

| Token | Value | Role | Measured |
|---|---|---|---|
| `--background` | `oklch(0.145 0 0)` | popup background | the reference surface |
| `--card` | `oklch(0.22 0 0)` | raised panels: empty state, notice, menus | 1.15:1 against background |
| `--muted` | `oklch(0.28 0 0)` | scroll area, hover fill, and the skeleton fill | 1.18:1 against card, so `bg-muted/50` is a real hover |

`--card` sits 1.15:1 above `--background`. That is far too little to carry a boundary, which is why
**rows carry no fill at all**: the separator and the text carry the hierarchy. A raised panel always
pairs `--card` with `--border`.

**Text**, all measured against background / card

| Token | Value | On background | On card | Role |
|---|---|---|---|---|
| `--foreground` | `oklch(0.96 0 0)` | 17.68:1 | 15.39:1 | titles, primary text |
| `--muted-foreground` | `oklch(0.72 0 0)` | 7.94:1 | 6.91:1 | secondary text, icons |
| `--subtle-foreground` | `oklch(0.65 0 0)` | 6.12:1 | 5.33:1 | metadata, the floor |

The faintest grey that still clears 4.5:1 on `--card` is `L=0.61`, so `--subtle-foreground` at `0.65`
is the floor for any enabled text. Below that it is only legal on disabled controls, which WCAG exempts
from the contrast requirement.

**Lines**

| Token | Value | Measured | Role |
|---|---|---|---|
| `--border` | `oklch(0.34 0 0)` | 1.47:1 on card, 1.69:1 on background | row separator, panel edge |
| `--input` | `oklch(0.55 0 0)` | 3.53:1 on card, full opacity | control boundary |
| `--ring` | `oklch(0.78 0 0)` | 3.14:1 on card, 3.20:1 on background, at the 50% the primitives render | focus ring |

`--border` is a solid value, not an alpha, so a separator is actually visible; at 10% white it measured
1.32:1, which is not an edge. `--input` clears the 3:1 bar at full opacity for control boundaries, and
its `bg-input/30` and `bg-input/50` uses are decorative at 1.82:1. `--ring` is set where the
composited 50% ring clears 3:1 on both surfaces, not where the raw token would: at `oklch(0.62 0 0)`
the rendered ring measures 2.16:1 and fails.

**Actions**

| Token | Value | Measured | Role |
|---|---|---|---|
| `--primary` | `oklch(0.94 0 0)` | light surface | the one action surface |
| `--primary-foreground` | `oklch(0.2 0 0)` | 15.18:1 on primary | label on it |
| `--secondary` | `oklch(0.32 0 0)` | neutral fill | secondary button, badge |
| `--secondary-foreground` | `oklch(0.96 0 0)` | 11.29:1 on secondary | label on it |
| `--destructive` | `oklch(0.704 0.191 22.216)` | 6.86:1 on background | the only hue |

The primary action is an inversion: a light surface with dark text, the only high contrast element in
a resting row. `--destructive` at `/20` and `/40` is decorative ring and fill only, 1.9:1 or lower.

Rules:

- Changing a surface invalidates every measured number in this section. Re-measure before shipping.
- If a generated primitive later needs `--popover`, `--accent` or a chart token, restore it from the
  shadcn token list rather than inventing a value.

## Typography and spacing

One family: Geist Variable, which is already imported and already rendering. Delete the `Inter`
declaration. Keep `--font-heading`, because the generated card title uses `font-heading`.

| Element | Size | Weight | Colour |
|---|---|---|---|
| Row title | `text-sm` (14px) | `font-medium` | `--foreground` |
| Row metadata | `text-xs` (12px) | normal | `--subtle-foreground` |
| Section heading | `text-xs` | `font-medium`, uppercase, tracking | `--muted-foreground` |
| Popup title | `text-sm` | `font-semibold` | `--foreground` |
| Empty and error copy | `text-sm` | normal | `--muted-foreground` |

No custom size scale. Tailwind's `text-xs` and `text-sm` cover the popup, and this replaces the
`text-[9px]` and `text-[10px]` arbitrary sizes now in use, which are below both the legibility floor
and Tailwind's scale.

| Measure | Value | Reason |
|---|---|---|
| Popup width | `w-[420px]`, unchanged | already fits the longest row |
| Popup height | `min-h-[520px] max-h-[600px]` | unchanged |
| Row height | `min-h-10` (40px) | six to seven rows visible, comfortable pointer target |
| Icon control | `h-8 w-8` (32px), the size already in use | clears WCAG 2.2 SC 2.5.8 at 24 by 24 CSS pixels |
| Popup padding | `p-3` | one value, every edge |
| Icon to text gap | `gap-3` | one value |

## Components

Keep as generated (`src/components/ui/`). A component shadcn has is added through the shadcn skill, so
the radix nova style holds. One it does not have is written as a composition under `src/components/`,
built from the primitives and tokens above. Each entry states the guarantee it carries, which is what
makes this a standard rather than an inventory.

| Component | Status | Guarantee |
|---|---|---|
| `button` | exists | variants `default`, `ghost`, `outline`, `destructive`; `size="icon"` is 32px; an icon only button requires `aria-label` |
| `card` | exists | `bg-card` with `--border`, never alone; its footer hover resolves to `--muted` |
| `badge` | exists | never the only carrier of a record's type or state |
| `scroll-area` | exists | rows keep their height while scrolling, no layout shift on a state change |
| `skeleton` | new | used for the poll, one shape per row, never a spinner over a list that has rows |
| `empty-state` | new | nothing matched on a `ready` record; `observing` is skeleton rows and never this. The caller supplies the icon, title and description |
| `notice` | new | a `blocked` or `unsupported` page, or an `interrupted` download; `variant="destructive"` is the only coloured one. The caller supplies the icon, title and description |
| `progress` | new | determinate from real bytes, `totalBytes <= 0` being the only indeterminate case, never a faked 30%. The fill is `--muted-foreground`, never `--primary`, so a row in flight is never brighter than the action |
| `tooltip` | new | supplementary only, never the accessible name for an icon only control |
| `switch` | deferred | options page; label and current state visible without colour |
| `select` | deferred | options page, for quality and format |
| `alert-dialog` | deferred | confirms a destructive or overwriting action, focus trapped, cancel holds focus |

The three marked `deferred` are specified now so the look is decided, and are generated when the
feature that needs them lands: the options page (feature 12), and the overwrite case in a later slice.

## States

Two vocabularies, not one. The engine spec sets a record's status, and a download reports its own
progress; they are separate and a record can be `ready` with nothing in it.

**Record status**, `TabMedia.status`, exactly as spec 0001 defines it:

| Status | Treatment | Icon | Label |
|---|---|---|---|
| `observing` | skeleton rows, the watch is running | none | `Watching this page` |
| `ready` with entries | the resting list | per media type | `Ready` |
| `ready` with no entries | empty state, nothing matched here | `Search` | `No media found on this page` |
| `blocked` | `notice`, phrased as the page refusing access | `ShieldAlert` | `This page blocks access` |
| `unsupported` | `notice`, this tab cannot be watched at all | `TriangleAlert` | `This page cannot be watched` |

**Download status**, `DownloadStatus.state`, which the popup needs pinned to a union. It is declared
`state: string` in `src/lib/schemas.ts` and the running values are `in_progress`, `complete` and
`interrupted`:

| State | Treatment | Icon | Label |
|---|---|---|---|
| `in_progress` | the download control is replaced by determinate progress from real bytes, row height unchanged. `totalBytes <= 0` is the indeterminate case; otherwise `Math.round(bytesReceived / totalBytes * 100)` clamped to 100, and that one string is both the visible label and the progress element's accessible value, so the number a person reads and the number a screen reader hears cannot disagree | none | `Downloading 62%` |
| `complete` | the control becomes a done affordance, and the text states the outcome | `Check` | `Saved` |
| `interrupted` | `notice`, the transfer stopped and nothing was written | `TriangleAlert` | `Download interrupted` |

**Three displays spec 0001 assigns here.** Spec 0001 named all three as this feature's job and
sourced none of them, so they are sourced here rather than left to the build. `hiddenCount` is a
field this correction added to
[spec 0001](../0001-detection-engine-architecture/0001-state-store.md), which had no value for it.

| Display | Source | Treatment | Token and size |
|---|---|---|---|
| Hidden count | `TabMedia.hiddenCount` | one line under the list, `Showing 50 of 62 found`, shown only when the count is above zero | `text-xs` in `--subtle-foreground` |
| Staleness | `TabMedia.updatedAt` | `Updated 12s ago` beside the list, whole seconds under a minute, then minutes, then hours, refreshed by the poll that already runs | `text-xs` in `--subtle-foreground` |
| Loading hint | a decided wait, not a data value | after three seconds of `observing`, matching the poll interval, one line under the skeletons | `text-xs` in `--muted-foreground` |

The caller owns the copy in both compositions, and the description is always `text-sm` in
`--muted-foreground`, which is the Empty and error copy row of the typography table above.

Media type is carried the same way: `Film` for video, `Music` for audio, with the word in the row's
accessible name. Colour never distinguishes a video from an audio track, because a user who cannot
separate the hues must still tell them apart.

Four whole popup states, none of which the popup has today: **loading**, skeleton rows during the
poll. **Empty**, the `ready` with no entries case above. **Error**, a `blocked` or `unsupported`
notice. **Ready**, the resting list.

## Accessibility bar

Measured numbers, not aspirations. Each is a threshold the design clears.

| Requirement | Threshold | Source |
|---|---|---|
| Body text | 4.5:1 against its surface | WCAG 2.2 SC 1.4.3 AA |
| Large text, 24px or about 18.7px bold | 3:1 | WCAG 2.2 SC 1.4.3 AA |
| Control boundaries, states, focus ring | 3:1 against adjacent colour | WCAG 2.2 SC 1.4.11 AA |
| Pointer target | at least 24 by 24 CSS pixels | WCAG 2.2 SC 2.5.8 AA, new in 2.2 |
| Meaning never by colour alone | required | WCAG 2.2 SC 1.4.1 |
| Focus visible on keyboard | required; an author supplied ring must clear 3:1 | WCAG 2.2 SC 2.4.7 and 1.4.11 |

Rules that follow:

- Measure the rendered value, never the token. `--ring` passes at 3.14:1 only because it was chosen
  for the 50% alpha the primitives actually render.
- Never `outline: none` without a replacement ring. A browser's own focus ring is exempt from the
  contrast requirement but must still be visible, so leaving it is the simplest correct choice.
- Keyboard order follows visual order, and nothing is reachable that cannot be seen when focused.
- Disabled controls are exempt from the 4.5:1 rule. That exemption is the only reason a lower
  contrast grey is acceptable anywhere, and it never applies to enabled content.
- Every interactive element has an accessible name. An icon is not a name.

## Motion rules

Motion explains a change. It never decorates. The popup is small and opened repeatedly, so anything
looping becomes noise.

- **The setting is honoured at both layers.** `<MotionConfig reducedMotion="user">` wraps the popup,
  which covers every `motion/react` animation: the row entrance, the exit, the stagger and the
  progress tween. The Tailwind `motion-reduce:` and `motion-safe:` variants cover CSS transitions on
  components. Neither layer substitutes for the other, because `motion-reduce:` cannot gate a
  `motion.div`.
- **No infinite animations.** The ten second logo spin and the three second glow pulse are deleted.
  No looping animation remains in the popup.
- Durations: 100ms for a state change on an existing element, 150ms for something entering or
  leaving, and nothing over 200ms.
- Entrances ease out, exits ease in. No bounce, no overshoot, no spring on a list. The current
  `type: 'spring', bounce: 0` progress tween becomes a duration.
- Under reduced motion, transitions collapse to an instant state change and nothing translates. A row
  still appears; it just does not travel.
- Skeletons shimmer only under `motion-safe:`.

## Build plan

Part A is this feature's own work. Part B is the popup rebuild, owned by slice 1 and tracked here so
the contract is in one place.

1. [x] Rewrite the token layer: add the namespace reset, move the dark values onto `:root`, set every
   value in the token tables, map each in `@theme inline`, keep the four imports, `--font-heading`,
   `--custom-variant dark` and the `*` base reset, satisfies **AC-1**, **AC-3**, **AC-4**, **AC-5**,
   **AC-6**, **AC-12**
2. [x] Add the guard test, with a separate `STYLE_EXTENSIONS` list passed to `collectSourceFiles` so
   the stylesheet is scanned without changing what the other guards read, matching the specified set,
   satisfies **AC-2**
3. [x] Delete the dead rules and the contradiction: `.vortex-gradient`, `.glass`, the `.dark` block, the
   `Inter` declaration, satisfies **AC-12**
4. [x] Add the components the popup needs now: `skeleton`, `progress` and `tooltip` generated through the
   shadcn skill, and `empty-state` and `notice` written as compositions under `src/components/`.
   `switch`, `select` and `alert-dialog` stay named in the Components section and are generated by the
   features that need them. Then change the `progress` fill from `--primary` to `--muted-foreground`,
   so the action stays the only bright element in a resting row, satisfies **AC-11**, **AC-5**
5. [ ] Slice 1: rebuild the popup on the language, with rows at `min-h-10`, `h-8 w-8` controls carrying
   accessible names, and the old utilities deleted, satisfies **AC-9**
6. [ ] Slice 1: render both state vocabularies, pin `DownloadStatus.state` to a union in
   `src/lib/schemas.ts`, and build the three displays this spec now sources: the hidden count from
   `hiddenCount`, the staleness line from `updatedAt`, and the hint after the stated wait, satisfies
   **AC-7**, **AC-10**
7. [x] Add `<MotionConfig reducedMotion="user">`, delete the two infinite animations, and convert the
   spring tween to a duration. Done under feature 4 rather than slice 1, because `/check verify`
   found AC-8 failing at runtime and AC-8 is this feature's criterion. Three `animate-spin` loaders
   the task did not name were gated with `motion-safe:` as well, since the rule it states, that no
   looping animation remains, covers them, satisfies **AC-8**

## Consequences

**Positive**:

- One way to build a screen, so a value is chosen once and reused instead of retyped.
- No white flash, and no dark palette that depends on a class nobody sets.
- Contrast is measured as rendered and pinned, so it does not quietly regress when a token moves.
- The guard test makes the standard self enforcing, and it gates the build.
- The reset means a raw colour utility cannot quietly come back and look right.
- Motion respects the operating system setting at both the CSS and the Motion layer, and the popup
  stops moving on its own.
- shadcn primitives and future `shadcn add` calls keep working, because the token vocabulary is
  unchanged.

**Negative / tradeoffs**:

- Slice 1 absorbs the token layer, the component work and the popup rebuild, so the tracer bullet
  gets bigger and the first demo arrives later.
- The reset fails silently. A raw colour utility builds fine and then does nothing, so the guard test
  is load bearing rather than redundant. Without it this standard is a trap.
- The reset does not stop arbitrary values or gradient stops, so the guard has to carry three cases
  the reset cannot, and a future arbitrary colour outside its match set would slip through.
- Rows carry no fill, so a row looks less like a card. That is a real look choice forced by a 1.15:1
  surface step, and it suits a dense list.
- Deleting `--popover`, `--sidebar*` and `--chart-*` means a shadcn component referencing one breaks
  when added later. Restore from the shadcn token list rather than inventing a value.
- No light mode yet, so a user with a light preference gets a dark popup.

**Neutral**:

- Dark is unconditional, so `dark:` variant utilities never fire. A component that would want one
  states the dark value directly.
- Light mode later is a new `:root` block plus the `@custom-variant dark` declaration, and the whole
  measured table has to be recomputed for the new surfaces.
- Every measured number here depends on the surface values.

## Follow-up

- [ ] Re-check the six running popup criteria after slice 1 replaces the popup, so a criterion cannot
  pass by accident against a screen that is about to be rewritten.
- [ ] `/check verify` for this spec re-measures the token table against the built CSS, rather than
  trusting the numbers recorded here, and walks the popup by keyboard.
- [ ] Switch, select and alert dialog are generated through the shadcn skill when the options page
  (feature 12) and the overwrite case land.
- [ ] `DownloadStatus.state` is typed `string` in `src/lib/schemas.ts`. Pinning it to a union is part
  of task 6; until then the states table above is the only definition of it.
- [ ] `AGENTS.md` carries the superseded dark popup line. `/sync` replaces it once this spec is
  accepted.
- [ ] The shadcn CLI in this project misreads `components.json`, whose `utils` alias is
  `@/lib/utils`: it writes `import { cn } from "cn"` and adds a junk `cn` dependency to
  `package.json`. Every primitive it generates here needs its import repointed by hand, and the
  `package.json` change reverted. Worth fixing before the next `shadcn add`, and worth a line in
  `src/AGENTS.md` via `/sync`.