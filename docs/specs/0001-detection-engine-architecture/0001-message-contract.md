# 0001.3 Message contract

*Child of [0001 Detection engine architecture](index.md). No status line: the umbrella carries it.*

## Summary

This fixes how the popup, the worker and the content script talk. Five messages, each with a schema checked at both ends, and a version number so changing a payload is a deliberate act. It also removes the popup's 3 second polling loop: the worker tells the popup when something actually changed, and if there is no record when the popup opens, the worker puts a content script on the page rather than showing an empty list for a video that is playing.

## Decision

**Chosen option**: one typed map of five messages, parsed with zod on receipt in every runtime, carrying a contract version, with the content script announcing itself rather than being routed to.

(basis: schema validation at every runtime boundary, the failure already visible in the content script handshake, and zod already being a dependency)

**Implementation skills**: `chrome-extension` (`samber/cc-skills`, `.agents/skills/chrome-extension/`) · `chrome-extensions` (`googlechrome/modern-web-guidance`, `.agents/skills/chrome-extensions/`)

## Messages

Names are upper case. Every payload has a zod schema in `src/engine/messages.ts` and is parsed before any handler touches it. An unrecognised name, a payload that fails its schema, or a version that does not match is dropped and counted, never guessed at.

| Name | From | To | Payload | Response | When |
|---|---|---|---|---|---|
| `ENTRIES_REPORTED` | content script | worker | `{ contractVersion, pageUrl, pageTitle, status, entries: MediaEntryDraft[] }` | `{ ok: true }` | On load, and whenever the extractors collect something new |
| `GET_TAB_MEDIA` | popup | worker | `{ tabId }` | `{ record: TabMedia \| null, needsReport: boolean, status, inFlight: InFlightDownload[] }` | The popup opens, and after a broadcast |
| `TAB_MEDIA_UPDATED` | worker | popup (broadcast) | `{ tabId }` | none | Only when the merged record differs from what was stored, so the popup re reads rather than polls |
| `DOWNLOAD_MEDIA` | popup | worker | `{ url }` | `{ ok: boolean, downloadId?: number, error?: string }` | The user clicks download |
| `DOWNLOAD_PROGRESS` | worker | popup (broadcast) | `{ downloadId, bytesReceived, totalBytes: number \| null, state }` | none | On download state changes |

**There is no start message, and no request for a report.** The content script matches its own `location.href` against the extractor registry and starts its extractors on load, then reports. The worker never tells a content script what to run. This was the one piece of machinery the cross check found could be deleted: routing needed a message, a handshake and a version round trip after every extension reload, and all it bought was a pure function applied to a URL the content script already has. The two guarantees that matter are untouched, because the engine is still pure and the worker is still the only writer.

Two rules that are not obvious:

- **A handler that answers after a promise must `return true`.** An async `chrome.runtime.onMessage` listener that does not return `true` closes the response channel before the answer arrives, and the failure looks like a hang, not an error. This is the current bug in `src/background.ts`.
- **A broadcast has no reply.** `chrome.runtime.sendMessage` rejects when nobody is listening, which is normal when no popup is open. Swallow that rejection deliberately and say so in a comment, so nobody "fixes" it later.

## Where each value comes from

| Value | Source |
|---|---|
| `record` | Session storage, through the `StateStore` port |
| `status` | The stored record's status, except the two cases the worker decides itself: `observing` when there is no record and a content script has just been put on the page, `unsupported` when the tab cannot host one at all |
| `inFlight` | `chrome.downloads.search({})` at read time, so progress survives the worker being stopped |
| `filename` | Derived in the worker by `src/engine/filename.ts`, never sent by the popup and never stored. See the rule below |
| `downloadId` | The `chrome.downloads.download` callback |
| `bytesReceived`, `totalBytes`, `state` | `chrome.downloads.onChanged`, then `chrome.downloads.search`. Chrome reports an unknown total as `-1`, which the engine maps to `null` |
| `pageTitle` | `document.title`, read by the content script only, and rendered by the popup as text and never as markup |
| Entry `container`, `kind`, `quality` | The rules in `src/engine/media-rules.ts`, applied to what the extractor observed |

## The filename rule

Lives in `src/engine/filename.ts`, runs in the worker, and is the exact thing scope feature 13 (filename and folder control) replaces. It produces a file name, never a path.

1. Base: the record's `pageTitle` if there is one, otherwise the last segment of the URL path.
2. Append `_<quality>` when the entry's quality is not `unknown`.
3. Extension: the entry's `container` when known, otherwise the extension in the URL path, otherwise no extension at all. Never guess `mp4`.
4. Strip the characters a file system rejects: `/ \ : * ? " < > |` and control characters. Collapse runs of whitespace to one underscore. Trim to 180 characters.
5. Reject any path separator outright. Choosing the folder is feature 13's job, and until then a download must not be able to write outside the download directory.
6. If the result is empty, use `video`.

## The read path, end to end

