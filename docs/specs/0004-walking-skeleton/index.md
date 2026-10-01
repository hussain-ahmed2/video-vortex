# 0004. Walking skeleton: detect, list, download

**Date**: 2026-10-01
**Status**: Proposed

## Summary

This builds the first slice that runs end to end on the new spine from spec 0001: a page plays a
direct video file, the extension notices the request, the popup lists it, and clicking saves a real
file with a real name. Nothing in it is faked, and nothing in it is a site specific extractor. The
point is to prove the spine works before any real site is targeted, so the skeleton watches network
responses only and covers video and audio alike. It also rebuilds the popup on the design language
spec 0003 settled, and retires the old detection pipeline as it goes.

Two limitations are stated up front rather than discovered later. Detection runs only while the
service worker is alive, because `chrome.webRequest` is a background only API and cannot live in a
content script. And rows read `unknown` for quality, because no site supplied a label.

## Requirements

**User stories**:
- As someone watching a video on a page, I want the extension to list it without me doing anything,
  so I can save it.
- As someone whose page exposes many media files, I want to know how many are not shown, so the
  list is not quietly lying to me.
- As someone who closed the popup and came back, I want the same list, so the extension does not
  look broken.

**Acceptance criteria** (the contract, each independently checkable):

- **AC-1**: A direct media request is detected by the worker observing `onHeadersReceived`, with
  `container` from the URL path extension or the response content type through a stated map,
  `sizeBytes` from `Content-Length` when the response states it, `kind` classified by container or
  content type, and `quality` recorded as `unknown` because no site supplied a label. Only 2xx
  responses are recorded, the recorded url is the one on the final response rather than the pre
  redirect url, and `sizeBytes` is null whenever the response carries a `Content-Encoding`.
- **AC-2**: Opening the popup on a tab with a stored record renders one row per entry, split into a
  video list and an audio list, each row showing the container, the quality or `unknown`, and the
  size when it is known.
- **AC-3**: The list is still present after the popup is closed and reopened, and after the service
  worker has been stopped, because the record lives in `chrome.storage.session` and never in a
  worker global. This is about the stored record only, not about new detection, which is AC-18.
- **AC-4**: Clicking download on a downloadable row saves a file whose name follows the six step
  rule in spec 0001's message contract, so `_<quality>` is never appended when the quality is
  `unknown`, the extension comes from the container or the URL path and is never guessed, and no
  path separator survives into the name. The download is requested with `saveAs: false` so the
  browser names the file from that rule. A row whose container is not downloadable, meaning `m3u8`,
  `mpd` or anything a manifest rule rejects, renders with no download control at all. A download
  that returns `{ ok: false }` returns its row to the download control rather than leaving it in
  `in_progress`.
- **AC-5**: Every message crossing a runtime boundary is one of the five named in
  `src/engine/messages.ts`, is parsed with zod before use, and every request among them carries the
  contract version.
- **AC-6**: The popup re reads on `TAB_MEDIA_UPDATED` and on demand, and never polls for detection
  data on a timer.
- **AC-7**: The pure engine modules (types, messages, media rules, identity, state port, merge,
  filename) are covered by tests that run with no browser and no network, and the harness gains
  `webRequest` and `action` fakes so the worker's observer, the badge, and the two reports arriving
  together are testable rather than only hand walked.
- **AC-8**: The content script reports `document.title` and page URL changes and nothing else. No
  media entry originates in the content script, so `ENTRIES_REPORTED.entries` is an empty array in
  this slice and the message carries the title.
- **AC-9**: Merges for one tab are serialised, so two reports arriving together cannot lose an
  entry.
- **AC-10**: At most 50 entries are kept per tab, the oldest `discoveredAt` is dropped first, and
  `hiddenCount` is recomputed on every save as the number of distinct identities seen minus the
  number of entries currently held, so an entry that is dropped and then seen again is not counted
  twice. The popup shows the hidden count line when that count is above zero.
