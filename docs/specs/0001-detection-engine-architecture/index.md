# 0001. Detection engine architecture

**Date**: 2026-09-30
**Status**: Proposed

## Summary

This decides the spine of the extension: where the detection engine lives, how it keeps what it finds, how the three browser runtimes (the popup, the service worker, the content script) talk to each other, and how a site specific extractor plugs in. It exists because the current three files each know too much, because detected media disappears when Chrome stops the worker, and because the YouTube header rewrite no longer runs at all now that Chrome removed blocking request listeners. What it means for building: four child specs fix those four things, and the walking skeleton (scope feature 5) is the first code written against them.

## Structure

This is an umbrella decision. Each child is one decision, self sufficient to build from.

| Child spec | The decision it fixes |
|---|---|
| [0001-engine-boundaries.md](0001-engine-boundaries.md) | What each runtime owns, where the shared code sits, and the rule that engine code never calls a browser API |
| [0001-state-store.md](0001-state-store.md) | Where a tab's detected media lives, what one entry is, and how it survives the worker being stopped |
| [0001-message-contract.md](0001-message-contract.md) | The five messages the three runtimes send, checked with a schema at both ends |
| [0001-extractor-interface.md](0001-extractor-interface.md) | How a site specific extractor is matched to a page and what it hands back to the engine |

**Cross child contract.** These bind all four children. A child that breaks one of them is wrong, and changing one means revisiting this list.

1. **The engine is pure.** Code under `src/engine/` never calls a browser API at run time. It may import types from the browser type packages, and nothing else. Every effect goes through a port (a small interface the runtime supplies) or a message. Extractors are pure over a page access port, so "pure" and "can install a hook on the page" are both true at once.
2. **The worker is the only writer.** Nothing but the service worker writes detection state. Extractors and the content script hand entries over; the worker merges them.
3. **One entry's identity is the URL, the container and the quality together.** Two extractors that find the same file produce one entry naming both.
4. **The record is lean.** A field is added by the feature that reads it, never speculatively. Fields for thumbnail, duration and can this be saved as a file arrive with features 9, 10 and 7. One documented exception: the `reason` on a draft finding, which is never stored at all.
5. **The engine makes no network request of its own.** The only bytes it fetches are the media the user chose to save. No site gets a helper service.
6. **The content script matches its own page URL against the extractor registry.** There is no routing message. The worker never tells a content script what to run.
7. **One decision per child.** The state child does not define message shapes, the contract child does not choose a storage layout, the extractor child does not decide how a file name is built. If one of them needs a decision the others own, it stops and says so rather than deciding it quietly.

## Decision

**Chosen option**: one pure engine shared as source by all three runtimes, per tab state in session storage, one versioned and schema checked message map, and site extractors in a registry with a generic network observer as the fallback.

