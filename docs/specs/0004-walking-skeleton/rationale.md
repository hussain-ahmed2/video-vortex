# 0004. Walking skeleton, rationale

*Build spec: see [index.md](index.md).*

## Context

The extension detects media today, and the detection lives in a `Map` inside the service worker.
Chrome stops that worker after thirty seconds of quiet, so a video found a minute ago is gone by
the time the user opens the popup. That single behaviour is what makes the extension feel broken,
and it is why spec 0001 exists: one pure engine shared as source by all three runtimes, per tab state
in session storage, one versioned and schema checked message map, and an extractor registry that a
content script matches against its own page URL.

Spec 0001 has decided all of that. It is `In Progress` and its feature is not done only because the
old pipeline has not been replaced yet, which is this slice's job. So this spec is mostly not a
design: it is the build spec for the first end to end path over an architecture that already exists.
What it does decide is how narrow that first path is, and a handful of things spec 0001 left to the
feature that runs it.

Scope feature 5 is the walking skeleton: a page plays a direct video file, the popup lists it, and
the download saves a real file. The project builds by Tracer Bullet, each capability end to end
through the worker, the content script, the popup and its tests, and working, before the next one
starts. So the question this spec answers is how little can be built while still being real end to
end, because everything built here is load bearing for the six slices that follow.

> ⚠️ Premise note: the scope row's Done when promises the popup shows the file "with quality and
> size", and half of that is not reachable in this slice. Spec 0001 states that the fallback
> extractor always emits `quality: 'unknown'` and only a site extractor sets a real label, and a
> direct file has no site to ask. So every row in the skeleton reads `unknown` for quality. The
> honest fix is not to invent a URL parse; it is for the scope row to mean "shows whatever quality
> is known", which for the fallback is `unknown`. This spec writes that into AC-1 and AC-2 so the
> contract is checkable, and `/scope` should decide whether to reword the row or accept this spec as
> the contract for slice 1.

One platform fact shaped the whole slice and is worth stating early, because it is the source of the
sharpest limitation in it. `chrome.webRequest` is a background only API. A content script cannot
hold a `webRequest` listener, so the observer has to live in the service worker, and a service
worker that Chrome has terminated is holding no listener at all. Chrome stops an idle worker after
about thirty seconds, and `webRequest` events wake it only while they are flowing. So the realistic
case is not "the extension was just installed", it is "this page played its video once, the worker
went to sleep, and the user opened the popup". Detection is therefore bounded by worker liveness in
a way that no amount of session storage fixes: the record survives, but new detection does not
happen while the worker is gone. AC-18 records this rather than hiding it.

Two other things shaped the slice without being decisions. The popup was rebuilt on a design
language in spec 0003, whose build plan deliberately left the row rebuild and the state rendering as
slice 1's work, tracked there so the contract lives in one place. And the test harness from feature 3
already exists, which is why the pure engine can be proven before a single runtime moves.

## Options considered

### Option 1: The narrow spine, network responses only

The worker observes `onHeadersReceived` and records media responses. No site extractor runs, no DOM
scan runs, the content script only supplies the title and reports URL changes. Video and audio are
both covered. The old pipeline is deleted as each runtime is rewritten.

**Pros**:
- One detection path, so one place can be wrong rather than three.
- `onHeadersReceived` is the earliest event carrying response headers, so a row appears when
  playback starts and it is the only event that can fill `sizeBytes` from `Content-Length`.
- A `<video src>` pointing at an mp4 is a request the browser makes, so the DOM scan would find the
  same rows by a second route.
- The engine stays pure, because nothing in it needs a page.

**Cons**:
- A `blob:` video is invisible, so the empty state is imprecise until feature 6.
- YouTube is invisible, which is a real loss of a capability the extension has today.
- Detection is bounded by worker liveness. A page whose media requests all completed while the
  worker was asleep lists nothing, which is the most likely first impression of the extension.

### Option 2: Network responses plus the DOM scan and the existing YouTube path

Keep `content.ts`'s DOM video and audio scan and its YouTube extraction, and add the network
observer beside them.

**Pros**:
- Nothing the extension can see today is lost, so no capability regresses during the rebuild.
- A `blob:` source attached to a media element is at least visible as a URL.

**Cons**:
- Two detection paths produce the same rows for a plain file, and every duplicate has to merge
  correctly through identity and the merge rule. That is the most subtle logic in the engine, tested
  against the most predictable input.
- The DOM scan would be reworked the moment feature 6 handles blob sources properly, so slice 1
  would build something slice 2 replaces.
- YouTube's extractor needs the `declarativeNetRequest` Referer rewrite, which is its own decision
  and belongs to feature 8. Pulling it forward means deciding that here too.

### Option 3: Wrap the existing pipeline in session storage

Leave detection where it is, and add a `StateStore` around the current `Map` so the list survives
the worker.

**Pros**:
- The smallest possible change, and it fixes the single behaviour that makes the extension feel
  broken.
- Nothing regresses, and no runtime is rewritten.

**Cons**:
- The engine stays impure, because detection would still be browser code in the worker, so spec
  0001's central decision is not honoured at all.