- **AC-11**: A record whose stored `pageUrl` no longer matches the tab's current URL is deleted and
  the read carries on as if there were no record, and closing the tab deletes its record and
  removes its id from the index key.
- **AC-12**: A tab that cannot host a content script yields `status: 'unsupported'` and the popup
  names that state instead of showing an empty list. The predicate is a scheme and host denylist
  covering `chrome:`, `about:`, `edge:`, the Chrome Web Store and another extension's pages, plus a
  content script injection that reports failure. The verdict is decided per read and is never
  stored, so a tab the user later grants file access to is simply hostable on the next read.
- **AC-13**: The manifest gains the `scripting` permission, drops `declarativeNetRequestWithHostAccess`,
  and drops its declarative `content_scripts` entry so the content script is injected on demand
  rather than on every page load. Host access to all sites is already declared and stays.
- **AC-14**: `src/lib/schemas.ts` no longer exists. `VideoSource` is `MediaEntry` in
  `src/engine/types.ts`, `DownloadState` and `DownloadStatus` live in `src/engine/messages.ts`, and
  no runtime file declares its own message type.
- **AC-15**: The YouTube banner, the `YouTubeMeta` type and the `FETCH_YOUTUBE_DATA` message are
  absent from the popup, the worker and the schemas.
- **AC-16**: The toolbar badge shows the number of entries held plus `hiddenCount`, capped at `99+`,
  so it never understates what was found and never overflows the four characters the browser
  renders. It is cleared when a record is deleted.
- **AC-17**: The popup rows are rebuilt on spec 0003's language: rows at least `min-h-10`, controls
  at `h-8 w-8` carrying accessible names, and both state vocabularies rendered. All three displays
  are present, each under its stated condition: the hidden count line only when `hiddenCount` is
  above zero, the staleness line beside the list from `updatedAt`, and the loading hint only after
  three seconds of `observing`. The staleness string is recomputed from `updatedAt` on a one second
  interval that re reads no data, so AC-6 still holds. The copy this slice owns is fixed: `Size
  unknown` when `sizeBytes` is null, `Downloading {n}%` for determinate progress, `Downloading,
  size unknown` for indeterminate progress, `Download failed` when a download returns
  `{ ok: false }`, and `Download interrupted` when the transfer is interrupted.
- **AC-18**: Detection runs only while the service worker is alive, because `chrome.webRequest` is
  a background only API and a content script cannot hold the listener. A page whose media requests
  all completed before the worker was terminated needs a new request or a reload before its media is
  listed. This is a chosen limitation, recorded so it reads as a decision rather than a bug, and it
  is why the read path re registers the listener on every worker start.
- **AC-19**: The popup's Refresh control re sends `GET_TAB_MEDIA` on demand, which also re runs the
  injection branch when there is no record. It is not a rescan and adds no message, because spec
  0001 forbids a start message.

## Decision

**Chosen option**: Option 1, the narrow spine. The skeleton watches network responses only, runs
no site extractor, and replaces the existing pipeline in place rather than running beside it.

**Implementation skills**: `chrome-extensions` (`googlechrome/modern-web-guidance`,
`.agents/skills/chrome-extensions/`) · `chrome-extension` (`samber/cc-skills`,
`.agents/skills/chrome-extension/`) · `chrome-webstore-release-blueprint` (`brianlovin/agent-config`,
`.agents/skills/chrome-webstore-release-blueprint/`)

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Feature design

**Data model sketch**: two entities, fully specified in spec 0001's state store child, plus one
counter this slice needs and one field this slice adds.

| Entity | Key fields | Null | Notes |
|---|---|---|---|
| `TabMedia` | `tabId`, `pageUrl`, `pageTitle`, `status`, `lastWriter`, `updatedAt`, `hiddenCount`, `seenCount`, `entries` | none | One record per tab, stored at `vv:tab:<tabId>`, with `vv:tabs` holding the live tab ids |
| `MediaEntry` | `url`, `container`, `quality`, `kind`, `sizeBytes`, `sources`, `discoveredAt` | `sizeBytes` only | Embedded in its `TabMedia`, never a key of its own |