(basis: the service worker lifetime rules in Chrome's own documentation, the MV3 migration guidance on header modification, ports and adapters for the pure engine, and your test target of pure logic plus the message contract)

**Implementation skills**: `chrome-extensions` (`googlechrome/modern-web-guidance`, `.agents/skills/chrome-extensions/`) · `chrome-extension` (`samber/cc-skills`, `.agents/skills/chrome-extension/`)

## Proposed stack

The project's own stack is unchanged by this decision: React 19, Vite 8, TypeScript 6, Tailwind v4, shadcn, Motion and zod 4 all stay as they are. What follows is the engine's own layering.

| Layer | Choice | Reason |
|---|---|---|
| Runtime pattern | Three browser runtimes over one pure engine, written once as source and bundled into each entry | One implementation of the rules instead of three drifting copies, and it is the only shape that lets the rules be tested with no browser present |
| Where the code lives | `src/engine/` for the pure rules, the browser facing adapters stay in `src/background.ts` and `src/content.ts` | The purity rule is only enforceable if the boundary is a directory |
| Where state lives | `chrome.storage.session`, one key per tab, behind a port the worker fills | It is the documented way to keep state across a worker restart; an in memory map is lost every time Chrome idles the worker out after 30 seconds |
| How the runtimes talk | One typed map of five messages, parsed with zod at both ends, carrying a contract version | Five messages do not justify a request and response layer, and a payload that type checks but is wrong on the wire is exactly what the content script handshake produces today |
| How sites plug in | An extractor registry the content script matches against its own page URL, with the generic network observer as the fallback that always runs | Adding a site becomes a new file, never an engine change, and sites nobody has written an extractor for still work through the fallback |
| Reaching the page's own code | `chrome.scripting.executeScript` with `world: 'MAIN'` where the page's script policy allows it, DOM observation otherwise | The supported API needs no `web_accessible_resources`; a page that blocks it is a named outcome rather than a silent three second hang |
| Changing request headers | A static `declarativeNetRequest` ruleset, shipped as a rules file in `public/` so it lands in the built extension beside the manifest | Blocking request listeners are no longer available to an ordinary extension, so rules are the only supported way to set the Referer and Origin YouTube needs. A static ruleset needs no permission of its own; the dynamic permission is for session rules, which this does not use |
| Observing requests | `chrome.webRequest`, observing only | Observation is still fully supported; only the blocking form is gone |
| Runtime validation | zod 4, already a dependency | No new package, and it makes the contract tests real rather than decorative |
| Manifest permissions | `webRequest`, `scripting`, `downloads`, `storage`, `tabs`, `activeTab`, plus host access to all sites. Drop `declarativeNetRequestWithHostAccess`, and do not add `declarativeNetRequest` | Least privilege for a store review, and every remaining permission has a code path behind it |
| Deliberately not chosen | A test runner (that is scope feature 3's decision), the page debugger, any remote helper service, `storage.local` | Each is a real option that costs more than it returns here, and each belongs to a different decision |

## Consequences

**Positive**:
- Detected media survives the worker being stopped, which is the bug that makes the extension feel broken today.
- The YouTube header rewrite works again, through a supported mechanism.
- Every rule in the engine is testable with no browser, which is the test target this project chose.
- Adding a second site is a new file in the registry, not a change to the engine.
- The manifest asks for less and every permission has code behind it, which is what a store reviewer reads first.

**Negative / tradeoffs**:
- Signature protected YouTube formats will most likely stay unavailable. Reading them normally means asking a server for help, and the privacy line forbids that. The flagship case is narrower than users expect, and feature 8 has to either solve it locally or say so plainly.
- Pages with a strict script policy cannot be read at the page level at all. They fall back to what the DOM shows, which on many sites is nothing. Some sites will simply be unsupported, and the engine reports that as a named status rather than an empty list.
- Requesting every site means the user sees a read and change all your data on all websites warning at install, and a reviewer may push back. This was chosen deliberately over asking for sites one at a time, so it stays, and feature 17 is where it gets revisited with real store context.
- The engine ships as duplicated bytes inside each of the three bundles. That is a few kilobytes, and it buys testability and one implementation.
- Splitting one decision across four child specs means a reader who wants the whole picture reads five files. The cross child contract above exists so they can stop there.
- `chrome.storage.session` is cleared when the extension is reloaded, so during development every reload looks like a bug until the worker re injects and the page reports again.
- A pure engine means more ceremony: every effectful action goes through a port or a message, which is more indirection than calling an API directly.
- Reading the list is not a pure read: when there is no record, the worker injects a content script onto the page. That is how a tab that predates the extension ever gets looked at.

**Neutral**:
- Four foundations are decided before the first line of engine code, so the first end to end proof arrives after four deliberations rather than one.
- Content scripts cannot read session storage unless it is explicitly exposed. The worker being the only writer makes this a non issue.
- Cross origin sub resources need host access to both the request and the page that asked for it. `<all_urls>` already covers it.

## Follow-up

- [ ] `chrome-extension` skill conventions (the messaging layer and its shape) are not yet in `src/AGENTS.md`. They are area specific, so they belong there, not in root.
- [ ] The header rules are data, not code, so no unit test covers them. Verify them by running a real YouTube download during slice 1 and say so in the slice notes.
- [ ] Feature 8 (YouTube on the new engine) must solve signature protection with no remote help or state plainly that those formats are not offered. Do not let it quietly add a service.
- [ ] Feature 17 (store release readiness) must revisit host access with real store context. The cross check flagged the install time warning as the main store risk in this decision, and the answer belongs where the listing is written.
- [ ] Consider moving the project workflow from GA to Beta. GA runs verify, test, a fresh model review and document on every one of seventeen features, which is heavy for a project this size. Beta keeps verify and test, and feature 17 can carry a `· GA` tag on its own. Your call, and the scope header records whichever you pick.
- [ ] `docs/specs/0002` and later should not reopen the boundaries or the contract. If a feature seems to need a different message shape or a second writer, that is a change to this umbrella, not a local decision.

## Rationale

Reasoning, options weighed and the platform evidence: see [rationale.md](rationale.md).
