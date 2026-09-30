# 0001.4 Extractor interface

*Child of [0001 Detection engine architecture](index.md). No status line: the umbrella carries it.*

## Summary

This fixes how a site specific extractor plugs in, so adding a site is a new file rather than a change to the engine. An extractor says which pages it handles, installs whatever it needs through a narrow port, and hands back the media it found along with a reason for each. It never writes anything: the worker merges what comes back. The generic network observer is the fallback that always runs, so sites nobody has written an extractor for still work.

## Decision

**Chosen option**: a registry of extractors matched on the page URL by the content script itself, each returning entries and reasons through a page access port, with the engine as the only writer and the generic request observer as the fallback.

(basis: least privilege for a store release, one tested implementation of the merge rules, and the fact that a site player response is not expressible as a pattern or a config)

**Implementation skills**: `chrome-extensions` (`googlechrome/modern-web-guidance`, `.agents/skills/chrome-extensions/`)

## The extractor shape

| Concern | Decision | Reason |
|---|---|---|
| How a site is claimed | Each extractor declares URL patterns. The content script matches its own `location.href` against the registry on load, through `src/engine/match.ts`, and starts what matches | The content script already has the URL, and matching a URL against a static registry is a pure function. Doing it in the worker needed a message, a handshake and a version round trip to carry information the sender already had |
| Pattern syntax | Glob only. `*` matches any run of characters, `?` matches one, everything else is literal. No regular expressions, no host lists, no exclusions | A pattern language with no compiler and no tests is where site support goes to rot. If a site needs something richer, the matcher grows a named hook, not a syntax |
| What an extractor receives | A `PageAccess` port and `{ pageUrl, pageTitle }`. Nothing else | A small surface means an extractor cannot depend on engine internals and rot when they change |
| What it returns | A list of `MediaEntryDraft` values, each with a `reason`, plus the `status` it is in | The reason costs one string and buys testable assertions and a real diagnostics view later |
| Who writes | The worker merges. An extractor never touches storage or sends a message | One merge rule, one place tested. An extractor that writes its own findings reimplements dedup and the cap |
| The fallback | The generic request observer is itself an extractor, whose patterns match everything, and it always runs alongside any site extractor | Sites with no extractor still work, and the two can agree on one file instead of listing it twice |
| First contents of the registry | The generic observer only | YouTube arrives with scope feature 8, on this interface. An empty registry with one fallback is a working slice 1 |

## The page access port

Extractors are pure code under `src/engine/`, so they cannot touch the page themselves. The content script implements this port and hands it to every extractor it starts. This is the seam scope feature 6 needs, and it is why engine purity survives having hooks in the picture.

| Operation | What the extractor gets | Who implements it |
|---|---|---|
| `title` | The page title | content script |
| `queryDom(selector)` | Matching elements, for a DOM only extractor | content script |
| `readPageGlobal<T>(expression)` | The result of evaluating a function in the page's own JavaScript world, or null when the page's script policy refused | content script, via `chrome.scripting.executeScript` with `world: 'MAIN'` |
| `onPageEvent(name, handler)` | A named event from the page (a response arriving, a media buffer appended, a player becoming ready). Returns an unsubscribe function | content script |
| `now()` | The current time in epoch milliseconds, so an extractor stays pure and testable | content script |

An extractor may hold state it needs for its own job, such as a hook it installed. It may not hold state the engine needs, and it may not assume it is the only extractor running.

## Contract of an extractor

| Field | Meaning |
|---|---|
| `id` | Stable string, for example `'youtube'` or `'generic-network'`. Appears in `MediaEntry.sources` and in `TabMedia.lastWriter` |
| `matches` | Glob patterns for the pages it handles. The generic observer's is `*` |
| `start(context)` | Installs whatever it needs through the port. Called once per page, after matching. Returns nothing |
| `collect()` | Returns `{ status, entries }`. Called whenever the content script reports, and after any event the extractor subscribed to. `status` is `ready`, or `blocked` when the page refused page level access |

Splitting `start` from `collect` is what makes hook based extraction expressible. The first draft of this child described a single `detect` call that was simultaneously one shot and hook installing, which would have forced feature 6 to reach around the interface.

`blocked` is a real, expected outcome, not an error. A page with a strict script policy refuses page world injection, and the honest thing is to say so and let the fallback carry the tab.

## The fallback extractor

| Concern | Decision |
|---|---|
| Which request events | `onBeforeRequest` for the URL, `onHeadersReceived` with `['responseHeaders']` for the content type and the size. That second one is why `sizeBytes` and `container` are usually known at all |
| What counts as media | A response whose content type starts with `video/` or `audio/`, or whose URL path ends in a known media container. Everything else is ignored, which is what keeps fonts, images and ads out of the list |
| What it never reports | `blob:` URLs as downloadable. The browser will not hand a blob to the download manager, so the engine derives a not downloadable verdict and the popup says so instead of offering a button that fails |
| Its `reason` | The fixed string `network response`. Site extractors use `<site>:<mechanism>`, for example `youtube:player response` |
| Its `quality` | Always `unknown`. It has no way to know, and guessing is worse than saying so |