`seenCount` is new and is the only addition to spec 0001's record. `hiddenCount` is derived from it
rather than accumulated, because accumulating it double counts an entry that is dropped at the cap
and then seen again. Spec 0001's state store child needs the amendment, which is a Follow up below.

Identity of an entry is `(tabId, url, container, quality)`, with one exception: `container:
'unknown'` compares equal to itself across findings, so one file first seen without a path extension
and again with one stays a single entry.

**State transitions**:

| Entity | From | To | Trigger |
|---|---|---|---|
| `TabMedia.status` | no record | `observing` | The worker injects a content script onto a tab with no record |
| | `observing` | `ready` | The title only report arrives |
| | any | `blocked` | The page refused page level access. Not reachable in this slice, because only an extractor sets it and none runs |
| | any | `unsupported` | Decided per read by the predicate in AC-12, never stored |
| | any | no record | Real navigation, a page URL change, a stale `pageUrl` on read, or the tab closing |
| download | none | `in_progress` | The user clicks download and the call is accepted |
| | `in_progress` | `complete` | `chrome.downloads` reports the transfer finished |
| | `in_progress` | `interrupted` | The user cancels, or the transfer fails |
| | `in_progress` | none | The call returns `{ ok: false }`, so the row returns to its download control |

**API surface**: there is no HTTP surface. The five messages in spec 0001's message contract are the
whole interface between the three runtimes, and none of them exists only to route.

| Message | From and to | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `ENTRIES_REPORTED` | content script to worker | `contractVersion`, `pageUrl`, `pageTitle`, `status`, `entries` (empty in this slice) | `{ ok: true }` | extension internal, no auth | A `pageUrl` that does not match the record replaces it rather than merging |
| `GET_TAB_MEDIA` | popup to worker | `tabId` | `record`, `needsReport`, `status`, `inFlight` | extension internal, no auth | A stale record is deleted and the read continues; an unhostable tab returns `unsupported` |
| `TAB_MEDIA_UPDATED` | worker to popup, broadcast | `tabId` | none | extension internal, no auth | The popup ignores a broadcast naming another tab |
| `DOWNLOAD_MEDIA` | popup to worker | `url` | `{ ok, downloadId?, error? }` | extension internal, no auth | A url absent from the record, a non downloadable container, or a rejection from `chrome.downloads` |
| `DOWNLOAD_PROGRESS` | worker to popup, broadcast | `downloadId`, `url`, `bytesReceived`, `totalBytes`, `state` | none | extension internal, no auth | Chrome reports an unknown total as minus one, which the engine maps to null |

Two amendments to spec 0001's message contract are required and are raised as Follow ups, not applied
here: `url` on `DOWNLOAD_PROGRESS` and on `InFlightDownload`, without which a row cannot be paired
with its download on a cold read, and a rule that `inFlight` is filtered to the urls present in the
record being returned, because `chrome.downloads.search({})` returns every remembered download
across every tab with no tab id.

**Value sourcing**: every value an acceptance criterion needs, traced to a named source.

