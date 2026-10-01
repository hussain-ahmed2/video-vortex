# Scope: Video Vortex

A Chrome extension that finds the video playing on a page and saves it. This plan rebuilds the detection core, reworks how the popup looks, and takes it to a public store release.

**Build approach:** Tracer Bullet (each capability is built end to end through the worker, the content script, the popup and its tests, and works, before the next one starts).
**Workflow:** GA (after `/develop`: `/check verify`, then `/test`, then a fresh model `/check review`, then `/document`). The project default level of rigor. `/architect` is the recommended first stop for a feature with a real decision, but skippable when you already know the build. Any feature can carry its own tag (e.g. `· Beta`) to do more or less.

_These are recommendations to keep your build orderly, not requirements. Skip anything that does not fit: if you already know how to build a feature, use `/develop` and skip `/architect`. You decide when a feature is `done`._

## At a glance

| # | Feature | Phase | Status |
|---|---------|-------|--------|
| A | URL sniffing pipeline | existing work | in-progress |
| B | YouTube extractor | existing work | in-progress |
| C | Popup and download bridge | existing work | in-progress |
| D | Project context and docs | existing work | existing |
| 1 | Detection engine architecture | Foundation | in-progress |
| 2 | Documentation and comment conventions · Alpha | Foundation | in-progress |
| 3 | Test harness and message contract | Foundation | in-progress |
| 4 | Popup design language | Foundation | done |
| 5 | Walking skeleton: detect, list, download | Slice 1 | planned |
| 6 | Media source and blob stream detection | Slice 2 | planned |
| 7 | Honest handling of HLS and DASH | Slice 2 | planned |
| 8 | YouTube extractor on the new engine | Slice 3 | planned |
| 9 | Subtitles and thumbnail download | Slice 3 | planned |
| 10 | Merge audio and video into one file | Slice 4 | planned |
| 11 | Batch download with a queue | Slice 4 | planned |
| 12 | An options page | Slice 5 | planned |
| 13 | Filename and folder control | Slice 5 | planned |
| 14 | Second site extractor | Slice 6 | planned |
| 15 | Download history | Slice 6 | planned |
| 16 | Local diagnostics view | Slice 7 | planned |
| 17 | Store release readiness · GA | Slice 7 | planned |

## Existing work

Pre-workflow code, enrolled so the plan stays honest about what is already there.

### A. URL sniffing pipeline · in-progress
Watches requests in the service worker and keeps direct media file URLs per tab. It works for plain files, misses most real sites, and loses everything when the worker is stopped. Superseded by slice 2, read it for reference rather than extending it. code in `src/background.ts`

### B. YouTube extractor · in-progress
Injects a script into the page, reads the player response and lists the formats that carry a direct URL. Signature protected formats are dropped and separate audio and video stay separate. Superseded by slice 3. code in `src/content.ts`

### C. Popup and download bridge · in-progress
The popup UI, the file naming rule, and the download and progress messages. The naming rule and the download path carry forward into slice 1, the polling loop and the state handling do not. code in `src/App.tsx`

### D. Project context and docs · existing
Root and `src` context files, drafted by `/audit`, plus the project README. Feature 2 keeps them true as the engine changes. code in `AGENTS.md`, `src/AGENTS.md`

## Foundations

### 1. Detection engine architecture
Decide how detection works end to end and where each piece lives, so the rebuild has one spine instead of three runtimes that each know too much. Covers the module layout, the state store, the message contract between the runtimes, and the site extractor interface.
**Done when:** a spec fixes the engine boundaries, the state store, the message contract and the extractor interface, and the old pipeline is marked as replaced.
- [x] Design it (spec): `/architect detection engine architecture`
Spec 0001 (an umbrella: `index.md` plus four children, one per decision) · code in (filled by /develop)

### 2. Documentation and comment conventions · Alpha
Set the comment rule (explain why, not what) and the module header convention, then fix the docs that describe the old design, so every module written from here explains itself and the README tells the truth.
**Done when:** root `AGENTS.md` states the comment rule, each engine module carries a short header saying what it owns and why, and the README matches the real architecture.
- [ ] Build it: `/develop documentation and comment conventions`
   - [x] Comment rule and module header convention recorded in root `AGENTS.md`, alongside the engine purity rule from spec 0001
   - [x] Docs describing the old design corrected: the header rewrite gotcha in `src/AGENTS.md`, and the README rewritten to say what works and what does not
   - [ ] Module headers applied to the engine modules, which do not exist until slice 1 builds them (scope feature 5)
