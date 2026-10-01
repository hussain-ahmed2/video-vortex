# Rationale: 0003. Popup design language

## Context

The popup is the only part of the extension a user actually looks at, and it is the least considered.
It was written first, quickly, and it shows in ways that compound.

The styling does not come from one place. `src/index.css` carries the full shadcn token set with
light values on `:root`, and a second dark set under `.dark` that nothing ever activates, because no
element is ever given that class. Meanwhile `src/App.tsx` paints the dark look with hardcoded
utilities, so the token layer is present, plausible, and inert. The interface's real colours are 37
distinct raw colour utility strings built from 17 palette values, plus two mechanisms that are not
palette steps at all: a `shadow-[0_0_15px_rgba(168,85,247,0.2)]` glow and a gradient title. Nobody
chose that palette; it accumulated one value at a time.

Two of those accumulated details are defects rather than style. `body` resolves `bg-background` from
the light `:root`, so the popup is painted white and then covered, which flashes white on every open.
And `--font-sans` is declared as Inter in one `@theme` block and overridden by Geist Variable in the
next, so the token and the rendered text disagree.

The vocabulary the popup would have to render already exists and is not what a UI designer would have
guessed. Spec 0001 defines a record's status as `observing`, `ready`, `blocked` or `unsupported`,
which is a description of the page rather than of the media, and two of those four are page level
failures with no visual treatment anywhere. Download progress is a separate vocabulary again,
`DownloadStatus.state`, and it is declared as a bare `string` in `src/lib/schemas.ts`, so nothing in
the type system says which values exist.

The forces shaping the decision: the shadcn primitives are generated and must stay generated, so the
token vocabulary has to stay interoperable with the CLI rather than be renamed into a project dialect.
That has a sharp edge, because `--color-*: initial` deletes every unmapped colour utility at once,
and the primitives that exist today reference four tokens a from-scratch palette would not think to
include. The project targets WCAG 2.2 AA, and 2.2 added SC 2.5.8 Target Size at Minimum, which a
dense list of small controls can fail without anyone noticing. And the build approach is Tracer
Bullet, so a decision that only pays off in feature 12 has to survive being ignored for many slices.

## Options considered

### Enforcement

**Option 1: Remove the default colour namespace, plus a guard test (chosen)**

`--color-*: initial` deletes every default colour utility at build time. A walking test fails on raw
colour in the source, including the three cases the reset cannot catch.

**Pros**: The wrong utility stops existing, so it cannot be reached for by accident. The test names the
offending file and class. No new dependency, and it gates the existing build.

**Cons**: Two mechanisms to understand. The reset alone is a trap, because it fails silently, and it
misses arbitrary values and gradient stops entirely, so the guard has a longer match set than the
reset does.

**Option 2: Guard test only**

Keep the default namespace, fail the test on raw colour.

**Pros**: One mechanism. Nothing about the build changes.

**Cons**: The utilities remain available and correct, so the only thing between a hurried edit and a
hardcoded colour is a test that has to be remembered. It does run in the build, but the build itself
would still ship one if the test were ever skipped.

**Option 3: Documentation only**

Write the language into `AGENTS.md` and rely on review.

**Pros**: Cheapest. No machinery.

**Cons**: This is what produced the current 37 strings. `AGENTS.md` already carries a line telling the
next agent to match the hardcoded slate and purple look, and no one has. Review catches a colour when
a reviewer is looking for one.

**Option 4: An ESLint plugin**

A rule reading JSX `className` strings, since no core rule can see inside a class string.

**Pros**: Reports at the exact line, with an editor squiggle.

**Cons**: A new dependency and a config surface, for a check this project can express in the harness it
already has.

### Rollout

**Option 1: Single migration inside slice 1, old look deleted (chosen)**

**Pros**: One look alive at a time. The same rule spec 0001 applies to the old pipeline, so the project
has one habit rather than two. Slice 1 is the first slice that touches the popup, so nothing is
deferred to a moment that will not arrive.

**Cons**: Slice 1 gets bigger, and the first demo lands later.

**Option 2: Language now, popup restyled in a later slice**

**Pros**: Slice 1 stays small.

**Cons**: Two looks coexist, and the migration has no deadline, so it tends not to happen. The dark
token block has been sitting there, unused, since the first commit.

**Option 3: Tokens only, migrate whenever the popup next changes**

**Pros**: Least work now.

**Cons**: The same unbounded deferral as Option 2, with less clarity about when the popup is next
touched at all.

### Theme mode

**Option 1: Dark only, tokens shaped so light can arrive (chosen)**

