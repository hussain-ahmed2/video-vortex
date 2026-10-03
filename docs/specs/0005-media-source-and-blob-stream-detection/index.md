# 0005. Media source and blob stream detection

**Date**: 2026-10-03
**Status**: In Progress

## Summary

Most video sites never hand the browser a video file. They fetch thousands of small chunks and let the page stitch them together in JavaScript (MediaSource, the browser's media pipeline), or they build one file in memory and point the player at a `blob:` address. Neither ever appears as a file on the network, so today those sites show nothing at all in the popup. This slice adds a hook that runs inside the page and watches both mechanisms. The two turn out to need very different amounts of work, and the difference is the point of the design. A `blob:` video is already a finished file sitting in the page's memory, so the hook only has to hold on to the object and click a link to it. A MediaSource stream has to be copied chunk by chunk as it arrives, because nothing can read a `SourceBuffer` back. In both cases the page starts the download and the extension never receives a single media byte, and a person is never shown a row that cannot be saved.

## Context

The walking skeleton (spec 0004) proves the spine on a page that plays a direct file. The sites that matter most do not do that. A player fetches segments, hands them to a `SourceBuffer`, and the browser decodes what the page assembled. From the network observer's side there is no video: the segments are usually served as `application/octet-stream` with no filename and often by byte range, so nothing passes the media filter and nothing is recorded. A `blob:` video is worse, because no request happens at all.

The bytes are also in the wrong place to be captured by an extension. A `SourceBuffer` cannot be read back: whatever the page appended is gone from our reach, so anything we want to save has to be copied as it arrives, which means copying it from inside the page. The page is the only place the media exists at all.

That is the whole design constraint. Spec 0001 already decided how to reach the page (`chrome.scripting.executeScript` with `world: 'MAIN'`, DOM observation as the fallback) and deferred proving it to a later slice. This is that slice. Two facts shape everything below. First, the extension must be able to save a file it cannot fetch, because a stream has no address to fetch. Second, what we collect can be large, and it is the page's memory, not ours, so the amount we hold has a limit and that limit needs to be visible to the person.

What we cannot do is equally fixed. Encrypted streams (Widevine, PlayReady) have scrambled bytes, so no amount of work produces a playable file, and we cannot always tell a site is encrypted until its own API says so. A live broadcast has no end, so it has no file. And a stream that began before our hook existed left no trace we can recover.

Not deciding this leaves the extension's most common real page showing an empty list while a video plays, which reads as broken rather than unsupported.

## Requirements

**User stories**:
- As someone watching a video on a streaming site, I want the stream listed so I can save it, because these sites show nothing today.
- As someone whose stream cannot be saved, I want to be told why rather than offered a download that fails.
- As someone on a page with several videos, I want one row per savable stream, not a wall of fragments.

**Acceptance criteria** (the contract, each independently checkable):

- **AC-1**: A page that assembles video through MediaSource, or points a media element at a `blob:` address the browser never fetched, is detected by a hook running in the page's own world, which reports it to the worker through the content script. The network observer alone cannot see either, which is why these sites show nothing today.
- **AC-2**: Every report from the page carries a token the content script minted for that injection. A report whose token is not the current one is dropped and counted, which is what stops a stale build of the hook, a duplicate hook, or another extension's injection from adding a row. This is not a defence against the page itself, and AC-2 does not claim to be: see the security model.
- **AC-3**: Two reports of one stream produce one entry. Identity stays the engine's existing tuple of tab, url, container and quality, where the url is our own scheme naming the page and the stream id the hook assigned, so no stream specific identity rule is introduced.
- **AC-4**: No media byte ever enters the extension. For a `blob:` origin nothing is copied at all, because the page already holds the whole object. For a MediaSource origin the page holds the copied chunks and the extension stores only metadata, so session storage stays small and no record holds a video.
- **AC-5**: A row appears as soon as the engine derives the stream playable, which it does from the `SourceBuffer`'s own buffered ranges rather than from the media element's playback progress. A paused or still buffering element never passes its metadata, so a video on a page nobody pressed play on would otherwise never be listed at all, and a stream that had already finished would still read as collecting. Nothing appears before the stream holds bytes.
- **AC-6**: The page reports when one of the signals it owns changes, and otherwise at most about once a second on a rounded size bucket, so a stream of thousands of chunks does not become thousands of storage writes and broadcasts, while a size that would render the same is not worth a write. The page never reports a derived state, because deciding what the signals mean is the engine's job and not the page's.
- **AC-7**: A stream whose media element reports an infinite duration is a live broadcast. The hook reports that as a plain `live` boolean rather than as the duration itself, because a non finite number cannot survive a schema that is meant to discard anything malformed. Its row says so and offers no download.
- **AC-8**: A stream that reports encryption is not recorded at all, because the bytes cannot be reassembled into anything playable and we cannot describe it honestly enough to be worth a row. The engine decides this from the signal rather than the page dropping the stream, so it is decided in exactly one place.
- **AC-9**: One page accumulates at most 512 MB of stream bytes across all of its MediaSource streams, and once that total would be crossed the hook stops copying for every stream on the page. A cap that let the other streams carry on growing would not bound the tab's memory, so it would not be a cap. The hook never interferes with playback: it declines to copy the chunk that would cross and lets the player's own append proceed, so the video keeps playing. Nothing already copied is ever evicted. A stream also stops being savable in full when the bytes held can no longer be reassembled into the whole file, which is `SourceBuffer.abort()` or an `append` the browser rejected, and separately when the browser refuses an append against its own per buffer quota. Whichever of these happens first is latched by the page and never cleared, so a stream cannot talk its way back into looking whole by being appended to again. The row names which one it was, because a file cut short by our cap, by the browser's quota and by a player that walked away are three different problems for the person looking at them.
- **AC-10**: Clicking download on a stream row asks the worker, which names the file by the existing six step rule. For a `blob:` origin the page clicks a link to the blob it already holds. For a MediaSource origin the page joins the chunks it already holds into one file and hands that over. The extension never calls `chrome.downloads` for a stream.
- **AC-11**: The row says it was sent to the browser's downloads and then returns to its control, because we produce the file but cannot observe whether it saved.
- **AC-12**: A second click while an assembly is running says one is already running, rather than assembling a second copy of the same bytes.
- **AC-13**: The six step rule falls back to the page title, then to the media element's own file name as the hook reports it, then to a fixed word, because a stream has no file name of its own.
- **AC-14**: One `MediaSource` is one stream and one row. Every `SourceBuffer` of it contributes to the same stream, so a player that appends separate audio and video buffers produces one row and one file with both tracks rather than a silent video and a row of its own. A player that re-adds a `SourceBuffer` for the same stream replaces that row rather than adding one.
- **AC-15**: When the hook installs it reports every stream it holds, and any stream row in the record it does not know is dropped, because the bytes behind that row died with the previous page.
- **AC-16**: A stream that began before the hook was installed cannot be captured, and the popup's observing hint says so rather than showing an empty list as if the page had no media. A hook that fails to install reads as `blocked`, which the popup already renders, rather than as an empty page.
- **AC-17**: Stream findings ride the existing `ENTRIES_REPORTED` message. Exactly one message is added, the assembly request, and it has two hops under one name: the popup sends it to the worker, and the worker derives the name and forwards it to the content script, which relays it into the page. The contract goes from five messages to six.
- **AC-18**: The hook is a third self contained build beside `content.js`, built by a third Vite config and a new npm script, and it is not declared in `web_accessible_resources` because `chrome.scripting` loads a packaged file from the extension's own origin and no page ever requests it. Its logic is covered by tests through fakes for MediaSource, SourceBuffer, blob addresses and message delivery in the existing harness, with no browser and no new test runner.
- **AC-19**: On at least three real sites that stream through MediaSource, the popup lists the stream and the download produces a file that plays.
- **AC-20**: A single page app that navigates without a document reload keeps its live streams listed. The hook's stamp records the page url it was installed for, and an injection for a different page url re announces the streams the hook still holds instead of returning early.
- **AC-21**: Every report is a full snapshot of the live streams, and the engine can drop a stream it no longer knows about, because the merge rules can fold and cap but cannot delete.

**Popup copy this slice owns**, fixed here the way spec 0004 fixed its own:

| State | Copy |
|---|---|
| Live broadcast | `This is a live stream, so there is no file to save` |
| Our page cap reached | `This page reached its 512 MB limit, so its streams are partial` |
| The browser's own quota reached | `The browser's own limit for this stream was reached, so this file is partial` |
| The player's buffer abandoned | `The player abandoned this stream partway through, so this file is partial` |
| Handed to the browser | `Sent to your downloads` |
| Assembly already running | `One download is already being assembled` |
| Stream that predates the hook | the popup's existing observing hint (`Media already on the page is only seen when it is requested, so reload the page if it played before you opened this.`), reused as is |

A stream that is still collecting and holds no bytes yet has no row, because there is nothing true to say about it. A stream that has stopped being savable in full does get a row even when it never played, because that is precisely the moment a person needs telling. The three assembly failure strings reuse the ones the worker already shows for the same three situations, so no new failure copy is owned here.

## Decision

**Chosen option**: Option 1, the page produces the file and starts the download itself, applied differently per origin.

A hook in the page's world watches two mechanisms. For a `blob:` origin it records the `Blob` object and does nothing else, and the download is a click on the existing blob url. For a MediaSource origin it copies each chunk as it arrives, holds them, and on request joins them into one file. In both cases the file is named by the engine's existing rule and the extension never sees a media byte.

**Implementation skills**: `chrome-extensions` (`googlechrome/modern-web-guidance`, `.agents/skills/chrome-extensions/`) · `chrome-extension` (`samber/cc-skills`, `.agents/skills/chrome-extension/`)

## Rationale

Reasoning, the options weighed, and the platform evidence: see [rationale.md](rationale.md).

## Feature design

**Data model sketch**:

| Entity | Where it lives | Key fields | Required |
|---|---|---|---|
| `TabMedia` | extension, session storage, one key per tab | `tabId`, `pageUrl`, `pageTitle`, `status`, `lastWriter`, `updatedAt`, `hiddenCount`, `seenKeys`, `entries` | unchanged from spec 0004 |
| `MediaEntry` | inside `TabMedia` | `url`, `container`, `quality`, `kind`, `sizeBytes`, `sources`, `discoveredAt`, `stream` | `stream` is new and absent for file entries |
| `StreamSignals` | inside `MediaEntry`, new | `streamId` (assigned by the hook), `origin` (`mse` or `blob`), `bytes` (what the hook has copied), `bufferedBytes` (what the player's own `SourceBuffer`s report buffered), `live` (boolean), `encrypted`, `ended`, `partialReason` (`none`, `page_cap`, `browser_quota` or `broken`), `mediaElementName` (string or null) | present only on a stream entry, and it carries raw observations rather than a verdict. Every field is a finite JSON value on purpose, because a record that fails its schema is discarded whole |
| `PageStream` | the page's world only, never in the extension | `streamId`, and either the copied chunks with their total for an MSE stream or the `Blob` object for a blob stream | exists only while the page holds it |

Relationships: `TabMedia` one to many `MediaEntry`. `MediaEntry` one to zero or one `StreamSignals`. `StreamSignals` one to one `PageStream`, matched on `streamId`, and that link exists only inside the page.

Unique constraint: the engine's identity tuple, which for a stream uses the synthetic url `vortex-stream:<encodeURIComponent(pageUrl)>#<streamId>`. Percent encoding the page url means the synthetic url can never end in a real file extension, so no rule that reads a path off a url can mistake it for a file. The existing fifty entry cap and derived hidden count apply to stream rows unchanged, so a page with sixty streams shows fifty and says how many it held back.

`TabMedia` gains nothing. In particular the page wide byte total is **not** a worker field, because a worker global does not survive the service worker being torn down and the cap would silently reset. The page owns that number, and it is the only thing that can act on it at the moment an append happens.

`partialReason` is the one signal that looks like a verdict and is not. It reports a page fact, in the same way `encrypted` reports a page fact: this stream has stopped being savable in full, and here is why. Deciding what that means for a row is `deriveStreamState`'s job and the hook's is only to have observed it. The reason travels rather than the sentence, because the sentence is the engine's to own and a page cannot be trusted to phrase one. It latches: the page sets it once per stream id and never clears it, because the bytes already copied cannot be un copied, so the only honest state for a stream that has lost bytes is the one it lost them in.

`live` is a boolean rather than the duration that produced it, and there is no duration field at all. An infinite duration is what makes a stream live, and nothing else in this slice displays or needs a duration, so carrying the number would mean carrying a value the engine cannot represent: `NaN` is rejected by the record's own schema, and a record that fails is thrown away rather than repaired. Mapping the case to a boolean at the page, where the observation is made, keeps the boundary total.

**State transitions**: the state is derived by a pure function in the engine, `deriveStreamState(signals)`, never by the hook. It returns one state and nothing else, so there is no second value for a caller to forget to read. The row asks the engine for the same answer the worker stored, so the machine is provable with no browser at all.

| From | To | Trigger | Row shown |
|---|---|---|---|
| none | `assembling` | `bufferedBytes` is zero, so the stream holds nothing yet | no |
| `assembling` | `playable` | `bufferedBytes` is above zero and the stream is whole | yes |
| `playable` | `playable` | another `SourceBuffer` of the same `MediaSource` appends, or a new one is added | yes, unchanged |
| any | `encrypted` | the signals say encrypted | no, never recorded |
| any | `live` | the page reports `live` | yes, no control |
| any | `partial_capped` | `partialReason` is `page_cap` | yes, says the cap |
| any | `partial_browser_quota` | `partialReason` is `browser_quota` | yes, says the browser's limit |
| any | `partial_broken` | `partialReason` is `broken` | yes, says the player walked away |
| `playable` | `ended` | the page reports `ended` | yes, gathering line gone |
| any | dropped | a snapshot does not list the stream | no |

The order is read in this order and the order is part of the contract. `encrypted` first, because a scrambled stream is never worth a row whatever else is true of it. Then the three partial states, because a stream that has lost bytes has something to say whether or not it ever played and whether or not it is live. A capped live broadcast is exactly the case that would otherwise hold 512 MB of a tab's memory and say nothing. Then `live`, because an endless stream has no file at any size. Then `assembling`, because a stream holding nothing yet has nothing to describe. Then `ended`, and then `playable`. Partial is read before `ended` because a stream that both lost bytes and ended is a broken file of full length, and "partial" is the more useful of the two things to tell someone.

**API surface**: there is no HTTP surface. The six messages in the engine are the whole interface, and the page to content script channel is a documented page level channel carrying the same shapes.

| Message | From and to | Key inputs | Key outputs | Key errors |
|---|---|---|---|---|
| `ENTRIES_REPORTED` | content script to worker, now also carrying stream entries as a full snapshot | `contractVersion`, `pageUrl`, `pageTitle`, `status`, `entries` | `{ ok: true }` | a report without the current page token is dropped before it is sent |
| `STREAM_ASSEMBLE` (new) | popup to worker, then worker to content script over `chrome.tabs.sendMessage`, then into the page | `contractVersion`, `url` (the synthetic one), `filename` (optional, so the one schema parses at both hops and zod does not strip the name when the worker forwards it) | `{ ok, error }` where error is `not_listed`, `already_running`, `no_bytes`, or `page_refused` | the row returns to its control with the failure copy the worker already uses for that same failure |
| `DOWNLOAD_MEDIA` | popup to worker | `contractVersion`, `url` | `{ ok, downloadId?, error? }` | a stream entry never reaches this path; it is answered by `STREAM_ASSEMBLE` instead |
| `GET_TAB_MEDIA` | popup to worker | `contractVersion`, `tabId` | `record`, `needsReport`, `status`, `inFlight` | unchanged |
| `TAB_MEDIA_UPDATED` | worker to popup, broadcast | `tabId` | none | unchanged |
| `DOWNLOAD_PROGRESS` | worker to popup, broadcast | `downloadId`, `url`, `bytesReceived`, `totalBytes`, `state` | none | not used for streams, which have no download to observe |

`chrome.tabs.sendMessage` is new to this codebase: `src/AGENTS.md` records that the worker reaches the content script only by injecting it. That reversal is deliberate, because the worker is the only one that knows the file name, and one message with two hops is cheaper than a seventh message.

**Value sourcing**:

| Action | Value produced or displayed | Source |
|---|---|---|
| Detect a stream | that a stream exists, and its `streamId` | the hook's report, carried by `ENTRIES_REPORTED` |
| Detect a stream | `streamId` scope | one id per `MediaSource`, held in a `WeakMap` inside the hook; every `SourceBuffer` of that object reuses it, and a re-added buffer reuses it again. Blob ids come from the same counter |
| Detect a stream | `origin` (`mse` or `blob`) | decided by the argument's type at the moment the hook sees the object: a `MediaSource` is `mse` and goes down the `SourceBuffer` capture path, anything else is `blob`. Deciding it by which hook path saw the call would send a `MediaSource` handed to `URL.createObjectURL` down the blob path, where the type filter rejects it and the stream vanishes |
| Admit a blob as media | that it is a video or audio | the `Blob`'s own `type`, admitted only when it starts `video/` or `audio/`, reusing the existing media response test |
| Bind a blob to a player | `mediaElementName` | matched by comparing each `video` and `audio` element's `currentSrc` against the recorded blob urls on every report tick |
| Detect a stream | `container` | the `SourceBuffer`'s MIME type, or the blob's type, through the existing content type map in `src/engine/media-rules.ts` |
| Detect a stream | `kind` | derived from the container by the existing `kindFor` |
| Detect a stream | `sizeBytes` | the running byte total the hook reports. For a blob origin it is the `Blob`'s `size` |
| Detect a stream | `quality` | always `unknown`, the same fallback rule spec 0004 set, because no page supplied a label |
| Decide a row is worth showing | `playable` | the engine's `deriveStreamState`, from `bufferedBytes` being above zero. That number is the sum of the `buffered` ranges of every `SourceBuffer` on the stream's `MediaSource`, which the browser maintains and the page can only read |
| Decide a row is worth showing | `live` | `live` on the signals, which the hook sets when the media element's `duration` is `Infinity`. Always false on the blob path, where the object is complete the moment it exists |
| Decide a row is worth showing | `ended` | the `MediaSource`'s own end of stream, so always false on the blob path for the same reason. A complete blob has no gathering phase to end |
| Decide a row is worth showing | `encrypted` | the `SourceBuffer`'s `encrypted` event. This signal exists only on the MSE path; a blob gives no such signal, which is stated in Consequences |
| Decide a row is worth showing | which kind of partial | `partialReason`, which the hook latches on the first of: an append that would cross the page's 512 MB total, an append the browser rejected against its own per buffer quota, or a `SourceBuffer.abort()`. Once set it is never cleared for that stream id |
| Enforce the cap | the page total across streams | the page's own running total. The extension holds no byte total and adds no field for one |
| Name the file | the base name | the page title, else `mediaElementName` (the last dotless path segment of the element's `currentSrc` when its scheme is http or https), else a fixed word. A stream never reads the synthetic url's path, which is why step 1 of the existing rule gains a stream branch |
| Name the file | the extension | the entry's container, from the existing map |
| Render a stream row | its label | `streamId` and `origin` from the engine, never `labelFor`, because a blob's `currentSrc` is `blob:.../<uuid>` and would make every row on a page identical |
| Render a stream row | its quality line | omitted entirely, since the row would otherwise print `unknown` literally |
| Offer a control | whether the row is savable | `isDownloadable` takes the entry rather than the container, and for a stream entry is true only when `deriveStreamState` returns `playable` or `ended`. A live row and each of the three partial rows therefore carry no control, which is what keeps a live stream from being offered a download that would never finish |
| Row copy for each state | the strings in the copy table, plus the worker's existing three failure strings | fixed in the copy table above and in `src/background.ts` |
| Track an assembly in progress | whether this stream is already being assembled | held per stream in the page, so it survives a worker restart and answers a reopened popup honestly |

**Key invariants**:
- No media byte ever enters the extension. The page holds the bytes; the extension holds a count and a few small signals.
- The engine stays pure and owns every decision. The hook observes and holds, and never classifies a stream: it reports `bytes`, `bufferedBytes`, `live`, `encrypted`, `ended` and `partialReason`, and `deriveStreamState` in `src/engine/` decides what those mean, including deciding that an encrypted stream is not recorded. The hook cannot call the engine, because it is a self contained bundle in the page's world, so it must not try.
- The page owns the cap and latches `partialReason`; the engine owns the sentence. Only the page can see an append being refused at the moment it happens, and only the engine can decide what a person should be told about it. Latching is what makes the pair honest, because the bytes already copied cannot be uncopied.
- The hook never changes what the player receives. It declines to copy and lets the append proceed, because a download tool that stalls the video to save memory has taken something from the person watching it.
- A row exists only when there is something true to show. Never for an encrypted stream, never for a stream holding no bytes yet, never a download control on a live row or on a partial one.
- The hook is stamped with the page url it was installed for, and the same stamp handles both duplicate injection and single page app navigation.
- The token is minted per injection, lives only in the page and the content script, and is never stored.
- The worker stays the only writer of detection state, per spec 0001's cross child contract.
- A stream whose container we cannot name gets no download control, by the existing rule that a row with no savable container carries none.

**Security model**: one actor, the person using the extension, and one privileged action, saving a file they chose. There is no authentication, no personal data, and nothing leaves the browser, which is unchanged from spec 0004.

The trust boundary is the page, and it has to be described honestly rather than generously. A hook in the page's own world shares `window` with the page, so every channel between them is readable by the page: it can read the token and post a report of its own. The token therefore does not stop the page. What it stops is a stale build of the hook, a duplicate hook, and another extension's injection, and AC-2 is written to claim only that. Forging a row costs a hostile page nothing it does not already have, since it can already play its own media into the tab; the exposure is a row that offers to save something, not access to anything.

Two further boundaries are handled rather than solved. The hook is our own code injected into the page, and we execute nothing the page supplies. The file name comes from the engine's six step rule, which strips path separators, so a page title cannot write outside the download directory. And the download is started by the page from bytes the page already held, so a hostile page can only save its own media to its own download.

We trust the byte count the page reports, because there is no way to check it; a page that lies can move the displayed size and bring the cap forward, and nothing else. One exposure from the original draft of this spec is withdrawn: the hook is **not** declared in `web_accessible_resources`, because `chrome.scripting` loads a packaged file from the extension's own origin and no web page ever requests it, so there is nothing for a site to read and nothing for a store reviewer to object to. Spec 0001 says this and was right.

**Configuration required**: none. No environment variables and no credentials. The manifest gains no new field; the hook is reached the same way `content.js` already is.

**Critical test scenarios**:
- Happy path: a MediaSource site plays, the row appears once the engine derives the stream playable from buffered ranges, clicking download assembles the chunks and the browser saves a file that plays, verifies **AC-1**, **AC-5**, **AC-10**, **AC-19**
- Happy path: a `blob:` video is listed and saves without a single byte being copied, verifies **AC-1**, **AC-4**, **AC-10**
- Staleness: a report arrives with a stale token and with no token, and both are dropped and counted, verifies **AC-2**
- Playable: a stream with buffered bytes on a media element that is still paused and has never been played is listed anyway, which is the case a playback progress signal would have missed, verifies **AC-5**
- Failure: the signals say encrypted, so the engine derives a state that is never recorded, and the page never decided that itself, verifies **AC-8**
- Failure: a page would cross 512 MB, so the hook stops copying for every stream on the page, the already copied bytes stay, the player's own appends keep working, and each affected row says the cap sentence, verifies **AC-9**
- Failure: `SourceBuffer.abort()` latches `broken`, the row says the player walked away rather than the cap sentence, and a later re-append to the same `MediaSource` does not clear it, verifies **AC-9**, **AC-14**, **AC-21**
- Failure: an append the browser rejects against its own per buffer quota says the browser's sentence, which is neither of the other two, verifies **AC-9**
- Live: a media element with an infinite duration gets a row that says there is no file and offers no control, and a capped live broadcast says it is capped rather than only that it is live, verifies **AC-7**, **AC-9**
- Failure: the page reloads, so stream rows the fresh hook does not know are dropped while the page's file rows survive, verifies **AC-15**, **AC-21**
- Navigation: a single page app changes its url and the streams still listed survive, verifies **AC-20**
- Identity: separate audio and video `SourceBuffer`s on one `MediaSource` produce one row, verifies **AC-14**, **AC-3**

## Build plan

Ordered as the project default shapes it, but starting with the assumption everything else rests on: whether the page can start a download at all. Then a thin end to end thread through the easy origin, then the stream machinery, then the states and the limits, then proof on real sites.

1. **The assumption this slice rests on, proven first**: on a real page with a real user gesture, prove that a hook in the page's world can take bytes it holds and start a download, and that the file lands and plays. Every later task depends on this, so it is proven before anything is built on it rather than at the end. Record what the proof showed, satisfies **AC-10**, **AC-19**
2. [x] The data model in the engine: `StreamSignals` on the draft and the entry schemas, the percent encoded synthetic url builder, identity unchanged, the pure `deriveStreamState` returning one state and no second value, and a pure `dropUnknownStreams` that also clears the hidden count's keys, with tests, satisfies **AC-3**, **AC-5**, **AC-7**, **AC-9**, **AC-15**, **AC-21**. This bumps the contract version, because two payload shapes change
3. [x] The assembly request added to the message contract: six messages, the one schema carrying an optional name so both hops parse, the popup to worker direction and the worker to content script direction, and a message delivery fake in the harness, since today's fake resolves without reaching a listener, satisfies **AC-2**, **AC-17**
4. The page hook as a third self contained build beside `content.js`, through a third Vite config and a new npm script with its flat output name fixed, plus harness fakes for MediaSource, SourceBuffer and blob addresses, satisfies **AC-1**, **AC-4**, **AC-18**
5. The content script relay: install the hook, mint the token for that injection, stamp the hook with the page url, forward stream reports, and drop and count a report without the token. It does not drop an encrypted stream, because that is the engine's decision and this runtime has no engine call to make it with, satisfies **AC-2**
6. The worker half: inject the content script and then the hook, accept stream entries from a report as a full snapshot, keep the badge and the broadcast as they are today, and discard any entry the engine derives as encrypted, satisfies **AC-1**, **AC-8**, **AC-15**, **AC-16**
7. The popup lists a savable stream row: `isDownloadable` takes the entry and consults the derived state, the label comes from `streamId` and `origin`, and the quality line is omitted, satisfies **AC-3**, **AC-5**, **AC-7**
8. The `blob:` path end to end: hold the `Blob` object, admit only video and audio types, bind it to a player by `currentSrc`, and save it by clicking a link to the url the page already made, with the engine's name applied. This path copies nothing and has no cap, satisfies **AC-1**, **AC-10**, **AC-11**, **AC-12**, **AC-13**
9. MediaSource accumulation: one id per `MediaSource` through a `WeakMap`, chunks held per stream, `bufferedBytes` creating the row, running size updates on a rounded bucket so cadence does not become a write per chunk, and a re-added `SourceBuffer` reusing the id, satisfies **AC-5**, **AC-6**, **AC-14**
10. The states and their copy: live with no control, the three partial states each with its own sentence and each latched on the page, sent, one assembly at a time per stream, and `blocked` when the hook fails to install, satisfies **AC-7**, **AC-8**, **AC-9**, **AC-11**, **AC-12**, **AC-16**, **AC-21**
11. Single page app navigation: the stamp's page url drives a re announce, and the reload drop of rows a fresh hook does not know, satisfies **AC-15**, **AC-20**, **AC-21**
12. Wire it up on three real MediaSource sites, record what each site's player does, satisfies **AC-19**

Every acceptance criterion traces to at least one task and every task to at least one criterion. There is no migration: session storage has no schema to migrate, and the record's shape changes with task 2, which the same slice reads back through the engine's own schema check. Note that task 2 makes the hook's verdict the engine's, which is why the raw signals cross the boundary rather than the hook's conclusion.

## Consequences

**Positive**:
- The sites people actually use stop showing an empty list while a video plays.
- The empty state becomes honest, because the extension can now say the page was streaming rather than having nothing.
- One list shape for files and streams, so the later merge and batch features have one thing to handle.
- The `blob:` origin costs almost nothing: no chunks, no cap, no assembly, and it survives the page revoking the url.
- A truncated file says why it was truncated, so a person hitting our cap, a person hitting the browser's own quota and a person on a player that gave up are told three different things rather than all being told "partial".
- A video is listed whether or not anyone pressed play on it, because the row is derived from the player's own buffered bytes rather than from how far playback has got.
- The extension's memory footprint does not move at all. The bytes were always the page's.
- No manifest change, so no store review question is raised by this slice.

**Negative / tradeoffs**:
- Up to 512 MB per page of MediaSource bytes now sits in the page's memory, and peak is about twice that because assembly builds a second copy before the file is handed over. The cap bounds it and the row says when it is hit, but a person watching a long stream in a heavy tab will feel it. Once the page total is reached every stream on that page stops copying, not just the one that crossed it, which is what makes the cap a cap.
- `SourceBuffer.remove()` is left out of the causes on purpose, and that is a known gap rather than a clean call. A `remove()` does tear a hole in the bytes we copied, but players call it routinely for DVR trimming and seek back cleanup, often re-appending immediately. Latching on it would mark healthy streams partial for the rest of the tab's life, and not latching means a genuine hole can be assembled into a file that will not play from the start. The correct answer is to track the actual byte ranges and let a re-append heal the gap; see the Follow-up.
- `live` rests entirely on an infinite duration. A player that reports a growing seekable window instead never reads as live, so it derives `playable` and offers a download for an endless stream. There is no second signal to fall back on.
- We can no longer see whether a stream download succeeded, so the row says it was sent rather than saved. A file row says Saved and a stream row does not, and that difference has to be explained in the UI.
- We can also not observe the browser's own multiple downloads prompt, which a page with three streams will now trigger on the second click. One prompt we caused and cannot see.
- The hook is the part most likely to break. Every site's player is different, so this is where the bugs will be, and a site that fights the hook produces nothing rather than an error.
- We trust the page's byte count. A page that lies can distort the size shown and bring the cap forward, and we cannot detect it.
- Proving this on three real sites is real work with real unknowns, and the sites are not named yet.
- A `blob:` video behind DRM is opaque, and unlike a MediaSource stream it gives no encryption signal, so its row is offered and its file will not play. We cannot do better without knowing the site's own protection scheme.
- One more build config, one more npm script and one more flat output name to keep true, on top of a contract that grew by one message.
- Encrypted MediaSource streams stay invisible, and after this slice that will look like a gap rather than an absence, because the surrounding sites now work.

**Neutral**:
- Stream rows count toward the same fifty entry cap and the same hidden count line as files.
- The content script's stamp and the hook's stamp are separate, so a reload replaces one without the other.
- A stream's quality is `unknown` for the same reason a file's is, so the row tells the person nothing about resolution.
- `chrome.tabs.sendMessage` is now a channel this extension uses, which the context docs currently say it does not.

## Follow-up

- [ ] Spec 0001's message contract child says five messages. This adds a sixth, `STREAM_ASSEMBLE`, and the child needs amending before implementation starts.
- [ ] Spec 0001's `Reaching the page's own code` row says injecting a `world: 'MAIN'` file needs no `web_accessible_resources`. That is correct and was re checked against Chrome's documentation for this slice, so it stands; nothing is wrong with it.
- [ ] Spec 0001's extractor interface child says feature 6 adds an extractor that plugs into the page access registry through `onPageEvent`. This spec says the opposite, that the hook is generic and needs no registry, and `src/engine/page-access.ts`, `match.ts` and `extractors/` do not exist yet, so nothing is carrying the port that child describes. The two specs have to be reconciled before either is built, and one of them is wrong.
- [ ] Spec 0001's cross child contract says an entry's identity is its url, container and quality. That still holds here because the synthetic url is unique per page and stream, and the contract child should say so, so feature 8 does not introduce a second identity rule for streams.
- [ ] Feature 7's record level field for whether a file can be saved should apply to file entries only. A stream answers that through its derived state, and adding a second field for it would be a duplicate.
- [ ] `isDownloadable` currently takes a container and gates both the row's control and the worker's download path. It has to take the entry after this slice, which is a signature change other callers will feel.
- [ ] `src/AGENTS.md` says nothing uses `chrome.tabs.sendMessage` and the worker never messages the content script. Task 3 reverses both, so that line has to change.
- [ ] The three new fakes plus a message delivery fake belong in `src/testing/AGENTS.md` once they exist, so the harness doc stays true.
- [ ] The third build output is named by the manifest the same way `background.js` and `content.js` are, so renaming it breaks the extension silently. The same trap the root rules warn about now has a third instance.
- [ ] `SourceBuffer.remove()` leaves a hole in the copied bytes that this slice does not detect, and the honest fix is to track the stream's actual byte ranges rather than to latch on the call, so that a player which removes and immediately re-appends heals instead of being marked partial forever. That is real work in the hook and belongs either in this slice before task 12 proves it on real sites, or in a follow up feature; it should not be discovered on a DVR site during AC-19.
- [ ] The three real sites in AC-19 are not named. They should be chosen and written into this spec before task 12, because the hook's per site behaviour is the largest unknown in the slice and choosing late means finding the hard site at the end. One of them should be a DVR style player if the `remove()` follow up is taken, since that is where the gap above shows up.
- [ ] If the hook turns out to be hard to fake faithfully in jsdom, the fallback is a real browser test rather than a weaker fake. That is a scope change, not an implementation detail.