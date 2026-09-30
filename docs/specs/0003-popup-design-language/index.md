# 0003. Popup design language

**Date**: 2026-09-30
**Status**: Proposed

## Summary

The popup gets one right way to look: a small set of colour, type and spacing tokens, a
fixed set of components, and a stated accessibility and motion bar. It is dark, nearly
monochrome, and quiet, with colour reserved for actions. Those tokens replace the
hardcoded values in the popup today, and a build level removal plus a test stop them
coming back. The popup itself is rebuilt on this language in slice 1, where the old look
is deleted rather than kept alongside it.

## Standard definition

**Canonical pattern**:

```css
/* src/index.css */

/* Removes every default colour utility, so `bg-slate-950` stops existing.
   Verified on tailwindcss 4.2.4: the default utility is gone from the built
   CSS and a custom token utility still compiles. */
@theme {
  --color-*: initial;
}

@theme inline {
  --font-sans: 'Geist Variable', sans-serif;
  --color-surface-base: var(--surface-base);
  --color-surface-raised: var(--surface-raised);
  --color-text-primary: var(--text-primary);
  --color-text-secondary: var(--text-secondary);
  --color-text-tertiary: var(--text-tertiary);
  --color-border-subtle: var(--border-subtle);
  --color-border-control: var(--border-control);
  --color-ring: var(--ring);
  --color-accent-action: var(--accent-action);
  --color-destructive: var(--destructive);
}

/* Dark is the only theme, but the values live under a selector rather than
   hardcoded on the utility, so a light `:root` block can be added later. */
:root,
.dark {
  --surface-base: oklch(0.145 0 0);
  --surface-raised: oklch(0.205 0 0);
  --text-primary: oklch(0.985 0 0);
  --text-secondary: oklch(0.708 0 0);
  --text-tertiary: oklch(0.62 0 0);
  --border-subtle: oklch(1 0 0 / 10%);
  --border-control: oklch(0.62 0 0);
  --ring: oklch(0.62 0 0);
  --accent-action: /* one hue, decided at build */;
  --destructive: oklch(0.704 0.191 27);
}
```

```tsx
<li className="flex min-h-10 items-center gap-3 bg-surface-raised px-3 text-text-primary">
  <MediaIcon kind={media.kind} className="text-text-tertiary" />
  <span className="flex-1 truncate text-[13px]">{media.label}</span>
  <button
    className="focus-visible:ring-ring motion-safe:transition-colors"
    aria-label={`Download ${media.label}`}
  >
    <DownloadIcon aria-hidden />
  </button>
</li>
```

**Replaces**:

- Raw colour utilities in JSX: `bg-slate-950`, `text-purple-400`, `border-slate-800`
- Ad hoc hex or oklch literals written inside a component or an inline style
- The unused light `:root` token set being the effective theme, because nothing ever
  applies the `.dark` class
- The `.vortex-gradient` and `.glass` classes, which nothing references
- The `--font-sans: "Inter"` declaration, which is never loaded and is then overwritten
- Motion that loops forever: the infinite logo spin and the glow pulse
- Colour as the only signal for audio versus video

**Enforcement**: two layers, because either alone has a gap.

1. **Build, primary.** `--color-*: initial;` in `src/index.css` removes the whole
   default colour namespace, so a raw colour utility has no generated CSS behind it.
2. **Test, load bearing.** A source walking guard in `src/testing/guards/` fails on any
   raw colour utility, in the same shape as the two guards already there. It is not belt
   and braces: an unknown utility is dropped **silently** and the build still succeeds, so
   without the test a mistaken colour class ships as an unstyled element rather than a
   failure.

Both run under `npm test`, which gates `npm run build`.

**Rollout**: slice 1 rebuilds the popup on this language and deletes the old look in the
same pass. The two never coexist, the same rule spec 0001 applies to the old pipeline.

**Exceptions**: none. The options page in feature 12 inherits these same tokens.

## Tokens

Contrast measured from the oklch values, not estimated. AA needs 4.5:1 for body text and
3:1 for large text and for non text.

| Token | Value | On base | On raised | Bar |
|---|---|---|---|---|
| `surface-base` | `oklch(0.145 0 0)` |  |  | popup background |
| `surface-raised` | `oklch(0.205 0 0)` | 1.1:1 |  | rows and cards |
| `text-primary` | `oklch(0.985 0 0)` | 18.96:1 | 17.16:1 | body |
| `text-secondary` | `oklch(0.708 0 0)` | 7.63:1 | 6.91:1 | body, secondary |
| `text-tertiary` | `oklch(0.62 0 0)` | 5.44:1 | 4.92:1 | body, metadata |
| `text-disabled` | `oklch(0.4 0 0)` | 2.15:1 |  | exempt, disabled control |
| `border-control`, `ring` | `oklch(0.62 0 0)` | 5.44:1 | 4.92:1 | non text, needs 3:1 |
| `destructive` | `oklch(0.704 0.191 27)` | 6.86:1 | 6.21:1 | the one semantic colour |

Rules the numbers imply:

- **No text token below lightness 0.62.** At 0.55 the ratio is 4.08:1 on base and 3.69:1
  on raised, which fails body text on both.
- `text-disabled` is exempt from the contrast minimum as a disabled control, and is
  recorded here so a later pass does not read 2.15:1 as a bug and "fix" it.
- `surface-raised` sits only 1.1:1 above `surface-base`. A boundary must never rely on the
  surface step alone to be perceivable; it comes from `border-subtle` or from content.
- `border-subtle` is decorative and has no minimum. Anything that is an interactive
  control boundary uses `border-control` at 3:1 or better.
- `accent-action` is the only other chromatic token, and appears only on the primary
  action. Hue is not yet named.

## Typography and spacing

- Geist Variable only. The `Inter` declaration is deleted, which also removes the
  contradiction in the token layer.
- Three sizes: 13px row title, 12px secondary and metadata, 11px uppercase section label
  with wide tracking.
- 4px spacing base. Popup padding 12px, row horizontal padding 12px, row gap 8px, section
  gap 16px.
- Row height is 40px. That shows six or seven streams without scrolling, and it clears the
  24 by 24 CSS pixel minimum from WCAG 2.2 for every row control.

## Components

Existing four, restyled onto tokens: badge, button, card, scroll area.

Added, through the shadcn skill or CLI so the radix-nova style holds:

| Component | Why it is needed |
|---|---|
| Skeleton | the popup polls every 3s and currently shows a bare spinner |
| Empty state | nothing detected yet, and nothing to act on |
| Notice | the page cannot be read, or a download failed |
| Progress bar | replaces a motion div that fakes 30% when size is unknown |
| Switch, select | the options page in feature 12 |
| Tooltip | the popup has icon only buttons |
| Confirm dialog | replacing a file that already exists |

Every new primitive is added through shadcn, not hand written, so the generated style
survives an `shadcn add` later.

## States

The engine already models four record statuses, and the popup has to tell them apart
honestly.

- **Loading**: skeleton rows matching the real row height, so nothing jumps on arrival.
- **Empty**: nothing detected, with the one thing the person can do about it.
- **Partial**: some extractors ran and some did not. Says which, never a clean "nothing
  found".
- **Unsupported**: the page is not a media page, or no extractor matched.
- **Error**: the page cannot be read at all, distinguished from "no media here".
- **Progress**: determinate when the size is known, indeterminate when it is not, with
  text and `aria` carrying the state either way.

## Accessibility bar

- Body text 4.5:1. Large text 3:1, where large is 18pt (24px) or 14pt bold (about 18.7px).
- Non text 3:1, covering control boundaries and states, graphical objects, and an author
  supplied focus indicator. A UA default focus ring is exempt from the ratio but must
  stay visible.
- Never `outline: none` without a replacement. That is a known failure of 1.4.11.
- Focus must not be obscured by anything that moves over it (2.4.11).
- Every control reachable and operable by keyboard. Escape closes the dialog and focus
  returns to the trigger.
- Every icon only control carries an accessible name. A tooltip is an addition, never
  the name.

## Motion rules

- Nothing loops forever. The logo spin and the glow pulse are removed.
- Transitions at or under 150ms, easing only, no springs on a list that scrolls under the
  pointer.
- Every animation sits behind Tailwind's `motion-safe:` variant so
  `prefers-reduced-motion: reduce` is honoured by the framework rather than by hand.
- Motion that carries state, which is progress and download feedback, has a non motion
  equivalent in text and `aria`.

## Consequences

**Positive**:

- One look, enforced at build and at test, instead of 58 hardcoded values across 17.
- No white flash on open: the base layer paints from `surface-base` rather than a
  hardcoded utility over an unused light `:root`.
- The accessibility bar is measurable, since every token ships with its ratio.

**Negative / tradeoffs**:

- Slice 1 grows. The token layer, eight new primitives, the guard, and a full popup
  rewrite land together.
- The popup's entire current look is thrown away, including the pieces that work.
- Because the build drops an unknown utility silently, the guard is load bearing rather
  than a convenience, and a broken guard means a silently unstyled UI.

**Neutral**:

- `--color-*: initial` also removes the chart, sidebar and standard shadcn colour tokens.
  The popup uses none of them; the options page is rechecked when it is built.
- The existing `.dark` token block is already near monochrome, so the direction chosen is
  mostly already in the repo and merely disconnected.

## Follow-up

- [ ] Name the `accent-action` hue, still open.
- [ ] Decide whether the token layer, the eight primitives and the guard are built under
      feature 4 or inside slice 1. Recommended: feature 4 owns them, slice 1 consumes.
- [ ] Recheck the tokens for the options page in feature 12.
- [ ] `npm run lint` still fails with 12 pre-existing errors, none of them in this work.
- [ ] `LICENSE` is still undecided.

## Rationale

The reasoning, the options weighed, and the measured evidence are in
[rationale.md](rationale.md). Status `Proposed`: this is a decision record, and it becomes
`Accepted` when the engineer ratifies it rather than when something is built.