**Pros**: One palette to verify and maintain; the contrast table is measured once. Dark is what the
popup already is, so this is not a redesign.

**Cons**: A user with a light system preference gets a dark popup. Adding light later is a new `:root`
block plus a re-measured table.

**Option 2: Both themes now**

**Pros**: No user is stuck with a mismatch.

**Cons**: Doubles the palette to design, verify and keep in sync for a mode the product does not need.
A popup is a small surface opened for seconds, so the mismatch cost is low and the maintenance cost
is permanent.

**Option 3: Follow the system**

**Pros**: The convention users expect from a native feeling app.

**Cons**: Same cost as Option 2, plus a theme provider and a class toggle in a popup that needs
neither. It also walks straight into the trap already in the code, where a dark block exists and
nothing sets the class.

### Palette

**Option 1: Near monochrome, colour reserved for actions (chosen)**

**Pros**: Matches what the popup already looks like. A media list is mostly text, and one text ramp is
the one a designer can verify. Records are distinguished by icon and text, which is the accessible
answer anyway.

**Cons**: The primary action is an inversion rather than a coloured button, so it reads quieter than
some users expect from a download button. A near monochrome palette is only viable if the surface
steps are handled honestly, which turned out to be the harder half of this decision.

**Option 2: Near monochrome plus one brand accent**

**Pros**: A brand colour for the primary action, a little more identity.

**Cons**: One more hue to keep accessible, and one more thing to argue about in review.

**Option 3: A colour per stream type or status**

**Pros**: Fast to scan.

**Cons**: Fails the moment two hues collide, needs a legend, and is useless to a user who cannot
separate them. The popup already has the accessible version of this, with icons and labels.

### Smaller decisions

- **Typeface**: keep Geist Variable. It is imported and rendering, it is variable so weight costs
  nothing extra, and the `Inter` declaration is dead. Switching to Inter means adding a dependency; a
  system stack alone means a different look per machine.
- **Token vocabulary**: keep shadcn's names (`background`, `card`, `foreground`, `ring`) rather than
  renaming to a project dialect (`surface-base`, `text-primary`). The shadcn names are vaguer, and that
  vagueness is the price of the primitives and future CLI installs working untouched. A project dialect
  would mean editing generated code, which `AGENTS.md` forbids.
- **Row surface**: rows carry no fill. This was not a preference but a consequence, described below.
- **Component inventory**: the four state components (`skeleton`, `empty-state`, `notice`, `progress`)
  are required now, because the popup has none of them and the engine spec already names the states
  they have to render. `tooltip` joins them, because the popup has icon only controls today.
  `switch`, `select` and `alert-dialog` are specified now so the look is decided, and generated when
  the feature needing them lands.
- **References**: verified against W3C, MDN, Tailwind and shadcn, because the accessibility section is a
  list of specific numbers and a wrong number in a spec is worse than no number.
- **Indeterminate progress, added 2026-10-01**: an empty track, and the motion rule gains a sentence
  saying the indeterminate bar does not take the `motion-safe:` opt in that AC-8 permits. This case
  was left open here on purpose, because the conventional answer, a sweeping bar, is a loop, and
  writing it down honestly meant either overruling the motion rule or declining its opt in. It
  surfaced when scope feature 5 needed the value sourced and the gap had to close. Four answers were
  weighed. An empty track is chosen because the row already carries a spinner where its download
  control was, so the activity is reported without the bar moving, and a moving bar in a list where
  several rows can be downloading at once is the exact noise the rule was written to stop. A sweep is
  what a user expects and is the right answer in almost any other product; it loses here on
  restraint, not on merit, and the rule now says so rather than leaving the next reader to reopen it.
  A static partial fill was rejected because a user glancing at it reads a percentage off it, which
  is a claim about progress the spec forbids, and a fixed 25% is a faked 30% with a different number.
  Dropping the bar entirely was rejected because the row then changes shape between the two states for
  no gain. Two things came out of deciding it that the decision itself did not settle. The track
  turned out to carry the whole visual answer, so its token is now measured against `--background`,
  which is where a row sits, at 1.36:1 rather than the 1.18:1 the token table recorded against card.
  And the spinner the argument leans on was in the code and in no spec, so it now has a components row
  of its own. On governance: the shipped popup already rendered this case as an empty track, so this
  amendment ratifies behaviour that already exists rather than changing any of it, which is what made
  amending an `Accepted` spec safe. Nothing rendered moves.

## Rationale

The deciding consideration was that the current drift was not caused by a missing rule. There was no
rule, and the tokens that would have been the rule were already in the file, correctly written and
inert. Documentation was therefore the option least likely to change anything, which is why it lost to
the two options that make the wrong thing impossible or loud.

