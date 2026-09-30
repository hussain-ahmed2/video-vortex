# 0001 Detection engine architecture, reasoning and evidence

*Decision record for the umbrella [index.md](index.md). Read by humans and by `/architect` on a later update. `/develop` skips this file.*

> ⚠️ Premise note: the plan puts four foundations (scope features 1 to 4) in front of the first line of engine code, so the first end to end proof arrives after four deliberations rather than one. That is the safe order, not the fast one, and it is the one risk in an otherwise well sliced arc. The cheapest fix is to let the popup design language (feature 4) slip to just before the popup work inside slice 1, since slice 1's popup is a list and a button: a minimal visual pass is enough to prove the spine, and the full language lands before the UI grows. The second note is about process rather than architecture: a GA workflow runs verify, test, a fresh model review and document on every one of seventeen features, which is heavy for a project this size. Beta keeps verify and test, and feature 17 can carry a `· GA` tag on its own. Both are recommendations, and the scope header records whichever you keep.

## Context

The extension has three runtimes and three files that each know a little about everything. `src/background.ts` watches requests and holds the per tab results in a `Map` in memory. `src/content.ts` finds videos in the DOM and injects a script into the page to read YouTube's player data. `src/App.tsx` asks the worker for a list, asks the content script for the page title, and downloads what the user clicks. They agree by hand, in string message names, and they have drifted.

Three concrete failures follow from that arrangement, all verified by reading the code and the platform documentation rather than by running it.

**Detected media disappears.** The per tab results live in a `Map` inside the service worker. Chrome stops an idle worker after 30 seconds, and any extension API call is what restarts the clock (basis: MV3 service worker lifetime). So a video found while the popup was open is gone by the time the user opens it again, and the popup truthfully reports nothing, for a video that is playing.

**The YouTube header rewrite does not run.** `src/background.ts:8` registers a blocking request listener to set `Referer` and `Origin` for the video CDN. The permission that blocking form needs is no longer available to an ordinary extension, and header modification moved to declarative rules (basis: the MV3 migration guidance). The listener is registered, the manifest asks for a related permission, and nothing happens.

**Most real sites are never detected at all.** The sniffer matches request URLs ending in `.mp4`, `.webm`, `.m3u8` and a handful of others. Most sites do not request a video file; the browser assembles the stream in memory from many small requests, so there is no file extension to match. Meanwhile the DOM scan in `src/content.ts` is never called by the popup, so it is dead code. Deciding what to do about the missing streams is scope feature 6's decision, but the engine needs a seam for it, which is why extractors are part of this decision.

Two forces shape what is acceptable in the answer. The privacy promise in the README ("all detection happens locally, no data ever leaves your browser") is also a store disclosure answer now that this is going to the Chrome Web Store, and it rules out any helper service. And the chosen test target is pure logic plus the message contract, which is only reachable if the code holding the rules can be imported with no browser present at all.

One thing the plan gets right and should keep: the old implementation is replaced slice by slice, with each slice working end to end, rather than all at once. That is the difference between a rebuild and a rewrite, and it is why this decision can be trusted before any of it is built.

## Options considered

### Where the shared rules live

**One engine folder all three entry points import.** One implementation of the rules, testable with no browser, at the cost of a few duplicated kilobytes per bundle.

**A separate engine bundle that only the worker owns.** One copy and one owner, but every read becomes a round trip, so the popup can no longer render from a value it already holds, and the testable code ends up one message away from the code that is hardest to test.

**Logic left inside each runtime, sharing only types.** Nothing is coupled, and it is the arrangement that produced the current drift. Three copies of every rule means three tests per rule.

### Where a tab's detected media lives

**`chrome.storage.session`, one key per tab.** The documented mechanism for keeping state across a worker restart. Cleared when the browser closes, which is correct here because the tabs are gone too (basis: the chrome.storage documentation).

**`chrome.storage.session` plus a keepalive ping on an open port.** Keeps state in memory instead of on the hot path, at the cost of a timer per open tab. Rejected on evidence: an open port stopped resetting the worker timer in Chrome 114, so this leans on ping timing the platform can change (basis: the service worker lifecycle documentation).

**`chrome.storage.local`.** Survives browser restarts, which download history will want. Wrong here: it writes to disk, needs cleanup for dead tabs, and grows without bound.

**An offscreen document holding state in memory.** Real memory, no serialisation. A whole extra context and manifest surface covering ground session storage already reaches.

### How the runtimes talk