1. The popup sends `GET_TAB_MEDIA` for the active tab.
2. The worker asks the browser for the tab's current URL, loads the record, and if the stored `pageUrl` no longer matches, deletes the record and carries on as if there were none. This is what stops the popup listing media from a page the user has left.
3. If there is no record and the tab can host a content script, the worker injects one and replies `{ record: null, needsReport: true, status: 'observing' }`. Injection is idempotent: the content script stamps `globalThis` with the contract version on start and returns immediately if a script of the same version is already running there. That one guard covers both a duplicate injection and a stale content script left over from before an extension reload, because the old build's stamp does not match the new build's.
4. If the tab cannot host a content script at all (a browser page, the store, another extension's page, a file the user has not granted), the worker replies `status: 'unsupported'` and `needsReport: false`, and the popup says so by name rather than showing an empty list.
5. Every reply carries what is in flight, so reopening the popup during a download shows the progress instead of forgetting it.
6. The content script reports on load and whenever it collects something new. The worker merges, saves, and broadcasts `TAB_MEDIA_UPDATED` **only if the merged record differs from what it stored**, so a burst of media responses on one page does not become a burst of re reads.
7. The popup re reads on the broadcast. It never polls on a timer.

## Invariants

- Every message is in the map. There is no ad hoc message string anywhere in the code, and there is no message that exists only to route.
- Every payload is parsed before use. Nothing reads `message.whatever` off an untyped value.
- `contractVersion` is a single constant in the engine, compared on receipt, and stamped onto `globalThis` by the content script. A mismatch means the page is running a content script from a different build; the worker re injects and the new build takes over.
- The popup never polls on a timer. It reacts to `TAB_MEDIA_UPDATED` and re reads on demand.
- Message names and shapes live in `src/engine/messages.ts` only. A runtime file that declares its own message type is wrong.
- Merges for one tab are serialised. A single writer is not enough: `await` yields, so two reports can interleave between the read and the write. The worker keeps a promise chain per tab id and runs merges through it. This is the invariant, and the comment claiming otherwise was wrong.
- A report whose `pageUrl` does not match the stored record's `pageUrl` replaces the record rather than merging into it, so a report in flight from a page the user has already left cannot land on the new page's list.
- `DOWNLOAD_MEDIA` takes a URL, not a file name. The worker looks the entry up in the record and derives the name, so the rule exists in one place and the popup cannot disagree with it.

## Consequences

**Positive**:
- The polling loop goes away, so the popup is not doing work while nobody is looking at it.
- A payload that type checks but is wrong on the wire is caught in a test, not in front of a user.
- The "worker was stopped" case heals itself, so a video found a minute ago is still listed.
- The file name is built in one place, which is the seam feature 13 needs and the thing that stops the popup and the worker disagreeing.
- Reopening the popup mid download shows real progress, which the current code loses.
- Five messages with schemas is a contract feature 3 can test directly, which is the second half of the chosen test target.

**Negative / tradeoffs**:
- Every message needs a schema, which is upfront work before anything is visible in the popup.
- The content script now decides which extractors run. That is simpler and it is the right trade today, but if a future feature needs routing to change centrally, without shipping a new content script, this is the decision to revisit. The content script is injected from the extension bundle, so any engine change reaches it on the next reload anyway, which is why central routing buys nothing right now.
- On a read with no record the worker injects a content script. That is a side effect in what looks like a read, and it is deliberate: it is the only way a tab that predates the extension gets looked at, and the idempotence guard makes it safe.
- The version check is ceremony that can only fire after an extension reload, mid session. It earns its place exactly there.
- Broadcasting to a popup that may not exist means handling a rejection that is not an error, which reads as a mistake to anyone who has not seen it explained.
- A read that finds a stale record deletes it, so the first read after a navigation does a little more work than later ones.

**Neutral**:
- `DOWNLOAD_MEDIA` and `DOWNLOAD_PROGRESS` keep today's names. The download path is the part of the current code that carries forward.
- Feature 11 (batch) will add messages here. Adding to the map is the intended way to grow it, not a reason to have built a request and response layer now.

## Follow-up

- [ ] Feature 3 owns the contract tests: every message gets a happy path, a bad payload, an unknown name, and a version mismatch.
- [ ] Feature 4 must specify the popup's three states from the read path: loading while `observing`, a named message for `unsupported`, and the list. It also owns how long the loading state waits before offering a hint.
- [ ] `src/engine/filename.ts` is a placeholder for feature 13. When that spec lands, the rule moves behind a template and a settings store, and this file goes away.
- [ ] Prove in slice 1 that `world: 'MAIN'` injection actually works on a real page, and record the result. Features 6 and 8 both depend on it and the platform documentation does not promise it works everywhere.
- [ ] Feature 11 (batch queue) adds queue messages to this map. Do not let it introduce a second, parallel channel.

## Rationale

Three shapes were weighed: a typed schema checked map, plain string types with hand written interfaces, and a full request and response layer with ids and promises. The checked map won because zod is already a dependency and because the specific failure this project has is a payload that is right in the editor and wrong on the wire, which is exactly what the current content script handshake is. Plain interfaces were rejected because nothing catches that failure until a user sees an empty list. The request and response layer was rejected on size: it is the right shape for twenty messages with typed errors, and this contract has five, most of them one way. Paying that machinery now would be optimising for a scale this extension will not reach.

The routing simplification came out of the cross check rather than out of the original design, and it is the better architecture. The original had the worker send the list of extractors to run, which needed a message, a handshake, and a version exchange every time the extension reloaded. But the content script already holds the page URL, and matching a URL against a static registry is a pure function, so the routing message was carrying information the sender already had. Removing it deleted a message, a handshake and a round trip, and left both load bearing guarantees in place. The cost is that "who routes" moved from the worker to the content script, which is a real change to an earlier decision and is why it was put to the engineer rather than applied quietly. The cost of being wrong is low: the registry is one module, and putting routing back is a small change to one file.
