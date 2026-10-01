# Verify: Popup design language · spec 0003 · updated 2026-10-01

_Steps derived from spec 0003 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

Each acceptance criterion carries a register tag in the spec, `artefact`, `running popup` or
`document`. The Commands below cover the artefact ones, the manual steps cover the running popup ones,
and AC-7 needs neither, since the proof is that the spec states a sourced design. A criterion tagged
`document` is met by reading the spec; do not report it as unimplemented because no code renders it.

How these were exercised, on 2026-10-01: every Command step was run in this repo. The manual steps were
exercised by serving the real `dist/` build over HTTP and driving it in headless Chrome with the
extension API stubbed before page scripts, then reading computed styles out of the live page. That
gives real rendered evidence, stronger than eyeballing, but it is not the same as loading `dist/` as
an unpacked extension, so it does not exercise the real service worker or content script. Neither is in
scope here, since this spec governs a design language rather than detection or download wiring.

## Commands

- [x] `npm run build` → type check, suite and bundle all pass, 148 tests → AC-1, AC-2, AC-12
- [x] `npm test` → the design token guard reports zero violations on the real `src` tree → AC-2
- [x] add `bg-slate-800` to any class in `src/App.tsx`, then `npm test` → fails naming the file and
      the class; revert afterwards → AC-2
- [x] add `shadow-[0_0_15px_rgba(168,85,247,0.2)]` to any class in `src/App.tsx`, then `npm test` →
      fails naming the file, because the namespace reset alone would not have caught it; revert
      afterwards → AC-2
- [x] `grep -oE "\.(accent|bg|border|caret|decoration|divide|fill|from|outline|placeholder|ring|shadow|stroke|text|to|via)-(slate|purple|blue|red|emerald)-[0-9]+" dist/assets/*.css`
      → no output, so no default colour utility survives the build across every prefix the guard
      knows about, not a subset of them → AC-1
- [x] `grep -oE "body\{[^}]*\}" dist/assets/*.css` → `background-color:var(--background)` and
      `color:var(--foreground)`, never a raw `hsl()` that cannot resolve an `oklch` value → AC-3
- [x] `grep -oE "\-\-background:[^;}]*" dist/assets/*.css` → the dark value, `oklch(14.5% 0 0)` → AC-3
- [x] `grep -c "vortex-gradient\|glass" dist/assets/*.css` and the same in `src/index.css` → zero in
      both, and no `.dark` token block and no `Inter` declaration remain → AC-12
- [x] `ls src/components/ui/skeleton.tsx src/components/ui/progress.tsx src/components/ui/tooltip.tsx src/components/empty-state.tsx src/components/notice.tsx`
      → all five present → AC-11
- [x] `grep -rn "from \"cn\"" src/` → no output, and `grep -c '"cn"' package.json` → zero, so the shadcn
      CLI's bad import and its junk dependency have not come back → AC-11, AC-12
- [x] `npx eslint src/components/empty-state.tsx src/components/notice.tsx src/components/ui/skeleton.tsx src/components/ui/progress.tsx src/components/ui/tooltip.tsx src/testing/guards/design-tokens.ts`
      → no errors, so the new files add nothing to the 12 pre-existing project lint errors

## UI / manual

Needs a browser: build, then load `dist/` through `chrome://extensions` with developer mode on.

- [x] open the popup on any page → the very first paint is the dark surface, no white flash before it
      → AC-3
- [x] look at the whole popup → every surface, icon, border and label resolves; nothing is invisible,
      unstyled, or left as browser default styling → AC-4
- [x] look at the list → greys only, with the single destructive red nowhere on a resting row; the
      purple and blue accents are gone → AC-5
- [x] compare a row's text against its surface → the ratio matches the spec's measured tables: 17.68:1
      foreground on background, 7.94:1 muted, 6.12:1 subtle, and nothing enabled below the 4.5:1 floor
      → AC-6
- [x] tab through the popup → a visible focus ring on every control, and no control is reachable that
      cannot be seen when focused → AC-6
- [x] check the scrollbar thumb and the two icon only buttons → both resolve from `--border` and
      `--ring` rather than an undefined utility → AC-4
- [x] set the operating system to reduce motion, then open the popup → no looping movement; the
      remaining infinite animations belong to slice 1 and are listed under Deferred → AC-8
- [x] look at an audio row beside a video row → the Film and Music icons and the words distinguish
      them, with no colour doing the work → AC-10

## Still slice 1's, and none of it blocks this spec

- Build plan task 5, rows carrying no fill and the `min-h-10` and `h-8 w-8` classes. The criteria are
  met without them: rows measured 88px against a 40 minimum and controls 32 by 32 against a 24
  minimum, so the rebuild only has to keep meeting the numbers.
- Build plan task 6, rendering both state vocabularies and the three displays. AC-7 is a document
  criterion and is met by the States tables, not by code that renders them.
- Re-measure the token table against a light surface, if a light theme is ever added.

## Acceptance-criteria coverage

All twelve met on 2026-10-01. Registers as tagged in the spec.

- AC-1 artefact · command 5: no default colour utility survives the build, across all 27 palette
  families and 15 prefixes
- AC-2 artefact · commands 1 to 4: the guard is green on the real tree and turns red on both an
  injected palette step and an injected literal `rgba()`
- AC-3 running popup · commands 6 and 7 plus the manual paint check: computed body background
  `oklch(0.145 0 0)` in all seven scenarios, no white in any frame
- AC-4 running popup · the primitive token audit plus the rendering and scrollbar checks: 14 colour
  tokens referenced by the generated primitives, every one defined; nothing invisible or blank
- AC-5 running popup · the greys only check: zero hues in every resting state, and exactly one,
  `rgb(255, 100, 103)`, only on an interrupted download
- AC-6 running popup · the ratio and keyboard checks: 16 text nodes measured, none below threshold,
  lowest 4.50:1, and a focus ring on all four controls
- AC-7 document · the States tables: five record statuses and three download states each with a
  treatment and a label, three displays each with a named source, vocabulary matching spec 0001
- AC-8 running popup · the reduced motion check: no animation and identical frames under reduce; the
  two gated spinners still run when motion is welcome
- AC-9 running popup · row height, control size and accessible names: 88px rows, 32 by 32 controls,
  every icon only control named
- AC-10 running popup · the audio beside video check: Film and Music icons, the section words, and
  the type carried in each accessible name
- AC-11 artefact · commands 8 and 9: the five components present, no stray `from "cn"`, no junk
  dependency, lint clean
- AC-12 artefact · commands 1 and 9 plus the first paint: no dead rules, one typeface, the imports
  and base reset intact

Re-check the six running popup criteria after slice 1 replaces the popup, so none of them passes by
accident against a screen that is about to be rewritten.