Between the two enforcement mechanisms, the namespace removal is stronger because it removes the
capability rather than reporting its use, and it costs one line. It could not stand alone, for a
specific reason found while testing it. An unknown utility is not an error in Tailwind v4, so removing
the namespace means a reintroduced colour utility builds cleanly and then does nothing at run time. A
silent failure inside a design token system is precisely the failure this standard exists to prevent,
so the test is what makes the reset safe rather than a redundant extra. The reset also turned out to
have a smaller reach than expected: it governs colour utilities and nothing else, so a literal
`rgba()` inside an arbitrary shadow, and a gradient stop behind a `text-transparent` title, both pass
straight through. The second of those is the nastier failure, because removing the gradient stops
leaves the title invisible rather than merely uncoloured. Hence the guard's explicit match set.

Rollout follows the same principle one level up. Keeping the old look alongside the new one would
leave the inert-token problem in place, since a token layer with a competing palette still in the
codebase is exactly the state this repo is in now.

The palette was chosen less on taste than on arithmetic, and the arithmetic changed the design. The
first token set took the shadcn dark values as given, which put `--card` 1.10:1 above
`--background`, and then wrote that a row boundary could come from a 10% alpha `--border`. Measuring
the rendered result showed that border at 1.32:1, and the surface step is not something a viewer can
see either. A list built that way would be an undifferentiated block of text on near black. The fix
was to stop giving rows a fill at all, let a solid separator carry the edge, and then raise `--border`
and `--ring` until the numbers held. The same pass caught that `--ring` was specified at a value that
clears 3:1 as a raw token but only reaches 2.16:1 once composited at the 50% alpha the primitives
actually render, which is the kind of error that a spec asserting a contrast ratio without measuring
the rendered value would have shipped.

## Evidence

Measured in this repo, on 2026-09-30.

**Inventory of the current state.** `src/App.tsx` uses 37 distinct raw colour utility strings,
including alpha variants, built from 17 palette values. The count is reproducible only under one rule,
so the rule is stated: distinct utility strings, not distinct values, with `white` and `transparent`
folded into the palette count. Separately, and not reachable by counting palette steps, `App.tsx`
carries `shadow-[0_0_15px_rgba(168,85,247,0.2)]` and a `bg-clip-text text-transparent` title over
`from-purple-400 to-blue-400`. `src/index.css` declares a light palette on `:root`, a dark palette
under `.dark` that nothing activates, `.vortex-gradient` and `.glass` which are unreferenced, and
`--font-sans: Inter` immediately before the Geist Variable override.

**Namespace removal, tested.** Adding `--color-*: initial` to `src/index.css` and rebuilding:
`bg-slate-950` went from 1 occurrence in `dist/assets/*.css` to 0, and no
`bg-{slate,zinc,neutral,gray,red,purple,emerald}-*` utility survived anywhere in the output. Defining
a custom token after the reset still produced a working utility, so the reset does not block custom
tokens. The build succeeded with the utility absent, which is the silent failure the guard exists to
catch. Both files were restored and the suite re-run at 126 passing. Pinned version:
`tailwindcss@4.2.4`.

**Tokens the reset would have broken, found by grep.** The live primitives reference
`bg-secondary`, `text-secondary-foreground`, `border-input`, `bg-input/30`, `bg-input/50`,
`bg-muted/50` and `text-card-foreground`. A from-scratch palette that defined only the values the
popup appears to need would have left the secondary button variant, the outline button's border and
every card footer hover rendering unstyled, silently, with the build still green.

**Contrast, computed from the oklch values.** WCAG relative luminance and contrast ratio, with alpha
composited in device space before luminance, since measuring the token rather than the rendered value
is what produced the ring error described above.

| Pair | Measured | Requirement |
|---|---|---|
| `--foreground` on background / on card | 17.68:1 / 15.39:1 | 4.5:1, passes |
| `--muted-foreground` on background / on card | 7.94:1 / 6.91:1 | 4.5:1, passes |
| `--subtle-foreground` on background / on card | 6.12:1 / 5.33:1 | 4.5:1, passes |
| faintest grey clearing 4.5:1 on card | `L=0.61` | so `0.65` is the floor for text |
| `--card` on background | 1.15:1 | too low to carry a boundary, hence unfilled rows |
| `--border` on card / on background | 1.47:1 / 1.69:1 | a visible separator |
| `--border` as the original 10% alpha white | 1.32:1 | not an edge, so the token became solid |
| `--input` on card, full opacity | 3.53:1 | 3:1, passes |
| `--ring` on card / on background at the 50% rendered | 3.14:1 / 3.20:1 | 3:1, passes |
| `--ring` at `oklch(0.62 0 0)`, the first value tried | 2.16:1 | 3:1, fails |
| `--primary-foreground` on `--primary` | 15.18:1 | 4.5:1, passes |
| `--secondary-foreground` on `--secondary` | 11.29:1 | 4.5:1, passes |
| `--destructive` on background | 6.86:1 | 4.5:1, passes |
| a disabled grey on card | 2.04:1 | exempt, disabled controls only |