- [ ] Verify it: `/check verify documentation and comment conventions`
Spec 0001 (the architecture these docs describe) · no code, documentation only

### 3. Test harness and message contract
Stand up the runner and the fakes for the extension APIs, and pin the message contract, so every later slice arrives with tests instead of getting a retrofit at the end.
**Done when:** one command runs the suite, the three runtimes can be called directly with faked extension APIs, and the message shapes are covered by tests that fail when a payload drifts.
- [x] Design it (spec): `/architect test harness and message contract`
- [x] Build it: `/develop test harness and message contract`
   - [x] Runner, config and scripts wired: dependencies, the test block inside `vite.config.ts`, the compiler node types and iterable DOM lib, and `test` / `test:watch` with the build running type check, suite, then bundle
   - [x] Harness proven against two real pure modules from `src`, and the four namespace fakes built with their own tests, covering the callback and promise forms, `lastError`, a storage round trip, a rejecting broadcast and a driven download
   - [x] Both guards written as pure functions over a directory, the engine purity walk and the co located test walk, each with self tests against broken fixture trees written to a temporary directory
   - [x] Suite confirmed to need no browser binary and no network, to stay inside the ten second budget, and `npm run build` green with every test file present
- [x] Verify it: `/check verify test harness and message contract`
- [x] Test it: `/test test harness and message contract`
- [ ] Review it (fresh model): `/check review test harness and message contract`
- [ ] Document it: `/document test harness and message contract`
[Spec 0002](../specs/0002-test-harness-and-message-contract/index.md) · code in `./src/testing/`, runner config in `vite.config.ts`, first tests in `./src/lib/`