| Action | Value produced or displayed | Source |
|---|---|---|
| Detect a request | `container` | URL path extension first, then the response content type through the map below, then `unknown` |
| Detect a request | `sizeBytes` | `Content-Length` on the `onHeadersReceived` event; null when the response states none, when the status is not 2xx, or when a `Content-Encoding` is present. Never computed |
| Detect a request | `kind` | Derived from `container` or content type by `src/engine/media-rules.ts` |
| Detect a request | `quality` | Always `unknown` from the fallback, per spec 0001; only a site extractor sets a label |
| Detect a request | `sources` and the draft's `reason` | The fallback extractor's id and the literal `network response`, both constants in `src/engine/identity.ts` |
| Detect a request | Which response to record | The event's `statusCode` and `url`; only 2xx, and the url on the final response |
| Cap the list | `hiddenCount` | `seenCount` minus `entries.length`, recomputed on every save, never incremented |
| Read for the popup | `record` | `chrome.storage.session` through the `StateStore` port |
| Read for the popup | `status` | The stored record's status, except `observing` and `unsupported` which the worker decides itself |
| Read for the popup | `inFlight` | `chrome.downloads.search({})` at read time, filtered to the urls in the record being returned |
| Display a row | Quality text | The entry's `quality`, which is `unknown` throughout this slice |
| Display a row | Size text | `sizeBytes`, rendered only when it is not null |
| Display a row | Size unknown copy | The literal `Size unknown`, fixed by AC-17 |
| Display the hidden count | Hidden count line | `TabMedia.hiddenCount`, formatting fixed in spec 0003 |
| Display staleness | "Updated Ns ago" | `TabMedia.updatedAt`, recomputed on a one second interval that reads no data, formatting fixed in spec 0003 |
| Display the loading hint | Whether to show it | Three seconds in the `observing` state, a decision in its own right now that the poll it matched is gone |
| Display progress | Determinate label | The literal `Downloading {n}%`, where the number and the clamp to 100 are spec 0003's, applied when `totalBytes` is not null |
| Display progress | Indeterminate label | The literal `Downloading, size unknown`, which this spec owns, over spec 0003's empty track, when `totalBytes` is null, which is Chrome's minus one per spec 0001 |
| Report a failure | Failure copy | The literal `Download failed` |
| Report an interruption | Interruption copy | The literal `Download interrupted` |
| Download | `filename` | Derived in the worker by `src/engine/filename.ts`, never sent by the popup and never stored |
| Download | Whether to save | `saveAs: false`, so the browser names the file from our rule |
| Download | `downloadId`, progress | `chrome.downloads.download` and `chrome.downloads.onChanged`, then `chrome.downloads.search` |
| Badge | Badge count | `entries.length` plus `hiddenCount`, capped at `99+`, cleared when the record is deleted |
| Refresh | What the control does | Re sends `GET_TAB_MEDIA`, which re runs the injection branch when there is no record |

**The content type to container map**, which spec 0001's extractor interface requires to exist and
never enumerates. It lives in `src/engine/media-rules.ts`.

| Content type | Container |
|---|---|
| `video/mp4`, `audio/mp4` | `mp4` |
| `video/webm`, `audio/webm` | `webm` |
| `video/ogg`, `audio/ogg`, `application/ogg` | `ogg` |
| `video/mpeg`, `audio/mpeg` | `mpeg` |
| `video/quicktime` | `mov` |
| `application/vnd.apple.mpegurl`, `application/x-mpegurl` | `m3u8` |
| `application/dash+xml` | `mpd` |
| anything else | `unknown` |

The known container list, used by `isDownloadable` and by the filename rule's extension step, is
`mp4`, `webm`, `ogg`, `mpeg`, `mov`, `m4v`, `mkv`, `avi`, `flv`, `wav`, `aac`, `flac`, `opus`, `m3u8`
and `mpd`. Only the containers Chrome can save as a single file are downloadable, which excludes
`m3u8` and `mpd` because they are manifests describing other files rather than media themselves.

**Popup copy this slice owns**, fixed by AC-17. Spec 0003 states that the caller owns the copy and
supplies it for none of these states, so they are fixed here rather than left to the build.

| State | Copy |
|---|---|
| `sizeBytes` is null | `Size unknown` |
| Determinate progress | `Downloading {n}%` |
| Indeterminate progress, `totalBytes` is null | `Downloading, size unknown`, over spec 0003's empty track, its decided treatment for this case |
| The download call returned `{ ok: false }` | `Download failed` |
| The transfer was interrupted | `Download interrupted` |