**Standards confirmed.** WCAG 2.2 SC 1.4.3 AA is 4.5:1 for normal text and 3:1 for large text, where
large is 18pt (24px) or 14pt bold (about 18.7px). SC 1.4.11 AA is 3:1 and covers UI component
boundaries and states. WCAG 2.2 changed neither criterion; it added SC 2.5.8 Target Size at Minimum
(AA, at least 24 by 24 CSS pixels), 2.5.7 Dragging Movements, 2.4.11 and 2.4.12 Focus Not Obscured,
2.4.13 Focus Appearance (AAA), 3.2.6 Consistent Help, 3.3.7 Redundant Entry, and 3.3.8 and 3.3.9
Accessible Authentication. `prefers-reduced-motion` has two values, `reduce` and `no-preference`.
Tailwind v4 ships `motion-reduce:` and `motion-safe:` for it, and `focus-visible:`.

**Not verified.** The shadcn dark mode documentation page renders client side and returned no body
text, so the claim that shadcn's Tailwind v4 setup expects a `.dark` class over the media query comes
from its theming and installation pages rather than from that page. The namespace removal behaviour was
not re-tested against any Tailwind version other than the pinned 4.2.4. The motion layer was not
exercised in a browser: `<MotionConfig reducedMotion="user">` is the documented way to honour the
setting for `motion/react`, and `/check verify` should confirm it against the real popup.

## References

**Project sources** (in this repo):

- `src/index.css` — the two token blocks, the dark `.dark` palette nothing activates, the font
  contradiction, the unreferenced `.vortex-gradient` and `.glass`, the imports and base rules the
  primitives depend on
- `src/App.tsx` — the raw colour utilities, the literal `rgba()` glow, the gradient title, the two
  infinite animations, the two section scroll areas, the frozen 30% progress bar, the ad hoc layout
  values
- `src/components/ui/` — the four generated primitives, and the tokens they reference that the reset
  would otherwise delete
- `src/lib/schemas.ts` — `DownloadStatus.state` typed as a bare `string`
- `AGENTS.md` — the generated primitives rule, and the dark popup line this spec supersedes
- `docs/specs/0001-detection-engine-architecture/0001-state-store.md` — `TabMedia.status` and its four
  values, which this spec designs treatments for
- `docs/specs/0002-test-harness-and-message-contract/` — the harness and the source walking guards the
  new guard test follows
- `docs/scope/scope.md` — feature 4, the popup design language
- Installed skills: `tailwind-v4-shadcn`, `motion-foundations`, `shadcn`, `chrome-extensions`

**Practices & standards**:

- Design tokens as the single source for colour, defined in CSS and consumed as utility classes
- WCAG 2.2 Level AA, SC 1.4.1 Use of Colour, 1.4.3 Contrast Minimum, 1.4.11 Non text Contrast,
  2.4.7 Focus Visible, 2.5.8 Target Size Minimum
- `prefers-reduced-motion` as the operating system signal, honoured through `MotionConfig
  reducedMotion="user"` for library animation and `motion-reduce:` for CSS
- Strangler migration applied to a look rather than a pipeline: replace in one pass, never run both
- Mechanical enforcement over documented convention, the same principle spec 0002 applied to module
  boundaries

**Links** (web verified):

- Understanding SC 1.4.3: Contrast (Minimum): https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
- Understanding SC 1.4.11: Non-text Contrast: https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html
- What's New in WCAG 2.2: https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/
- Using CSS :focus-visible to provide keyboard focus indication: https://www.w3.org/WAI/WCAG22/Techniques/css/C45
- prefers-reduced-motion CSS media feature: https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion
- :focus-visible: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Selectors/:focus-visible
- Theme variables, Tailwind CSS: https://tailwindcss.com/docs/theme
- Hover, focus, and other states, Tailwind CSS: https://tailwindcss.com/docs/hover-focus-and-other-states
- Theming, shadcn/ui: https://ui.shadcn.com/docs/theming