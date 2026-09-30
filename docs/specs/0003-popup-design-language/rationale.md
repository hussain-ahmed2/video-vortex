# 0003 rationale. Popup design language

## Context

The popup is a 420 pixel surface that people open while a video plays, look at for two
seconds, and click. It has no designer, no reference design, and no written rules, so every
change has been made by reaching for a value that looked right in the file being edited.
The result is 58 hardcoded colour utilities across 17 distinct values in a single
component, next to a token layer that is not connected to any of them.

The token layer is in worse shape than simply being unused. `:root` holds light values, a
separate `.dark` block holds a near monochrome dark set, and nothing ever applies the
`.dark` class, so `body` resolves `bg-background` to white and the popup only looks dark
because `App.tsx` paints `bg-slate-950` over the top. The dark set is the better half of
the token layer and is entirely dead code. A declared `--font-sans: "Inter"` is never
loaded and is then overwritten by Geist one block later. `.vortex-gradient` and `.glass`
are referenced by nothing. No reduced motion handling exists, and the logo spins forever.

Three forces shaped the answer. The popup is dense, so a large type scale and generous
spacing would push streams below the fold. It is a utility people open in a hurry, so
colour that means nothing is noise. And it is a download tool, so the words "audio" and
"video" have to survive greyscale, in bright sun, and for anyone who cannot separate the
hues anyway.

## Options considered

### Enforcement

**Namespace removal plus a source walking test, the one right way.** A build level
`--color-*: initial` makes a raw colour utility stop existing, and a test fails on the
source before that happens. Strongest available, because the removal is enforced by the
build and the test covers the gap the removal leaves.

*Pros*: the wrong value cannot be expressed, and the silent failure mode is covered.
*Cons*: two mechanisms to keep, and the guard has to be maintained.

**Documentation only.** The rules go in `AGENTS.md` and review catches violations.
*Pros*: nothing to build.
*Cons*: review is exactly what did not stop 58 hardcoded values. It decays the first time
someone is in a hurry.

**An ESLint plugin.** Real enforcement, reads JSX class strings directly.
*Pros*: precise, and reports at the offending line.
*Cons*: a new dependency and config surface for one rule, and no core rule can see inside
a `className` string.

### Rollout

**Slice 1 rebuilds the popup, old look deleted.** One migration, no coexistence.
*Pros*: matches the tracer bullet rule already set by spec 0001 for the old pipeline, and
never leaves the repo with two looks.
*Cons*: slice 1 absorbs the token layer, eight primitives, the guard and a rewrite.

**Language now, popup restyled later.** Nothing blocks, but two looks are alive at once
and a half migrated popup can sit indefinitely.
*Pros*: smaller slices.
*Cons*: the migration has no owner and no deadline.

**Tokens only, migrate whenever.** *Pros*: least work now. *Cons*: no deadline means no
migration.

### Typeface

**Keep Geist Variable.** Already a dependency, already loaded, already rendering, and a
variable font so weight costs nothing.
*Pros*: the current look is preserved, the dead Inter declaration goes.
*Cons*: a webfont is still a webfont.

**Switch to Inter.** Makes the existing declaration true, but Inter is not installed and
would need adding, for no visible gain.
*Pros*: one less contradiction. *Cons*: a new dependency and font swap.

**System stack only.** Smallest popup, no flash, and a different look per platform.
*Pros*: smallest, fastest. *Cons*: the "one look" goal gives up a dimension.

### Component set

**The four states plus the options page controls, tooltips and a confirm dialog.** The
scope's own done condition names loading, empty and error; the engine already produces
four record statuses; and the popup has icon only buttons and a download that can
overwrite.

*Pros*: the missing pieces are named and added while the rules that govern them are being
written, rather than picked by whoever needs them first.
*Cons*: eight primitives is real work, and the dialog and the options page controls have
no caller until features 12 and the download slice arrive.

**Ship only the four states.** The minimum the scope names.
*Pros*: smallest. *Cons*: the icon only buttons stay unexplained, and the options page
gets designed in a later feature with no rules to follow.

## Rationale

Enforcement came down to one fact: an unknown Tailwind utility is dropped silently and the
build still passes. That makes the namespace removal necessary but not sufficient, and
converts the test from a nice to have into the half of the pair that actually catches a
mistake. The two are cheap together, a build line and a guard in a harness that already
walks the AST, so there is no real case for either alone.

Rollout follows the precedent rather than inventing a new one. Spec 0001 settled that the
old pipeline is removed in the same pass that builds the new one, and letting the popup
keep a legacy look while the new language lands would contradict that within one project.
The honest cost is that slice 1 gets bigger, and the spec says so rather than hiding it.

The palette decision was nearly free because the answer was already in the repo. The
dead `.dark` block is pure greyscale, `oklch(L 0 0)` throughout, with exactly one
chromatic value, the destructive red. The direction chosen, near monochrome with colour
reserved for meaning, is what shadcn's dark neutral set already is. The work is
connecting it and deleting the light half, not designing something new.

