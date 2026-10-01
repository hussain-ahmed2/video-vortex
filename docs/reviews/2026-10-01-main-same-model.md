# Review, main, 2026-10-01

**Reviewed by**: space-bunny-free (author on space-bunny-free)
**Scope**: 25 files, uncommitted (10 tracked modifications, 15 new)
**Verdict**: Changes requested

## Summary

This is a good, unusually disciplined change. The token layer rewrite is faithful to the spec's
canonical pattern, the namespace reset genuinely deletes every default colour utility (I confirmed
across all 27 families and 15 prefixes in the built CSS), the guard's match set is well chosen, and
the contrast table in the spec reproduces to within 0.05 of every number I recomputed from the
oklch values. The verification work is real rather than asserted, and the reduced-motion test in
`src/main.test.ts` is a genuinely behavioural test: I removed `<MotionConfig>` and it goes red.

Four majors, none of them a wrong turn in the design, all of them things the author could not see
from inside their own work. Two are in the new `progress` primitive, which was never rendered once:
it emits invalid CSS above 100, renders an empty bar in the indeterminate case the spec names, and
its tween is the one animation in the change that neither motion layer covers. One is that the row
entrance and exit are still running on motion's default springs, which bounce, on a list the spec
says must not bounce, in the same component where the author converted the progress tween to a
duration citing that rule. One is that the design token guard, which the spec calls load bearing, is
blind to a colour written in an inline `style` object.

The docs are thorough to a fault in places: `verify.md` and `src/AGENTS.md` both now carry claims
that the change itself made false, and the spec justifies a hover token with a number that does not
support it.

## Major

### 🟠 Row entrance and exit run on motion's default springs, which overshoot, `src/App.tsx:300`

**Problem**: `StreamCard`'s `motion.div` at `src/App.tsx:300-305` declares
`initial={{ opacity: 0, y: 8 }}` / `animate={{ opacity: 1, y: 0 }}` with `transition={{ delay: idx * 0.03 }}`
and no duration or type. `exit={{ opacity: 0, scale: 0.95 }}` at line 303 is the same. Because
`delay` is an orchestration key, `isTransitionDefined` (`node_modules/motion-dom/dist/es/animation/utils/is-transition-defined.mjs`)
reports no transition, so `getDefaultTransition` applies. `y` and `scale` are both in
`transformProps`, so they get a spring: `underDampedSpring { stiffness: 500, damping: 25 }` for `y`
and `criticallyDampedSpring(0.95) { stiffness: 550, damping: 30 }` for `scale`. Those are damping
ratios of 0.559 and 0.640, both well under 1, so every row visibly overshoots its final position and
oscillates back. `opacity` gets the 0.3s keyframe ease, which is over the spec's 200ms ceiling. The
YouTube banner at `src/App.tsx:173-177` has the same shape with `y: -10` and the same 0.3s opacity
ease.

The spec's Motion rules are explicit: "Entrances ease out, exits ease in. **No bounce, no overshoot,
no spring on a list.**" and "Durations: 100ms for a state change on an existing element, 150ms for
something entering or leaving, and **nothing over 200ms**" (`docs/specs/0003-popup-design-language/index.md:432-434`).
The author applied exactly this rule 76 lines below, converting the progress tween from
`{ type: "spring", bounce: 0, duration: 0.3 }` to `{ duration: 0.15, ease: "easeOut" }` at
`src/App.tsx:380`, and left the springs on the list, which is where the rule is most pointed.
`rationale.md` has no entry on springs at all, so the rule was carried over unexamined.

**Why it matters**: The popup's only entrance animation is the thing a person sees every time they
open the popup, and it bounces. This is the single most visible motion defect in the change and it
is invisible in a jsdom test, which is why `/check verify` did not catch it.