### 4. Popup design language
Define the reworked look as a system (color, type, spacing, component states, motion, keyboard and focus), so the popup is built once against a written language rather than reworked twice.
**Done when:** a design spec covers color, type, spacing, the component set with its loading, empty and error states, the accessibility target, and the primitives the popup needs.
- [x] Design it (spec): `/architect popup design language`
- [x] Build it: `/develop popup design language` (token layer, guard test, dead rules, the new primitives; the popup rebuild itself is slice 1's task)
   - [x] Token layer rewritten: the namespace reset, the dark values on `:root`, every value from the spec's token tables, with the four imports, the radius scale, `--font-heading` and the base reset all kept
   - [x] Popup colours migrated onto the tokens, including the two mechanisms a palette step would never have caught: the literal `rgba()` glow and the gradient stop behind the transparent title
   - [x] Dead rules gone: `.vortex-gradient`, `.glass`, the never activated `.dark` block and the `Inter` declaration, plus a `body` rule whose `hsl(var(--background))` could not resolve an `oklch` value and so left the popup sitting on the white canvas
   - [x] Design token guard added with the specified match set, and proven against the real tree by injecting a palette step and then the glow shadow, watching the build go red each time
   - [x] Five components added: `skeleton`, `progress` and `tooltip` generated through the shadcn skill, plus `empty-state` and `notice` as compositions under `src/components/`, each against these tokens
   - [x] `progress` fill moved from `--primary` to `--muted-foreground`, so a row in flight is never brighter than the action, measured 5.84:1 against its own track
   - [x] `DownloadStatus.state` pinned from a bare `string` to a `DownloadState` union of `in_progress`, `complete`, `interrupted`, proven to bite by injecting a fourth value and watching `tsc` refuse it (spec build plan task 6, whose remaining part is slice 1's)
   - [x] Verification fixes after `/check verify` failed AC-5 and AC-8: `MotionConfig reducedMotion="user"` in `src/main.tsx`, the logo spin and glow pulse removed, three spinners gated behind `motion-safe:`, the spring tween turned into a duration, and the popup's own progress fill moved off `--primary` (the shadcn `Progress` primitive is not imported anywhere, so changing it had no effect on the running popup)

   `switch`, `select` and `alert-dialog` are named in the spec and deliberately not built here: the first two belong to the options page (feature 12) and the third to the overwrite case, which has no feature of its own yet.
- [x] Verify it: `/check verify popup design language` (all twelve criteria met on 2026-10-01, evidence in the feature's verify.md)
- [x] Test it: `/test popup design language` (243 tests across 16 files, green. 205 on the first pass; /debug added 20 for the four review majors, then this pass added 18 covering AC-1, AC-5 and AC-6, which nothing automated. The contrast ratios are now recomputed from the oklch tokens rather than trusted, and all four were checked by breaking the contract first.)
- [x] Review it (fresh model): `/check review popup design language` (two runs on 2026-10-01, both Changes requested. First was same model as the author and is kept at docs/reviews/2026-10-01-main-same-model.md. Second was the independent pass, 4 majors and 10 minors. Four majors still open.)
- [x] Document it: `/document popup design language` (PR description written as chat text; no branch or `gh`, so it is not opened)
[Spec 0003](../specs/0003-popup-design-language/index.md) · tokens in `src/index.css`, guard in `src/testing/guards/`, primitives in `src/components/ui/` and `src/components/`, popup rebuild in slice 1

## Slice 1: the walking skeleton

### 5. Walking skeleton: detect, list, download
Prove the new spine end to end on the simplest real case: a page playing a direct video file, listed in the popup and saved to disk. This is the skeleton, nothing in it is faked or stubbed.
**Done when:** playing a direct mp4 on any page and opening the popup shows it with quality and size, downloading saves a file with the right name, the list is still there after closing the popup and after the worker is stopped, and the pure logic and the message contract are covered by tests.
- [ ] Build it: `/develop walking skeleton: detect, list, download`

## Slice 2: catch the streams real sites use

### 6. Media source and blob stream detection · needs a decision
Catch the streams most real sites actually use, which the browser assembles from many small requests and never exposes as a video file. These sites show nothing at all today.
**Done when:** on at least three real sites that stream through MediaSource (the browser media pipeline), the popup lists the stream with a working download, and the page world hook is covered by tests.
- [ ] Design it (spec): `/architect media source and blob stream detection`

### 7. Honest handling of HLS and DASH · needs a decision
Stop offering a playlist or manifest file as if it were a video, and either assemble the real segments or hide the stream and say why.
**Done when:** an HLS or DASH stream either downloads as a playable file or is clearly labelled as a stream that cannot be saved, never as a video that turns out to be a text playlist.
- [ ] Design it (spec): `/architect honest handling of HLS and DASH`

## Slice 3: YouTube done properly

### 8. YouTube extractor on the new engine · needs a decision
Rebuild the YouTube path on the new spine so the format list is accurate and reliable, including the signature protected formats that are currently dropped.
**Done when:** across a range of YouTube videos the popup lists the available qualities with their audio, the download works for signed and unsigned formats alike, and moving between videos updates the list without a manual refresh.
- [ ] Design it (spec): `/architect youtube extractor on the new engine`

### 9. Subtitles and thumbnail download · needs a decision
Save the caption track and the poster image next to the video, so an archived clip is self contained.
**Done when:** on a YouTube video the user can save the caption track in a chosen language and format plus the poster image, and the files land beside the video with matching names.
- [ ] Design it (spec): `/architect subtitles and thumbnail download`

## Slice 4: the workhorse downloads

### 10. Merge audio and video into one file · needs a decision
Turn the separate high quality video and audio rows into a single playable file, which is the reason people reach for this kind of tool in the first place.
**Done when:** picking a video only format and an audio only format produces one file that plays with both, progress is shown, and a file too large to merge in the browser fails with a clear message.
- [ ] Design it (spec): `/architect merge audio and video into one file`

### 11. Batch download with a queue · needs a decision
Let the user grab everything on the page in one action, with a queue they can watch, pause and cancel.
**Done when:** one action queues every listed stream, each entry shows its own progress, the queue survives the popup being closed and reopened, and cancelling stops what has not started.
- [ ] Design it (spec): `/architect batch download with a queue`

## Slice 5: control over the result

### 12. An options page · needs a decision
Move every hardcoded default into a real settings screen backed by local storage, so the extension can be configured without a rebuild.
**Done when:** an options page stores and restores defaults, the popup and the engine both read them, and a reset to defaults works.
- [ ] Design it (spec): `/architect an options page`

### 13. Filename and folder control · needs a decision
Let the user say what a saved file is called and where it lands, with a live preview of the result before saving.
**Done when:** a template with title, quality, date and site fields, plus a folder per site, produces the path the user previewed, and illegal characters are handled without a surprise.
- [ ] Design it (spec): `/architect filename and folder control`

## Slice 6: prove it generalises

### 14. Second site extractor
Prove the extractor interface from feature 1 generalises by adding a second site, and fix the interface where the second site does not fit.
**Done when:** a second site is detected through the same extractor interface with no change to the engine, and its parser is covered by tests.
- [ ] Build it: `/develop second site extractor`

### 15. Download history · needs a decision
Keep a local list of what was grabbed, with reopen and clear, so a download is not lost when the tab is gone.
**Done when:** every completed download appears in a local history with its title, site, time and path, entries can be reopened or cleared, and nothing leaves the machine.
- [ ] Design it (spec): `/architect download history`

## Slice 7: ship it

### 16. Local diagnostics view · needs a decision
Show what detection saw and why each candidate was kept or dropped, so failures are debuggable without a server and support answers are possible.
**Done when:** the popup can show the raw candidates, the reason each was kept or dropped, and the engine version, and the view can be copied into a bug report.
- [ ] Design it (spec): `/architect local diagnostics view`

### 17. Store release readiness · GA
Get it to a state that can pass a store review: least privilege, one version number, honest privacy disclosures, and a package that loads clean.
**Done when:** the manifest asks only for what the code uses, the version has one source of truth shared by the manifest and the popup, the listing and the data safety answers match what the extension does, and the packaged build loads unpacked with no errors.
- [ ] Design it (spec): `/architect store release readiness`

## Deferred
Out of scope for the current build pass, kept so the plan stays honest.
- **Firefox and Edge ports**: the same engine on other browsers · needs a decision
- **Per site settings**: toggles for particular sites beyond folder naming · needs a decision
- **Sync across machines**: settings and history on more than one device, which needs a server and a decision about the privacy promise · needs a decision
- **A headless mode**: reuse the engine outside the browser for scripting · needs a decision

## Legend

**The decision box.** Every feature carries exactly one, the sub-task whose label ends with `(spec)`. Its wording varies (`Design it (spec)` normally, `Decide the stack (spec)` on Stack & architecture), so skills locate it by that `(spec)` suffix, never by an exact label. Every other box is an execution box and `/architect` never ticks one.

**Feature lifecycle**: the scope updates as a feature moves; each row is what it shows and who sets it:

| State | Set by | The feature shows |
|---|---|---|
| `planned` · needs a decision | `/scope` | one box: `Design it (spec): /architect <feature>` |
| `in-progress` (designed) | **`/architect` at spec capture** | `Design it` ticked; spec linked; `Build it: /develop <feature>` + **2 to 5 milestones**; the tier's closing boxes (`Verify it` Alpha+, `Test it` Beta+, `Review it` + `Document it` GA); any surfaced follow-up enrolled |
| `in-progress` (building) | `/develop` | milestone sub-boxes tick one by one; code pointer filled |
| `in-progress` (verified) | `/check verify` | `Build it` + milestones ticked; `Verify it` ticked |
| `done` | **you, when you decide it is** (any skill sets it when you say so); `/sync` reconciles | boxes you ran ticked, skipped ones marked skipped; the tier's last stage (`Prototype` → after `/develop`; `Alpha` → after `/check verify`; `Beta`/`GA` → after `/test`) is the suggested point to call it done; `/sync` captures conventions |

- **Next step** = the first unticked box (always a command or a tracked milestone).
- **needs a decision** = run `/architect` first; otherwise straight to `/develop` (or `/audit` for standards and tooling). The tag drops once the spec is captured.
- **Atomic build tasks live in the spec's `## Build plan`, not here**: the scope carries only the milestone rollup.
- **Status** `planned` → `in-progress` → `done`, plus `existing` (pre-workflow) and `dropped` (de-scoped, kept for history).
- **Approach tag** beside a heading (e.g. `· Facade`) overrides the project default for that feature; no tag = inherits it.
- **Workflow tier tag** beside a heading (e.g. `· GA`, `· Alpha`) sets that one feature's rigor above or below the project default; no tag inherits the default. It decides the feature's check boxes and each skill's next suggestion.
- **Workflow** (header line) is the project default, what runs after `/develop`: **Prototype** = nothing (trust develop's own build time self check); **Alpha** = `/check verify`; **Beta** = `/check verify` then `/test`; **GA** = adds a fresh model `/check review` then `/document`. A feature built on an unratified decision (an `Assumed` spec) stays flagged, but that never blocks `done`.
- **Pointer line** (`spec <n> · code in <path>`): the spec link added by `/architect`, the code path by `/develop`.