**One typed map of six messages, parsed with zod at both ends, versioned.** Catches the failure this project actually has, where a payload is right in the editor and wrong on the wire. Upfront schema cost.

**Plain string types with hand written interfaces, no runtime check.** Less code, and the compiler catches most mistakes. Nothing catches a wire level mismatch, which is exactly what the current content script handshake is.

**A full request and response layer with ids and promises.** The nicest to call, and what the extension architecture skill recommends in general. A lot of machinery for six messages, most of them one way, and awkward to unit test without the real runtime.

### How a site plugs in

**A registry of extractors matched on the page URL, with the generic observer as the fallback.** Adding a site is a new file. The only shape of the three where YouTube is expressible, because a player response is not pattern matchable.

**One generic extractor driven by per site configuration.** One code path, and adding a site is data. It becomes a small untyped scripting language the moment a site needs to read a player response.

**A declared content script per site in the manifest.** The best permission story and the smallest injected footprint, at the cost of a file and a manifest edit per site, plus a separate all pages script for the fallback anyway.

### What happens to the current implementation

**Rewrite in place as each slice lands, delete the old path.** Two engines at once is two things to debug, and the scope already marks the old pipeline superseded.

**Keep it behind a setting until the new engine has proved itself.** A real safety net, and the cost is two engines plus a permanent switch.

**Archive the files out of the build.** Reference material for porting logic, and dead code that rots.

## Rationale

The three failures in Context have one root: no single place owns the rules, so nothing can be tested, nothing can be reasoned about, and state has nowhere to live that outlives a worker Chrome is allowed to stop. Each of the four child decisions removes one symptom of that root, and they are sequenced so each one is useful on its own: boundaries make the rules testable, the state store makes them durable, the contract makes the three runtimes agree, and the extractor interface makes sites pluggable. None of the four is a prerequisite for the others, which is deliberate, since the arc builds them in that order and each one lands before the slice that needs it.

The state store choice was settled by evidence rather than preference. Chrome documents session storage as the way to hold state that globals cannot, and it is the only option that needs no trick to stay alive. The keepalive alternative looks attractive until you check what changed in Chrome 114, at which point it is a bet on undocumented timing.

The engine purity rule is the constraint that makes the chosen test target possible at all, and it was the one question where the recommendation and the test plan pointed the same way. It costs indirection on every effectful action, which is a real price, and it is worth paying because the alternative is a test suite that needs a fake browser to run anything.

The privacy line has a consequence worth stating plainly rather than discovering later. YouTube's signature protected formats normally need a server to help read them, and that is now forbidden, so the flagship case will most likely be narrower than users expect. That is a product decision the engineer made with the tension named, and the honest engineering response is to solve it locally in feature 8 or to say plainly that those formats are not offered. Quietly adding a service later would break both the README and a store disclosure.

## Platform evidence

Checked on 2026-09-30 against official Chrome documentation, by a read only research pass. Facts that changed the design are marked.

- **Blocking request listeners are gone for ordinary extensions.** `webRequestBlocking` is no longer available to most extensions; header modification moved to declarative rules with `urlFilter` in the rule file. Observation is otherwise unchanged (basis: the MV3 migration guidance). *This is why the YouTube header path moves to a ruleset.*
- **Service worker lifetime.** Idle timeout 30 seconds. Since Chrome 110 any extension API call resets it, not only a running handler. Since Chrome 114 sending a message on a long-lived port resets it but merely opening one does not. Hard ceiling of 5 minutes for a single request. Officially recommended homes for state and periodic work: `storage.session` and `chrome.alarms`. *This is why in-memory state with a keepalive was rejected.*
- **`chrome.storage.session`.** In memory, never written to disk, 10 MB quota (raised from 1 MB in Chrome 112), survives worker termination within a browser session, cleared on browser restart and on extension reload, update or disable. Not exposed to content scripts unless explicitly opened up. *This is the state store.*
- **Page world access.** `chrome.scripting.executeScript` with `world: 'MAIN'` exists and needs the `scripting` permission plus host access. The page's own Content Security Policy still applies to injected main world code, so it does not bypass a strict page policy. The older injected script tag approach is not officially recommended and is broken by page CSP on inline scripts. Chrome's own documented messaging path for page to content script is `window.postMessage` plus a port. *This is why blocked injection is a named status and not a silent hang.*
- **Cross origin visibility.** Seeing a sub resource needs host access to both the requested URL and its initiator. `<all_urls>` already covers it, so no manifest change for this.
- **A static `declarativeNetRequest` ruleset needs no permission.** The `declarativeNetRequest` permission covers dynamic and session rules. A rules file shipped with the extension runs on host permissions alone, so the manifest drops a permission rather than adding one. *This is why the permission list shrank.*
- **Install time host access.** Requesting every site produces a read and change all your data on all websites warning. The alternative is optional host permissions granted per site. This was weighed and the broad grant was kept, deliberately, over minimising; it is recorded as a store risk to revisit in feature 17.
- **`chrome.debugger`.** Can instrument the network and, since Chrome 118, keeps the worker alive. Rejected: a persistent "being debugged" bar on every page plus an install time permission warning, which is a poor trade for a store release.
- **Manifest V2 is finished.** All remaining MV2 extensions were removed from the Web Store on 2026-08-31, Chrome 138 was the last version supporting it, and the availability policy is gone in Chrome 139. Nothing to plan for.
- **Not verified.** Whether a page's Trusted Types policy blocks a main world injection is unconfirmed; treat it as a risk, not a fact. Whether the `browser.*` namespace is fully available from Chrome 148 is unconfirmed and not needed here. The exact 2026 state of host permission prompting and user gesture requirements was not confirmed, only that no changes surfaced in four searches.