**Suggested fix**: Give both `motion.div`s an explicit tween, the same shape as the one already on
the progress bar: an `easeOut` duration of about 0.15s for the entrance and `easeIn` for the exit.
This is a two-line change and it is squarely inside this feature, since AC-8 and the motion rules
are its own criteria.

### 🟠 Progress emits invalid CSS above 100 and renders nothing when indeterminate, `src/components/ui/progress.tsx:27`

**Problem**: `style={{ transform: \`translateX(-${100 - (value || 0)}%)\` }}` has no clamp and no
indeterminate branch. I rendered the component and read the markup:

| `value` | rendered indicator |
|---|---|
| `40` | `transform:translateX(-60%)` (correct) |
| `null` / `undefined` | `data-state="indeterminate"`, `transform:translateX(-100%)` |
| `0` | `transform:translateX(-100%)` |
| `100` | `transform:translateX(-0%)` |
| `140` | `transform:translateX(--40%)` |

Two defects. At `value: 140` the emitted declaration is not a valid transform, so the CSS parser
drops it and the indicator falls back to `size-full flex-1`, rendering **full width**: a bar
reading 100% complete. `bytesReceived` exceeding a reported `totalBytes` is reachable, because
`totalBytes` comes from the download's declared size while `bytesReceived` counts the whole
received body, and a redirect or a resumed transfer produces exactly that. The spec requires the
opposite: "otherwise `Math.round(bytesReceived / totalBytes * 100)` **clamped to 100**"
(`index.md:369`).