**Key invariants**:
- Code under `src/engine/` never calls a browser API at run time.
- The worker is the only writer of detection state.
- Every payload is parsed before use, and `contractVersion` is one constant in the engine.
- Message names and shapes live in `src/engine/messages.ts` only.
- Merges for one tab run one at a time through a promise chain, because `await` yields.
- A record that fails schema validation on read is discarded, not repaired.
- `sizeBytes` is a number the response gave, or null. Never computed, never guessed, and never a
  compressed transfer size.
- At most 50 entries per tab, `discoveredAt` is a last seen time so a source that keeps being
  reported is never the one dropped, and `hiddenCount` is derived rather than accumulated.
- `container: 'unknown'` compares equal to itself across findings.
- Nothing leaves the browser. No entry is sent anywhere.
- The filename never contains a path separator, so a download cannot write outside the download
  directory.
- The popup never re reads detection data on a timer.

**Security model**: one actor, the person using the extension, and one privileged action, saving a
file they chose. There is no authentication, no authorisation, no tenancy and no personal data,
because nothing leaves the browser. The trust boundary is the page's own content, and it is handled
three ways: `pageTitle` is untrusted text rendered as text and never as markup, the filename rule
rejects path separators, and Manifest V3 forbids remote code so the engine must be bundled. Host
access to all sites is already declared and stays, justified by the observer needing to see every
site's requests.

**Critical test scenarios** (each maps to an acceptance criterion):
- Happy path: a page plays a direct mp4, the observer records it, the popup lists it with container
  and size, and the download saves a file, verifies **AC-1**, **AC-2**, **AC-4**
- Survival: the worker is stopped for longer than its idle timer, then the popup opens and the same
  list is there, verifies **AC-3**
- Worker asleep: a page requests a video, the worker terminates, a later request arrives while it is
  gone, and the second video is absent until something wakes the worker, verifies **AC-18**
- Concurrency: two reports for the same tab arrive together and both survive, verifies **AC-9**
- Cap: a page exposing more than 50 sources keeps the 50 most recently seen, derives `hiddenCount`
  correctly, and the popup says so, verifies **AC-10**
- Cap and reappearance: an entry dropped at the cap is seen again and does not inflate
  `hiddenCount`, verifies **AC-10**
- Staleness: the tab navigated while the popup was closed, so the stored `pageUrl` no longer
  matches and the record is deleted, verifies **AC-11**
- Untrusted input: a page sets `document.title` to markup, and the popup renders it as text,
  verifies **AC-2**
- Unhostable tab: the popup opens on the Chrome Web Store page and gets `unsupported`, not an empty
  list, verifies **AC-12**
- Non downloadable: an `.m3u8` manifest is listed with no download control, verifies **AC-4**
- Redirect: a media URL answers 302 then 200, and one entry is recorded with the final url, verifies
  **AC-1**
- Encoded body: a response carries `Content-Encoding: gzip`, and `sizeBytes` is null, verifies
  **AC-1**
- Dismissed dialog: a download returns `{ ok: false }` and the row returns to its control, verifies
  **AC-4**

## Build plan

Ordered by Tracer Bullet, the project default: the thinnest thread that works end to end first, then
the thickness. The engine's pure modules come first because they carry no browser dependency and can
be proven with the existing harness before any runtime moves. The data model needs no separate
migration: session storage has no schema to migrate, so the storage surface lands with the worker
task that writes it.

This slice creates seven engine modules. `src/engine/match.ts`, `src/engine/page-access.ts` and
`src/engine/extractors/` are not created here and arrive with features 6 and 8.

1. Write `src/engine/types.ts` and `src/engine/messages.ts`: the record including `seenCount`, the
   entry, the draft, the five messages and their zod schemas, plus the contract version constant,
   with tests that parse every message both ways, satisfies **AC-5**, **AC-10**, **AC-14**