## What the cross check changed

An independent model read the five spec files and critiqued them before the engineer accepted. It found two things this author had got wrong, one design that could be simpler, and a set of values with no named source. Recording it here because the shape of the final design is not the shape it started as.

- **A false invariant.** The first draft claimed a single writer removes merge races. It does not: an `await` between a read and a write lets a second report interleave and one finding is lost. The invariant is now per tab serialisation through a promise chain, which is a mechanism rather than an assumption.
- **Two enum values with no producer.** `observing` and `unsupported` appeared in the record's status with nothing that ever set them, so the popup could wait forever on a page it can never read. Both now have a named producer, and the precedence when several extractors report is stated.
- **A message that did not exist.** The read path had the worker asking the content script to report, with no message to do it. The fix removed the need for one: the content script reports on load, and the worker injects one when a tab has no record, guarded by a build stamp that also solves the stale content script left behind by an extension reload.
- **Purity versus hooks.** The first draft listed extractors under the pure engine while also saying they install hooks and read pages. The page access port resolves it, and it happens to be the seam feature 6 needs.
- **The simplification.** Routing was the one heavy piece left. The worker sent the list of extractors to run, which needed a message, a handshake and a version round trip after every reload, to tell a content script something it could work out from the URL it already had. Moving the match into the content script deleted a message and left both load bearing guarantees intact. It changes an earlier decision, so it was put to the engineer rather than applied.
- **The fallback would have listed fonts and ads.** The generic observer now requires a media content type or a known container, which is what stops a page full of images producing a list of images.
- **Downloadability became derived, not stored.** A blob URL and a manifest container cannot be handed to the download manager, so the engine derives the verdict and the popup renders a row with no button, rather than a button that fails.

## References

**Project sources** (verifiable, in this repo):
- `AGENTS.md` and `src/AGENTS.md`, the stack, the rules and the traps of the three runtimes
- `docs/scope/scope.md`, the arc, the workflow default, and the four scope features this decision feeds
- `src/background.ts:8`, the blocking header listener that no longer has a permission behind it
- `src/content.ts:22`, the injected script and handshake this decision replaces
- Installed skills `chrome-extensions` and `chrome-extension`, which govern the platform rules and the messaging shape

**Practices & standards**:
- Ports and adapters, for keeping the engine free of browser calls and testable in isolation
- Strangler pattern, for replacing a working implementation slice by slice rather than all at once
- Least privilege, for the manifest and for a store review
- Schema at the boundary, for treating untrusted payloads as untrusted at every runtime crossing

**Links** (verified on 2026-09-30):
- chrome.storage: https://developer.chrome.com/docs/extensions/reference/api/storage
- The extension service worker lifecycle: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- Content scripts: https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts
- chrome.scripting: https://developer.chrome.com/docs/extensions/reference/api/scripting
- chrome.webRequest: https://developer.chrome.com/docs/extensions/reference/api/webRequest
- Replace blocking web request listeners: https://developer.chrome.com/docs/extensions/develop/migrate/blocking-web-requests
- Manifest V2 support timeline: https://developer.chrome.com/docs/extensions/develop/migrate/mv2-deprecation-timeline