In the indeterminate case, which the spec names as the real one ("`totalBytes <= 0` being the only
indeterminate case", `index.md:339`), the indicator is pinned 100% off a track it shares the full
width of, and there is no `data-[state=indeterminate]:` rule anywhere in the class list. So an
in-flight download of unknown length renders a completely static empty bar: no fill, no movement,
and no `aria-valuenow` either, because Radix correctly omits it for indeterminate. The user's
experience is a grey line indistinguishable from a stalled transfer.

**Why it matters**: Both branches are wrong in the direction of lying to the user, which is the one
thing this design language exists to prevent. Neither is covered by a test:
`src/components/ui/progress.test.ts` asserts three class names and never renders a value or an
absence of one, so the suite is green with the component broken in both directions.

**Suggested fix**: Clamp the computed percentage into 0..100 before it reaches the style, and give
the indeterminate case a stated treatment, either a `data-[state=indeterminate]:` rule that sweeps
the indicator across the track under `motion-safe:` or an explicit decision in the spec that
indeterminate renders empty with the percentage carried in text (which is what the States table
already does for the visible label). Then add the two cases to `progress.test.ts`; they are two
`it` blocks and they fail today.

### 🟠 The progress tween is a CSS transition on `translateX` that no motion layer gates, `src/components/ui/progress.tsx:26`

**Problem**: The indicator carries `transition-all`, and the property being tweened is a transform.
That makes it a CSS transition, not a `motion/react` animation, so `<MotionConfig reducedMotion="user">`
cannot reach it, and it carries no `motion-safe:` or `motion-reduce:` variant. I grepped the built
stylesheet: the entire `prefers-reduced-motion` surface of this project is
`@media (prefers-reduced-motion:no-preference){.motion-safe\:animate-pulse,.motion-safe\:animate-spin}`
and one `motion-reduce\:opacity-100`. Every other transition in the popup, including this one, runs
at full duration for a user who has asked the OS to stop things moving.

The spec's Motion rules claim the opposite: "**The setting is honoured at both layers.** ...
The Tailwind `motion-reduce:` and `motion-safe:` variants cover CSS transitions on components"
(`index.md:424-428`). The author applied that rule to the sibling primitive, gating
`motion-safe:animate-pulse` in `src/components/ui/skeleton.tsx:9` and writing a test for it in
`skeleton.test.ts` that checks both the gated and the bare form are right. `progress` got the
opposite treatment: the token was changed, the class was left generated, and no test looks at
motion at all. `transition-all` is also the wrong primitive for a one-property tween.

**Why it matters**: No production impact today, because nothing imports `Progress` yet. But the
spec's Components table presents it as a delivered standard, the spec's Follow-up is explicit that
this component is what replaces the popup's inline progress bar, and the next slice will import it
with the suite green and no test looking at motion. The failure lands silently and it lands on the
one user who asked for it not to.

**Suggested fix**: Gate it the way the skeleton was gated, `motion-safe:transition-transform` with
an explicit duration rather than `transition-all`, and extend the existing skeleton-style assertion
to `progress.test.ts` so the gate cannot be lost to a future `shadcn add`. The
`progress.tsx:21-25` comment already warns that a re-`shadcn add` overwrites the file; this is a
second thing that overwrite would take.

### 🟠 The design token guard cannot see a colour written in an inline style, `src/testing/guards/design-tokens.ts:230`

**Problem**: `scanTypescript` only inspects string and template literals. A colour in a style object
is neither, so it passes. I confirmed it against the real tree: `const s = { color: "#7c3aed" }`
in any `src` file produces **zero violations**. The same is true of
`style={{ backgroundColor: "rgb(124, 58, 237)" }}`, and of any colour function in a
`CSSStyleDeclaration`-shaped value. An inline style is not a Tailwind utility, so
`--color-*: initial` does not touch it either: the class of colour the spec is most worried about
is the one class both layers miss.

To be clear about where the fault lies: the implementation matches its spec exactly.
`index.md:203-215` enumerates the guard's match set and inline styles are not in it, and
`index.md:490-491` acknowledges the reset "does not stop arbitrary values or gradient stops, so the
guard has to carry three cases the reset cannot, and a future arbitrary colour outside its match set
would slip through" without noticing there is a fourth category. So this is the spec's gap, and the
implementation faithfully reproduces it.

**Why it matters**: `index.md:488-489` states that the guard "is load bearing rather than
redundant. Without it this standard is a trap." A guard that declares five ways to smuggle a colour
in and misses the sixth is a weaker guarantee than the spec claims, and the failure mode is the
worst kind: the build is green, the test is green, and the popup ships a hardcoded hex.

**Suggested fix**: Extend `scanTypescript` to read `style={{ ... }}` property assignments and feed
the value through `COLOUR_LITERAL`, the same rule the stylesheet path already uses, with
`isTokenDeclaration`'s exemption for custom properties. Alternatively close the gap in the spec by
naming inline styles as a known hole and banning inline colour in `AGENTS.md`. Either is fine;
silently leaving it unnamed is not.

## Minor

### 🟡 Dead branches left by the colour migration, `src/App.tsx:310`

**Problem**: The type-icon wrapper is a ternary whose two branches are the same string:

```
isAudio ? 'bg-muted border border-border' : 'bg-muted border border-border'
```

and the quality `Badge` at `src/App.tsx:325-329` does the same with
`'bg-muted/50 text-muted-foreground'` on both sides. Colour is no longer what distinguishes an
audio row from a video row, which is the point of AC-10, so the branches have nothing left to
choose between.

**Why it matters**: A reader has to work out that the duplication is deliberate rather than a
half-finished migration, and the next person to add a type distinction will edit one branch and
wonder why the other did not change. It is also the clearest sign in the diff of where the migration
was mechanical.

**Suggested fix**: Collapse both to the single class string. If a future distinction is wanted, it
belongs in the icon and the label, which `App.test.tsx:136-150` already covers.

### 🟡 A test named for the opposite of what it asserts, and it pins an unlabelled state, `src/App.test.tsx:251`

**Problem**: The test is called "offers the control again once the transfer completes" and its body
asserts `expect(buttons().map(accessibleName)).not.toContain("Download video 1080p")`. The name
promises the control returns; the assertion proves it does not.

What it is actually pinning is the current `complete` rendering: `src/App.tsx:349-350` replaces the
download button with a bare `<CheckCircle2 className="text-muted-foreground" />` in a plain `div`,
with no `aria-label` and no text. The migration changed that icon from `text-emerald-400` to
`text-muted-foreground`, so the one signal distinguishing "saved" from "still going" is now an
unlabelled grey check. The spec's States table asks for more: "the control becomes a done
affordance, **and the text states the outcome**", Label `Saved` (`index.md:370`).

**Why it matters**: A test whose name and body disagree is worse than no test, because the next
reader trusts the name. And the missing `Saved` label is now covered by a green test, so slice 1
could delete the button-and-nothing treatment believing it was specified.

**Suggested fix**: Rename the test to what it checks, and either add the `Saved` text and accessible
name now or make the test assert the gap explicitly so slice 1 has to close it. The label itself
belongs to build plan task 6, so a `// TODO(spec 0003 task 6)` on the assertion is enough to stop
it calcifying.

### 🟡 A test named for an opacity assertion it never makes, `src/main.test.ts:96`

**Problem**: "leaves the row's opacity animation alone, so a row still appears" asserts
`expect(row).not.toBeNull()` and `expect(row?.textContent).toContain("1080p")`. Neither touches
opacity. The assertion that would be meaningful here is that the row's opacity is animating or has
reached 1 while its transform is absent, which is exactly the contrast the test above it sets up.

**Why it matters**: The pairing of these two tests is the whole argument for `MotionConfig` being
set to `"user"` rather than `"always"` or omitted, and one half of that argument is not being made.
If someone later changes the config to `"always"`, both tests still pass.

**Suggested fix**: Assert the computed opacity on the row is not 0, or that motion wrote an opacity
value onto the element, so the test fails if the row would travel *and* if it would be invisible.

### 🟡 The only enabled text in the popup that is not on a token sits below the spec's own floor, `src/App.tsx:143`

**Problem**: The header's hostname line is wrapped in `<div className="... opacity-50">` and
inherits `text-foreground`. `--foreground` is `oklch(0.96 0 0)` (#f2f2f2) and `--background` is
`oklch(0.145 0 0)` (#0a0a0a); composited at 50% the hostname measures **4.88:1** (I recomputed from
the oklch values, 8-bit rounded). `verify.md:86-87` records the lowest enabled text node in the
popup at 4.50:1, and this is the only element I can find that low.

The spec sets a stricter floor than AA for exactly this case: `--subtle-foreground` at 6.12:1 is
"the floor for any enabled text", and the accessibility rules say a lower grey "is only legal on
disabled controls, which WCAG exempts ... and it never applies to enabled content"
(`index.md:260-262`, `index.md:415-416`). The hostname is enabled content. `rationale.md:240-252`
measures only token-to-token pairs, so the one rendered pair that is alpha-composited is outside
the evidence base entirely.

**Why it matters**: 4.88:1 clears AA by 0.38, so this is not a violation today, but it is a single
`--background` change away from one, and the design's own stated floor is already breached with no
headroom. The guard cannot catch it, because `opacity-50` is not a colour utility.

**Suggested fix**: Drop the `opacity-50` and put the line on `text-subtle-foreground`, which is what
the spec's typography table assigns to metadata at 6.12:1. One class, and it puts the element back
inside the standard.

### 🟡 The row lost its only border, so a raised panel is not paired with `--border`, `src/App.tsx:306`

**Problem**: The old class string was
`bg-white/[0.03] border-white/[0.04] hover:border-purple-500/20 transition-all group overflow-hidden shadow-none`.
The new one is `transition-colors group overflow-hidden shadow-none hover:ring-ring/50`. The
`border-white/[0.04]` was the only thing setting a border **width** on the row: the base reset at
`src/index.css:86` sets `border-border` as a colour on every element, and `src/components/ui/card.tsx:15`
supplies `ring-1 ring-foreground/10`, but neither sets a `border` width. So the row's edge is now
the primitive's 1px ring at 10% foreground over `--card`, which measures **1.31:1**.

The spec is unusually firm about this exact value: "at 10% white it measured 1.32:1, **which is not
a visible edge**" (`index.md:272-273`), and "A raised panel always pairs `--card` with `--border`"
(`index.md:250`). The Components table's guarantee for `card` repeats it: "`bg-card` with
`--border`, never alone" (`index.md:333`). So the migration moved the popup's only card from a
`--border` edge to the 1.32:1 edge the spec dismisses.

The `hover:ring-ring/50` half does work, and well: the card's `ring-1` supplies the width, so hover
lifts the ring from 1.31:1 to 3.15:1, which clears 3:1. That was the right instinct.

**Why it matters**: A resting row is now bounded by a 1.31:1 edge, which is why the migrated list
reads flatter than the old one. The row is also not the canonical row the spec specifies anyway
(that is a `border-b border-border` `<li>` with no fill, `index.md:156`), but that is slice 1's job.

**Suggested fix**: Add `border border-border` to the row's `Card` className so the raised panel
carries the edge the spec requires. Or, if the primitive is to stay untouched, note the exception in
the Components table so the next person does not read `card`'s guarantee as satisfied.

### 🟡 The hover token's justification is the wrong number in the wrong category, `docs/specs/0003-popup-design-language/index.md:246`

**Problem**: The token table justifies `--muted` with "1.18:1 against card, so `bg-muted/50` is a
real hover". Both halves are off. `--muted` on `--card` does measure 1.19:1, but `bg-muted/50` is
what the primitives actually render, and 50% `--muted` composited over `--card` measures **1.08:1**,
not 1.18:1. The number cited is the un-composited token's, applied to a class that halves it. And
1.08:1 to 1.19:1 is not a distinction a person can see, so "a real hover" does not follow from
either figure.

The same reasoning error appears one row up: `--card` at 1.15:1 over `--background` is described as
"far too little to carry a boundary" (`index.md:248-249`), which is the correct call and the right
kind of argument. The hover row is the same category of claim made with a number that does not
support it.

**Why it matters**: This is the stated justification for a token's role, in the section AC-6 points
at. A reader checking it will compute 1.08:1 and conclude the spec's numbers are approximate,
which costs the credibility of the fourteen that are right.

**Suggested fix**: Either re-measure the composited value and state it, or restate the row as what it
is: a fill that separates a surface from its neighbour by a small step, with the boundary carried by
`--border` and the hover confirmed by observation rather than by ratio.

### 🟡 `verify.md` is stale and internally inconsistent on the numbers it is the evidence for, `docs/specs/0003-popup-design-language/verify.md:19`

**Problem**: Four claims do not hold up.

- Line 19 records `npm run build` as passing "148 tests". The suite is **205 tests across 16 files**,
  and `scope.md:36` says so correctly. The record predates the test pass.
- Lines 58-59 claim that under reduced motion "the remaining infinite animations belong to slice 1
  and are listed under Deferred". There are no remaining infinite animations: both `repeat: Infinity`
  uses are gone and the three spinners are gated. The "Still slice 1's" section (lines 63-70) lists
  build plan tasks 5 and 6 and a light-theme re-measure, and does not mention animations. The
  sentence points at a list that does not contain it.
- Lines 90-91 say "the two gated spinners still run when motion is welcome". There are **three**
  (`src/App.tsx:164`, `204`, `354`), and the spec's own build plan item 7 says "Three `animate-spin`
  loaders". The record contradicts the spec it is verifying.
- Lines 76-77 claim AC-1 was checked "across all 27 palette families and 15 prefixes", but the
  command on line 26 greps five families (`slate|purple|blue|red|emerald`). I ran the 27-family
  version and the claim is true, so this is the record understating what it proved, not overstating
  it. Still, someone re-running the stated command gets weaker evidence than the coverage line
  claims.

One more number worth flagging: line 86-87 reports the lowest enabled text node at 4.50:1. I
recomputed every pair in the token table and they all reproduce to within 0.05, so the method is
sound, but I get 4.88:1 for the lowest element I can find (`src/App.tsx:143`, see the Minor above).
That is the one figure in the record not derivable from the table, and it is the figure that matters,
because it is the only one below the spec's own floor.

**Why it matters**: `verify.md` is the project's runtime evidence, and `index.md:507-511` already
lists "re-measure the token table against the built CSS, rather than trusting the numbers recorded
here" as outstanding. A record with a stale test count and a dangling cross-reference trains the
next reader to skim it.

**Suggested fix**: Refresh the test count, delete or correct the Deferred sentence, fix two to
three, and widen the AC-1 grep in the record to the 27 families it claims to cover. The token table
itself needs no work; I checked it.

### 🟡 The faked 30% progress the spec says this change deletes is still there, `src/App.tsx:378`

**Problem**: The spec's Replaces list claims the migration removes "the `30%` placeholder and
`duration: 0.3` spring passed as Motion values rather than Tailwind classes" (`index.md:181`).
`duration: 0.3` was removed, at line 380, correctly. The `30%` placeholder is still there:
`downloadState.totalBytes > 0 ? \`...%\` : '30%'`. `scope.md:26-32` and `index.md:456-457` both
record the migration as done, and no Follow-up item tracks the `30%`. The Components table's
`progress` guarantee names it explicitly: "determinate from real bytes ... **never a faked 30%**"
(`index.md:339`).

**Why it matters**: A bar that sits at a fixed 30% while an unknown-length transfer runs is a
progress indicator reporting a number that is not true, which is the specific failure the new
`progress` primitive exists to remove. It is small, it is pre-existing, and it is the one item on
the Replaces list the change did not do while marking the list complete.

**Suggested fix**: Either do it, which is a three-line change to read the indeterminate case off
`totalBytes <= 0` the way the spec's States table describes, or move it onto build plan task 6
explicitly so slice 1 inherits it as a named item rather than as a gap nobody wrote down.

### 🟡 The AC-4 token audit is scoped to `src/components/ui/`, so the two new compositions are outside it, `src/design-language.test.ts:18`

**Problem**: `uiDir = join(srcDir, "components", "ui")`, and `colourReferences()` walks only that
directory. `src/components/empty-state.tsx` and `src/components/notice.tsx` are not scanned. They
reference `bg-card`, `border-border`, `text-foreground`, `text-muted-foreground` and
`text-destructive`, and their own tests assert only that those class *names* are present
(`empty-state.test.ts:67-68`), never that they resolve. Delete `--card` from `src/index.css` and
every one of the 205 tests still passes while `EmptyState` renders a transparent panel.

**Why it matters**: AC-4's guarantee is "no component renders unstyled after the namespace reset",
and this change delivers two new components that sit outside the check that enforces it. The test
file's own header (`design-language.test.ts:9-12`) makes the right argument for testing the token
layer at all, then stops one directory short.

**Suggested fix**: Point `primitiveSources()` at `src/components` rather than `src/components/ui`,
or add a second pass over the two composition files. Small change, and it closes the gap between
what AC-4 promises and what is checked.

### 🟡 A comment claims a runtime guarantee the code does not provide, `src/lib/schemas.ts:16`

**Problem**: The comment says pinning `state` to a union means "a fourth state cannot arrive as an
untyped string and reach the popup's switch". The union does constrain TypeScript, but the runtime
path is `any`: `src/App.tsx:76` is `const messageListener = (message: any) =>`, and
`setDownloadStates(prev => ({ ...prev, [message.url]: message }))` inserts that `any` straight into
a `Record<string, DownloadStatus>`. Nothing validates. A fourth state from the worker lands in
state untyped, exactly as before, and hits the `else` branch at `src/App.tsx:353`, which is the
spinner, so it would spin forever. `AGENTS.md` says as much: "nothing validates data with it yet, so
no payload should be assumed checked."

`scope.md:31` reports this as "proven to bite by injecting a fourth value and watching `tsc` refuse
it". That is literally true, and it is also true that the type is erased before the message arrives.

**Why it matters**: A comment that asserts a safety property the code lacks is worse than no
comment, because the next maintainer reads it and stops looking. This one is on the exact line a
future maintainer would check before trusting the union.

**Suggested fix**: Narrow the comment to what the type actually buys, something close to "the union
gives the switch exhaustiveness at compile time; the message boundary is still `any`, so the states
table in spec 0003 is the only definition until task 6 validates the payload". The tightening of
`App.tsx:76` from `any` is a separate, worthwhile follow-up and `src/AGENTS.md` already flags it.

### 🟡 `src/AGENTS.md` now describes files this change deleted, `src/AGENTS.md:18`

**Problem**: The key-files table still says `src/index.css` owns "the `.vortex-gradient` and
`.glass` helpers". Both were deleted by this change, and `design-language.test.ts:156-157` asserts
they never come back, so the AGENTS.md line now sends a reader looking for something the test suite
guarantees is absent. The same table's `src/components/ui/` row still reads "Generated shadcn
primitives" with no note that `progress` and `skeleton` are now hand-modified, and there is no row
for the two new compositions under `src/components/` or for the new guard in
`src/testing/guards/`.

The root `AGENTS.md:44` line about the popup hardcoding slate and purple is also now false, but that
one is already tracked as a Follow-up (`index.md:516-517`) and I am not reporting it again.

**Why it matters**: `AGENTS.md` is the context every later run reads first. A line that names deleted
files is the cheapest possible way to make the next session doubt the test suite.

**Suggested fix**: Drop the two helper names from the `index.css` row, note the two hand-modified
primitives on the `ui/` row, and add rows for `src/components/empty-state.tsx`, `notice.tsx` and
`src/testing/guards/design-tokens.ts`. This is what `/sync` is for; the point is that the Follow-up
only names the root line, so this one would slip through.

## Nits

- ⚪ `src/testing/guards/ast.ts:2`, the module header says "Shared plumbing for the **two** guards";
  there are three consumers now, and this change added the third.
- ⚪ `src/main.tsx:18`, `src/index.css:94`, `src/components/empty-state.tsx:33` and
  `src/components/notice.tsx:58` all end without a trailing newline. The diff shows the change
  dropped the one `src/index.css` had.
- ⚪ `src/components/ui/skeleton.tsx:9` deviates from generated shadcn output with no comment, while
  `progress.tsx:21-25` documents its deviation and tells the next person to reapply it after
  `shadcn add`. The two siblings should be consistent, since both will be overwritten.
- ⚪ `src/App.tsx:361` keeps a bare `shadow-lg` on the download button after the coloured
  `shadow-purple-500/10` had to go. A default black drop shadow around a 32px near-white button on a
  dark card is not a look the spec sanctions anywhere.
- ⚪ Icons in `src/App.tsx` (`RefreshCw`, `Download`, `Film`, `Music`, `CheckCircle2`, `AlertCircle`,
  `Loader2`) carry no `aria-hidden`, while the new compositions and the spec's canonical row
  (`index.md:157, 161`) both do. The buttons have `aria-label`s so the impact is small, but the row
  status icons at `src/App.tsx:349-355` are unlabelled either way.
- ⚪ `git status` shows an untracked `.claude/` holding ten relative symlinks into
  `.agents/skills/`, which is not in the stated change set. A `git add .` would commit ten
  symlinks duplicating a tree that is already tracked.

## Strengths

- The contrast work is real and the numbers are trustworthy. I recomputed all fourteen measured
  pairs in the spec's token table from the oklch values through sRGB with alpha composited, and
  every one lands within 0.05 of what is recorded, including the composited `--ring` at 50%
  (3.15:1 against a stated 3.14:1) and the destructive hue resolving to exactly the
  `rgb(255, 100, 103)` that `verify.md:85` reports. That is a better evidence base than most design
  specs have.
- The namespace reset is genuinely load bearing. I grepped the built CSS across all 27 palette
  families and all 15 colour prefixes the guard knows about and found nothing, no raw `white` or
  `black` utility either. `--color-*: initial` placed after the imports does what the spec says.
- `src/main.test.ts` is the best test in the change. It mounts the real entry, stubs
  `matchMedia` and the extension API, and asserts on what motion writes to the DOM. I removed
  `<MotionConfig reducedMotion="user">` and it fails on the transform assertion, which is exactly
  the property it claims to cover. `skeleton.test.ts` makes the same point about checking for the
  gated form's presence as well as the bare form's absence, and says why in a comment.
- The guard's parsing is more careful than it needed to be. The nested-bracket handling in
  `arbitraryGroups` and the deliberate lookbehind allowance for `_` in `COLOUR_LITERAL` are both
  cases most implementations get wrong, and each has a test that would fail if the reasoning
  regressed. The self-test that reads `node_modules/tailwindcss/theme.css` and fails when the
  palette list drifts is the kind of thing that quietly prevents a hole opening in a later Tailwind
  release.
- The `Unknown_Page` fix at `src/App.tsx:97-105` is a real bug found and fixed with a comment
  explaining why the guard sits after sanitising rather than before, and with four table-driven cases
  covering the empty, whitespace-only and punctuation-only titles. That is the right way to land it.
- `collectSourceFiles` taking the extension list as a parameter instead of widening the default, and
  `collectDesignTokenViolations` throwing on a missing source tree rather than reporting a clean run,
  are both decisions a guard author usually gets wrong in the direction of false confidence.

## Test coverage

The suite is genuinely strong on the things that are easy to assert and honest about the things that
are not. Every new component has a colocated test; the tests that exist generally assert on rendered
markup rather than on implementation internals; and the fixture cases in `guards.test.ts` are paired
with a real-tree assertion that is the one that actually bites. `classifyClass` and the CSS
stylesheet scanner both have the branch coverage their complexity warrants.

Three gaps, all in the new code:

1. **`progress` has no behavioural test at all.** `progress.test.ts` renders the component three
   times with `value: 40` and asserts three class names. It never renders a missing value, never
   renders a value above 100, and never looks at the transform. Both defects in the first Major pass
   the suite today. Its own header comment argues that "the class is the observable here, because a
   token name maps one to one onto a design token" and that "no user visible text or role stands in
   for it", which is right about the token and wrong about the component: the transform and the
   indeterminate state have no class to assert on and no test is looking at them.
2. **The `complete` state is pinned by a test whose name says the opposite** (`App.test.tsx:251`),
   which means the missing `Saved` label reads as specified rather than as outstanding.
3. **`main.test.ts:96` does not make the opacity half of its own argument**, so `"user"` and
   `"always"` are indistinguishable to the suite.

Two weaker spots in an otherwise thorough suite: the palette regexes in
`App.test.tsx:158` and `progress.test.ts:40` list 11 and 6 of the 27 families respectively, so
neither would catch `bg-amber-500` on its own; and `design-language.test.ts` covers
`src/components/ui/` but not the two new compositions, so the AC-4 guarantee has a hole in the
component this change added.

The `not.toContain` assertions in `App.test.tsx:163-167` and `progress.test.ts:37-41` are also worth
naming as a pattern to watch: they are trivially true for markup that never contained a palette
colour, and they are kept honest by the real-tree guard test rather than by themselves. That is fine
as belt-and-braces, but they should not be read as independent evidence.