2. Write `src/engine/media-rules.ts` and `src/engine/identity.ts`: the content type to container
   map and the known container list above, `isDownloadable`, kind classification, the identity
   tuple with `unknown` comparing equal to itself, and the fallback's id and `reason`, with tests,
   satisfies **AC-1**, **AC-4**
3. Write `src/engine/state-port.ts`: the four typed operations the engine declares, plus the in
   memory implementation the tests supply, satisfies **AC-3**, **AC-7**
4. Write `src/engine/merge.ts` and `src/engine/filename.ts`: the field by field merge, the fifty
   entry cap, `hiddenCount` derived from `seenCount`, the per tab serialisation helper, and the six
   step filename rule, with tests covering a merge, a cap eviction, a reappearing entry and every
   filename step, satisfies **AC-4**, **AC-9**, **AC-10**
5. Add `webRequest` and `action` fakes to the harness under `src/testing/chrome/`, so the observer,
   the badge and the two reports arriving together have a test path, satisfies **AC-7**, **AC-9**,
   **AC-16**
6. Change `public/manifest.json`: add `scripting`, drop `declarativeNetRequestWithHostAccess`, and
   drop the declarative `content_scripts` entry so injection is on demand, satisfies **AC-13**
7. Rewrite the worker's detection half: the `onHeadersReceived` observer filtered to 2xx media
   responses using the final response's url, writing through the port, with the index key
   maintained in the same storage operation, the startup reconciliation and listener re
   registration, `chrome.tabs.onRemoved` removing the record, and the badge count capped at `99+`,
   satisfies **AC-1**, **AC-3**, **AC-16**, **AC-19**
8. Rewrite the worker's message half: the five messages, the read path with the stale `pageUrl`
   check, the `unsupported` predicate and the injection branch, `chrome.downloads` with
   `saveAs: false` and its progress, `inFlight` filtered to the record's urls, and the broadcast
   only when the merged record differs, satisfies **AC-5**, **AC-6**, **AC-11**, **AC-12**, **AC-17**
9. Rewrite `src/content.ts` down to reporting `document.title` and page URL changes, with the
   `globalThis` contract stamp so a duplicate or stale injection returns early, satisfies **AC-8**
10. Delete `src/lib/schemas.ts` along with the YouTube banner, `YouTubeMeta`, `FETCH_YOUTUBE_DATA`
    and the remaining old pipeline in both runtimes, satisfies **AC-14**, **AC-15**
11. Rebuild the popup: rows at `min-h-10` with `h-8 w-8` controls and accessible names, both state
    vocabularies, the three displays each under its condition, the one second staleness interval
    that reads no data, the copy table above, non downloadable rows with no control, and the read
    on `TAB_MEDIA_UPDATED` instead of the poll, satisfies **AC-2**, **AC-6**, **AC-17**, **AC-19**
12. Walk the skeleton by hand on a real page and confirm AC-18 reads as the chosen limitation rather
    than a surprise, satisfies **AC-18**

Every acceptance criterion traces to at least one task and every task to at least one criterion.

## Consequences

**Positive**:
- The list survives the worker being stopped, which is the single biggest fix in the rebuild.
- One detection path, so one place can be wrong instead of three.
- The engine is testable with no browser at all, which is what the existing harness was built for.
- The popup finally obeys the design language spec 0003 settled, so the next slices inherit it.
- The old pipeline and its dead YouTube half go away rather than lingering beside the new one.
- Rows that cannot be saved say so by having no button, instead of offering a manifest as a file.

**Negative / tradeoffs**:
- YouTube detection is gone for three slices. The extension loses a capability it has today, and
  that is a real regression until feature 8 lands.
- Detection stops when the worker does. A page that played its video and then idled will not list
  anything until it issues a new request or reloads, which is the most likely first impression of
  the extension.
- The empty state stays imprecise. A `blob:` video is invisible to a network observer, so the popup
  says no media detected on a page that is playing media. Feature 6 owns the fix.