## What is downloadable, derived not stored

Whether an entry can actually be saved is a pure function of the entry, not a field, so it costs nothing to store and cannot go stale:

`isDownloadable(entry)` is true when the URL scheme is `http` or `https` **and** the container is not a manifest (`m3u8`, `mpd`) **and** the entry did not come from a `blob:` source. Anything else renders as a labelled row with no download button. Scope feature 7 replaces the manifest part of this rule with something honest, and feature 10 changes the picture again for streams that can be merged.

## Invariants

- Every entry an extractor returns goes through the engine's identity and merge rules. An extractor cannot create a duplicate entry by returning something already there.
- A `reason` is required on every draft. An entry with no explanation is a bug, because nothing can then say why it was listed.
- Extractors are matched, not discovered at run time. Remote code is forbidden in MV3, so a fetched extractor list is not an option, and a list that must be edited per site is the config approach this decision rejected.
- An extractor that throws is contained. One broken site extractor must not stop the generic observer, the other extractors, or the tab's record. A failed extractor reports `blocked` and says so in its reason.
- An extractor makes no network request. The privacy line in the umbrella applies to the whole engine, extractors included.
- `id` values are permanent once written, because they end up in stored records and in test names.

## Consequences

**Positive**:
- Adding a site is a new file and a pattern. The engine does not change, which is what makes scope feature 14 possible without another decision.
- The fallback means every site works at the generic level from slice 1, so no site is a hard failure just because nobody wrote an extractor for it.
- The port means an extractor stays testable with no page at all: a test supplies a fake `PageAccess` and asserts on what comes back.
- Requiring a reason makes the diagnostics view (feature 16) buildable later from data that already exists, and makes extractor behaviour assertable in a test.
- Containment means a site that changes its internals tomorrow breaks one extractor instead of the tab.
- Deriving downloadability instead of storing it means feature 7 can change the rule without a migration and without touching any stored record.

**Negative / tradeoffs**:
- Every extractor that matches a page runs on it, so a page matching three patterns pays for three extractors. Acceptable while the registry holds one or two; revisit if it grows.
- The `reason` field is per entry and unused by anything in slice 1. That is deliberate debt, bought to avoid retrofitting explanations later, and it is the one documented exception to the umbrella's lean record rule.
- URL pattern matching is a blunt instrument. A site that serves several domains, or a player on a completely different host, needs either more patterns or a matcher that looks at more than the URL. YouTube is the known case: its player is served from a host that is not the video host. Feature 8 will hit this, and the honest fix is a named matcher hook, not a growing pattern list.
- The content script now owns matching, so a future feature that wants routing to change centrally has to change that file. Accepted, and cheap to reverse while the registry is small.
- The generic observer cannot see a stream the browser assembles in memory, which is most real sites. That is scope feature 6's decision, not this one's, and this interface is what it will plug into.

**Neutral**:
- An extractor that only reads the DOM is still a valid extractor. It is less capable, not invalid.
- `collect()` returning nothing is normal and not an error. Most calls find nothing new.

## Follow-up

- [ ] Feature 6 (media source and blob detection) adds an extractor that subscribes to the page's media events through `onPageEvent`. It plugs into this registry and does not change the interface. If it needs to, come back here first.
- [ ] Feature 8 (YouTube) will hit the cross host matcher problem named above. Decide the matcher hook there, and change this child spec if it does.
- [ ] Feature 14 (second site extractor) is the real test of this interface. If adding a second site needs an engine change, that is a signal this interface was wrong, and it should be fixed here rather than worked around there.
- [ ] The content type allowlist in the fallback will need extending as slice 1 meets real sites. Keep it a named list in one place, not a condition chain.

## Rationale

Three shapes were weighed: a registry of site extractors, one generic extractor driven by per site configuration, and a declared content script per site in the manifest. The registry won because it is the only one of the three where YouTube is expressible at all: a player response is not pattern matchable, so the configuration approach would have grown into a small scripting language with no compiler and no tests. The per site manifest script was the strongest alternative and was rejected on cost rather than principle: it gives a genuinely better permission story and a smaller injected footprint, but it costs a file and a manifest edit per site, and the generic fallback still needs an all pages script, so the extension ends up with both mechanisms. If the permission story becomes a store review problem in feature 17, that is the moment to revisit it.

The engine as sole writer was chosen over letting extractors write their own findings because dedup, the cap and the merge rules are exactly the logic that needs one tested implementation, and the alternative is three copies of it by slice 3. The page access port came out of the cross check: the first draft of this child listed extractors under the pure engine while also saying they install hooks and read pages, which cannot both be true. The port resolves it without weakening purity, and it has the side effect of giving feature 6 a place to plug into.