- Every later slice would then have to unpick it, and features 6 through 17 all assume the new
  spine exists.
- The `Map` holds per tab state in a global, which is the shape spec 0001 exists to remove.

## Rationale

Option 1 wins because the spine is the asset, not the detection coverage. The project's own
definition of Tracer Bullet says each capability is built end to end and works before the next one
starts, and the only thing this slice has to prove is that the new spine carries a real file from a
real page to a real file on disk. Every extra detection path in slice 1 is a path that has to be
tested against the merge and identity rules before any of them is needed, and the DOM scan is
specifically the one slice 2 replaces.

The sub decisions follow the same logic. Video and audio are both covered because the record already
carries `kind` and the popup already renders two lists, so audio costs almost nothing while
excluding it would mean writing that path twice. `quality` stays `unknown` because spec 0001 says the
fallback always emits it, and inventing a URL parse in the fallback would give feature 8's YouTube
extractor a competing source of truth for the same field. `lastWriter` is written even though nothing
reads it until feature 16, because the merge rule is specified field by field and a merge that
skipped a field would be a merge rule edit; the cost is a few bytes.

The old pipeline is replaced in place rather than run alongside, which is worth defending because it
resembles the big bang rewrite failure pattern. It is not one, for two reasons. Nothing has shipped:
this extension has never been in the store, so there is no production behaviour to protect and no
rollback to perform. And the replacement is incremental by construction, one runtime at a time, with
the pure engine proven before any runtime moves. The advice to build beside the old system and
retire it once the new one is proven is aimed at systems with users on them.

The badge counting `entries.length` plus `hiddenCount` is the same honesty argument the rest of this
project makes. A badge pinned at 50 while more was found is a quiet wrong number, and a quiet wrong
number is what spec 0003's hidden count disclosure exists to prevent. It may read higher than the
number of rows on screen, which is the correct trade.

Two decisions went the other way and are recorded as accepted limits rather than solved. The worker
liveness bound is real and unavoidable: the observer has to be in the worker because the alternative
API placement does not exist, and closing it would mean a persistent offscreen document, which spec
0001 already rejected as a whole extra context in its own manifest. The imprecise empty state on a
`blob:` page is a correctness problem that feature 6 fixes properly; rewording the copy in spec 0003
would make the wording true and the behaviour unchanged, which is not an improvement.

Several decisions here exist only to stop the design lying rather than to add capability, and they
follow one principle. `saveAs: false` so the browser names the file from our own rule rather than
opening a dialog the user can dismiss into a row that spins forever. `isDownloadable` so an HLS
manifest is listed with no button rather than offered as a file, which `chrome.downloads` would
otherwise happily save as text. `hiddenCount` derived from a counter rather than accumulated, because
accumulating double counts an entry that is dropped at the cap and then seen again. `sizeBytes` null
whenever a `Content-Encoding` is present, because a compressed `Content-Length` is the size before
compression and showing it would be a wrong number rather than a missing one. Each of these is a
case where the cheaper implementation produces a confidently incorrect answer.

One process note against myself, twice over. The filename rule was put to the engineer as an open
choice before it was checked against spec 0001, which already fixes it in six steps, and the option
offered, keep today's behaviour, would have produced `page_unknown.mp4` on every row because the
fallback always emits `unknown`. Later, an independent critique pass proposed moving the `webRequest`
listener into the content script, which is not possible because that API is not in the content script
surface. Both were cases of asserting something before checking what the parent spec or the platform
already settled. The lesson for the next slice is to read the parent spec's decision record and the
platform surface before asking a question either of them has already answered.

That critique pass also found twelve load bearing gaps that this spec did not have, including a
message contract that could not bind a download to a row and a content script the manifest was
already injecting on every page load. It probably ran on the same model that wrote the spec, so it is
a careful second pass rather than independent eyes, but the gaps it found were real and none of them
were cosmetic. A reader should assume this spec has had one adversarial read and not a genuinely
independent one.

## References

**Project sources** (verifiable, in this repo):
- `docs/specs/0001-detection-engine-architecture/index.md`, the umbrella decision and the cross child
  contract
- `docs/specs/0001-detection-engine-architecture/0001-state-store.md`, the data model, merge rule,
  port and lifecycle this slice implements
- `docs/specs/0001-detection-engine-architecture/0001-message-contract.md`, the five messages, the
  value sourcing table, the read path and the filename rule
- `docs/specs/0003-popup-design-language/index.md`, the design language the popup is rebuilt on and
  the source of the three displays
- `AGENTS.md`, the stack, the engine purity rule and the Tracer Bullet build approach
- `src/lib/schemas.ts`, the shapes this slice deletes and where each one moves to
- The `chrome-extensions` and `chrome-extension` skills, the MV3 runtime rules this slice is bounded
  by

**Practices & standards**:
- Incremental replacement over big bang rewrite, where nothing has shipped and there is no
  production behaviour to protect
- Ports and adapters, so the engine's rules are testable with no browser present
- Treating an unknown value as unknown rather than guessing one, which is why `sizeBytes` is nullable
  and `quality` is `unknown`