- Every row reads `unknown` for quality, so the row is less informative than the scope row's Done
  when implies.
- Replacing in place means the unpacked extension does not work between commits. Nothing has
  shipped, so no user is affected, but it will feel broken while the slice is being built.
- `seenCount` is a field nothing outside the cap reads, which is spec 0001's lean rule bent once. It
  is the price of an honest `hiddenCount`.
- The badge can read higher than the number of rows on screen, and caps at `99+`, which is honest
  but may look like a bug to a user who has not read the hidden count line.
- The Refresh control no longer forces a fresh look at the page, because spec 0001 forbids a rescan
  message. It re reads and re injects, which is as much as the contract allows.
- A compressed response reports no size at all, so the row says `Size unknown` rather than a wrong
  number.

**Neutral**:
- Seven engine modules, a subset of the layout spec 0001 named.
- Every message is parsed with zod in every runtime, which costs a little on each report.
- Session storage is cleared when the extension reloads, so every reload looks like a bug until the
  worker re injects. This will bite repeatedly during development.
- A write per report rather than per entry, which spec 0001 already accepted as cheap at this size.
- `blocked` is rendered but unreachable in this slice, because only an extractor sets it.

## Follow-up

- [ ] Spec 0001's message contract needs `url` on `DOWNLOAD_PROGRESS` and on `InFlightDownload`, and
  a rule that `inFlight` is filtered to the urls in the record being returned. Without both, a
  popup opened cold during a download cannot tell which row is in flight.
- [ ] Spec 0001's state store child needs `seenCount` added to `TabMedia` and `hiddenCount` changed
  from an accumulated count to a derived one, which AC-10 depends on.
- [ ] Spec 0001 contradicts itself on where the fallback lives: its extractor interface puts the
  generic observer at `src/engine/extractors/`, while its boundaries child puts request observation
  in `background.ts`. This slice follows the boundaries child. The extractor placement should be
  settled before feature 6 builds `extractors/`.
- [ ] Spec 0001's state store child says a static `declarativeNetRequest` ruleset needs no
  permission of its own, which is false. Feature 8 will hit this when it ships the rules file.
- [ ] Spec 0001's message contract assigns a `world: 'MAIN'` proof to slice 1. This slice has no
  extractor that needs page access, so the proof is deferred to feature 8.
- [ ] The scope row's Done when says the popup shows the file "with quality and size". For the
  fallback the quality is always `unknown`, so AC-1 and AC-2 are the real contract. `/scope` may
  want to reword the row, or accept this spec as the contract for slice 1.
- [ ] Scope feature 5 has no `Design it (spec)` box, unlike features 1, 3 and 4. `/scope` owns
  adding it; this spec is the build spec either way.
- [ ] Root `AGENTS.md` says shared shapes live in `src/lib/schemas.ts`, which AC-14 makes false at
  task 10. `/sync` owns the correction.
- [ ] Spec 0001's feature 1 Done when asks for the old pipeline to be marked as replaced. Task 10
  discharges it, and `/scope` owns ticking that box.
- [ ] Spec 0001's state store child left the merge, identity, cap and per tab serialisation tests to
  feature 3. Task 4 lands them here, so that follow up is discharged by this feature.
- [x] Spec 0003 left the indeterminate progress treatment undecided. Decided on 2026-10-01: an
  empty track, with spec 0003's motion rule amended to say the bar does not take the `motion-safe:`
  opt in that AC-8 permits. Spec 0003's token table, components table, states table, motion rules and
  rationale now carry it, so task 11 renders it rather than inventing it. The amendment ratifies what
  the shipped popup already renders, so it changes nothing that is drawn.
- [ ] Whether host access is declared at install time or requested on demand is a store question,
  and belongs to feature 17 rather than here.
- [ ] `verify.md` is not written yet. `/check verify` creates it when the slice is built.