The type scale and the 40 pixel row are the two numbers that fight each other and both
had to hold. Six or seven streams without scrolling sets a hard ceiling on row height,
and 40 pixels clears the 24 by 24 CSS pixel minimum that WCAG 2.2 added for target size
without any of the controls inside the row being exempt. There is no version of this that
is both comfortable and compliant that does not land on roughly this.

## Evidence

### The namespace removal, measured on the installed version

`tailwindcss 4.2.4` and `@tailwindcss/vite 4.2.4`, from `package-lock.json`.

| Step | Result |
|---|---|
| Baseline build, is `bg-slate-950` in the CSS | present |
| Add `--color-*: initial` to `@theme` | `bg-slate-950` absent from the built CSS |
| Also define a custom token, use `bg-vv-brand` | custom utility compiles, so the reset is not overzealous |
| Build exit status with the reset in place | succeeds |
| Any default colour utility anywhere in the output | none |

The build succeeding is the load bearing detail. The removal deletes the utility's CSS
without failing anything, so a mistaken `bg-slate-500` arrives as an element with no
background rather than as an error. Hence the guard.

### Contrast, computed from the oklch values

Converted oklch to linear sRGB, then to WCAG relative luminance, rather than eyeballed.

- `text-tertiary` at 0.62 is the floor: 5.44:1 on base, 4.92:1 on raised, both above 4.5.
- At 0.55 it is 4.08:1 and 3.69:1, failing body text on both surfaces. That is the
  measurement that sets the floor.
- `text-disabled` at 0.4 is 2.15:1, which is expected and exempt, since WCAG 1.4.3 does
  not apply to inactive controls.
- `border-control` and `ring` at 0.62 give 5.44:1 and 4.92:1 against a 3:1 non text
  requirement.
- `destructive` red gives 6.86:1 and 6.21:1.
- `surface-raised` against `surface-base` is 1.1:1, which is why the spec forbids relying
  on the surface step alone to mark a boundary.

### Corrected during research

Two things were wrong in the assumptions going in, and both changed the spec:

- The shadcn v4 setup expects a `.dark` **class**, not `prefers-color-scheme`. The
  scaffold's `@custom-variant dark` replaces Tailwind's media query default. So a light
  theme later is a new `:root` block plus the class, not a media query.
- WCAG 2.2's additions are wider than contrast. Target Size at Minimum (2.5.8, AA,
  24 by 24 CSS pixels) and Focus Not Obscured (2.4.11) are both AA and both bear directly
  on a dense list, which is why the row height is specified against 2.5.8.

## References

**Project sources** (verifiable, in this repo):

- `AGENTS.md`, the popup is dark by convention and hardcodes slate and purple
- `src/index.css`, the unused light `:root`, the dead `.dark` block, the Inter conflict
- `src/App.tsx`, 58 hardcoded colour utilities, the infinite logo and glow
- `src/lib/schemas.ts`, the four record statuses the state list must cover
- spec 0001, the rule that the old thing is deleted in the same pass
- `src/testing/guards/`, the shape the new guard follows
- `test-preferences.json`, Vitest and colocated tests
- `tailwind-v4-shadcn` (`.agents/skills/tailwind-v4-shadcn/`), Tailwind v4 CSS first tokens
- `motion-foundations`, `motion-patterns` (`.agents/skills/`), reduced motion and spring limits

**Practices & standards**:

- WCAG 2.2 AA, success criteria 1.4.3, 1.4.11, 2.4.11 and 2.5.8
- Tailwind CSS v4 `@theme` namespace removal with `--color-*: initial`
- shadcn/ui theming: tokens under `:root` and `.dark`, mapped by `@theme inline`
- OKLCH for perceptual lightness, so the contrast floor is one number rather than a guess
- Never signalling state with colour alone

**Links** (web verified during the landscape check):

- Understanding SC 1.4.3: Contrast (Minimum): https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
- Understanding SC 1.4.11: Non-text Contrast: https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html
- What's New in WCAG 2.2: https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/
- WCAG 2.2: https://www.w3.org/TR/WCAG22/
- Using CSS :focus-visible for keyboard focus indication: https://www.w3.org/WAI/WCAG22/Techniques/css/C45
- prefers-reduced-motion: https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion
- Theme variables (Tailwind CSS): https://tailwindcss.com/docs/theme
- Hover, focus, and other states (Tailwind CSS): https://tailwindcss.com/docs/hover-focus-and-other-states
- Theming (shadcn/ui): https://ui.shadcn.com/docs/theming
- Manual Installation (shadcn/ui): https://ui.shadcn.com/docs/installation/manual
- Dark mode (shadcn/ui): https://ui.shadcn.com/docs/dark-mode
