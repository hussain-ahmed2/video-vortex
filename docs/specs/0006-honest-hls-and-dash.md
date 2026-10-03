# 0006. Honest handling of playlists and manifests

**Date**: 2026-10-03
**Status**: In Progress

## Summary

An HLS playlist (a text file listing the pieces of a video) should either become a real file or say plainly why it cannot. The page reads the playlist, fetches the pieces, and joins them into one playable MP4 in its own memory, so the extension still never receives a single media byte. Every case we deliberately do not handle gets its own sentence, and the list stops offering a text file as though it were a video.

## Context

> ⚠️ Premise note: this feature's value rests on an unmeasured fact, and the probe that measures it is build task 1 rather than a paragraph here. Spec 0005 made the page hook watch MediaSource, which is the path every JavaScript player uses. Chrome now also plays HLS itself, natively, with no JavaScript at all, and that path runs inside the browser rather than in page code. Whether our hook can see it is unknown. If it can, nearly every site this feature exists for is already handled by spec 0005 and this feature reduces to labelling playlist rows. If it cannot, this feature is the only thing that saves those sites, and it becomes the most valuable slice in the plan. The plan below therefore builds the labelling half unconditionally, because it is needed either way, and gates the assembling half on the probe.
>
> ⚠️ Premise note, second: the feature is named for HLS and DASH together, and only the HLS half is assembled. MPEG-DASH joins the same way fragmented MP4 does, so there is nothing about the format that stops us; what stops us is that it plays through the MediaSource path spec 0005 already covers, so building a second assembler for it would be a second path to the same outcome. DASH gets the honest labelling and nothing more. Naming both in the title is still right, because a DASH manifest must stop being offered as a video.

The worker watches network responses and keeps any that name themselves as media. A playlist names itself as `application/vnd.apple.mpegurl` and maps to the container `m3u8`, so it is already recorded, and `isDownloadable` already refuses it, so it already carries no download control. What is missing is any explanation. The row says `master.m3u8`, offers nothing, and reads as a bug.

That gap has been getting wider rather than narrower. Chrome shipped native HLS on desktop in version 142, in October 2025, reaching stable that December. Before it, a site choosing native playback over a JavaScript player was choosing a path almost nothing could follow. Now it is the simplest thing a developer can do, so more sites will take it, and the number of playlist rows that cannot be saved will grow.

Two facts about the platform shape everything else. First, the bytes are in the wrong place to be captured by an extension: a playlist is a list of addresses, and the media behind them is fetched by whoever plays it, so producing a file means fetching them ourselves. Second, a media element is exempt from the cross origin rules that a `fetch` obeys, so a page may be playing segments our own requests could not read. That asymmetry decides where the work happens and it caps what can work at all.

Nothing here is a server call and nothing leaves the browser. The work is done by the page, on the page's own origin, with the page's own permissions, which is the same position spec 0005 established for stream assembly and the reason this slice reuses that machinery rather than inventing a second path.

## Requirements

**User stories**:
- As someone watching a video on a site that streams it as a playlist, I want the row to either save a real file or tell me why not, so I never end up with a text file that will not play.
- As someone on a page that offers four qualities of the same stream, I want one row for the video rather than four rows I cannot use.

**Acceptance criteria** (the contract, each criterion is independently checkable):

- **AC-1**: A playlist that ends, is not encrypted, lists whole segments, and whose segments are fragmented MP4, is listed as one row and produces one playable MP4 when its control is used.
- **AC-2**: A playlist that is live, is encrypted, uses byte ranges, or is in a container we do not assemble, is listed and says which of those it is, and offers no control.
- **AC-3**: No media byte and no playlist byte ever enters the extension. The page fetches the playlist and every segment, and joins them there.
- **AC-4**: Only a master playlist is listed. A quality playlist that a master points at never becomes a row of its own.
- **AC-5**: The page reports what it read and the engine derives what a person is told, exactly as spec 0005 settled for streams. The page never sends a conclusion.
- **AC-6**: When a segment cannot be fetched, no file is offered, and the row names which segment and says that no file was made. One try per segment, no retry: a failure ends the attempt and the row says the file was not made, so a page that went offline does not pretend a video was produced.
- **AC-7**: The same 512 MB page wide cap that spec 0005 set applies to assembly, and reaching it produces nothing rather than a file with a hole in it.
- **AC-8**: A second use of the control while one assembly is running says one is already running, rather than fetching the same segments twice. The flag is kept per entry url, so a second press on the same row waits, and a second press on a different row fetches independently.
- **AC-9**: An MPEG-DASH manifest is listed and labelled honestly, and is never offered as a file.
- **AC-10**: The page's own cross origin rules decide what can be read. A playlist the page cannot read is listed with a sentence saying so, and never fails silently.
- **AC-11**: The file name comes from the existing six step rule, and the extension is `mp4` because that is what a joined fragmented MP4 is.
- **AC-12**: The playlist reader handles the subset this feature supports and treats anything outside it as unsupported rather than guessing, so a playlist it half understands never produces a file.
- **AC-13**: No new host permission and no outbound request from the extension. The reading and the fetching both happen in the page.

## Options considered

### Option 1: Assemble in the page, label everything else

The worker names a playlist it saw, the page reads it, and if it is a simple case the page fetches the segments and joins them. Everything outside the supported subset is labelled with its reason. This is the chosen option.

**Pros**:
- No media byte and no playlist byte enters the extension, which is the invariant spec 0005 was built around and the one that keeps session storage small.
- The page's requests carry its own cookies and referer, so a playlist behind a normal login works with no credential handling anywhere.
- It reuses spec 0005's assembly request, its click to download, its in progress flag and its 512 MB cap, so the new work is a parser and a fetch loop rather than a second pipeline.
- The extension makes no outbound request, so the README's privacy claim stays true as written.

**Cons**:
- A page is subject to cross origin rules that a media element is exempt from, so some playlists and some segments cannot be read and get labelled even though the page is playing them. A worker side fetch would not have that limit.
- The hook grows a parser, a fetch loop and a join, which is the most page logic the extension will ever carry.

### Option 2: Assemble in the service worker

The worker reads the playlist and fetches the segments itself, using the host permissions it already holds for every site.

**Pros**:
- Cross origin rules do not apply, so segments on a CDN without permissive headers would work.
- The extension's own storage could hold parts of the file and survive a page reload.

**Cons**:
- Every media byte travels through the extension, which breaks the central invariant of spec 0005 and puts whole films into session storage.
- Cookies marked `SameSite` are withheld from an extension's cross site request, so protected streams break in exactly the places the page side would have worked.
- It changes a promise the README makes in writing, for a feature that did not need it changed.

### Option 3: Label playlists and never assemble

Say plainly that a playlist is a playlist, that the page's own player turns it into video, and that the stream row is the thing to save when there is one.

**Pros**:
- Small, honest, zero risk, and no new page logic at all.
- Every file the extension produces is one it knows how to produce.

**Cons**:
- Leaves the growing native HLS case unsaved, which is the whole reason the feature exists.
- On a page where the hook cannot see the assembled stream, there is nothing at all to offer.

### Option 4: The worker reads the playlist, the page fetches the segments

A playlist is a few kilobytes of text rather than media, so reading it in the worker costs nothing in memory and the host permissions make cross origin rules irrelevant.

**Pros**:
- No new command from the worker into the page, because the worker already knows what it read.
- The playlist text is available even when the page cannot fetch it.

**Cons**:
- The extension makes an outbound request for the first time, which is the promise Option 1 avoids.
- A playlist behind a login fails, because the extension cannot present the page's cookies, while the segments it would then fetch come from the page with those cookies. The two halves would disagree about who can read what.

## Decision

**Chosen option**: Option 1: Assemble in the page, label everything else, where "assemble" means video on demand, unencrypted, whole segments, fragmented MP4 only.

**Implementation skills**: `chrome-extensions` (`googlechrome/modern-web-guidance`, `.agents/skills/chrome-extensions/`) · `chrome-extension` (`samber/cc-skills`, `.agents/skills/chrome-extension/`)

## Rationale

Option 1 is chosen because it is the only option that keeps the invariant spec 0005 exists to protect. That invariant is not decorative: it is why session storage stays small, why a tab's memory is the page's own business, and why the README can promise that nothing leaves the browser. Option 2 would trade all three for a narrower set of playable sites, and it would do so by making the extension the thing that holds films.

The decisive asymmetry is that a media element is exempt from cross origin rules and a `fetch` is not. Option 1 therefore assembles fewer sites than a worker side fetch would, and that is the honest cost: a site whose segments we cannot read gets a sentence saying we could not read it, rather than a silent failure. The alternative, taking the segments in the worker, buys those sites and pays with the invariant and with credentials, which is the worse trade because the credentials are the common case on sites people actually want to save from.

The MPEG-TS boundary was narrowed during this conversation, and the narrowing is load bearing. The engineer initially chose to assemble transport stream as well as fragmented MP4. Chrome cannot play a standalone MPEG-TS file: it downloads it instead. A joined `.ts` would open in VLC and not in Chrome, which fails this feature's own bar of a playable file, so transport stream playlists are labelled until a remuxer exists. That is a real loss of coverage accepted knowingly rather than a case nobody examined.

Option 4 deserves a note, because it looks like a free simplification and is not. Splitting the reading from the fetching means the half with credentials is in the page and the half without is in the worker, and the two disagree about which playlists are readable. Keeping both halves in the page keeps one answer to that question.

## Feature design

**Data model sketch**:

| Entity | Where it lives | Key fields | Required |
|---|---|---|---|
| `MediaEntry` | inside `TabMedia`, unchanged in shape | gains an optional `playlist` block, absent for files and for MediaSource streams | |
| `PlaylistSignals` | inside `MediaEntry`, new | `live`: boolean, `encrypted`: boolean, `byteRanged`: boolean, `manifest`: `'hls' \| 'dash' \| 'unknown'`, `segments`: `'mp4' \| 'ts' \| 'unknown'`, `variants`: string[] (the urls a master points at, each with the segment kind the page read from it) | present only on a playlist entry the page read |

Relationships: `TabMedia` one to many `MediaEntry`. `MediaEntry` zero or one `PlaylistSignals`, and zero or one `StreamSignals`, never both. `PlaylistSignals` one to many variants by url.

Unique constraint: the engine's existing identity tuple, unchanged. A playlist entry is keyed by its own url with container `m3u8` and quality `unknown`, which is what already happens today. No migration is needed and no stored shape changes beyond the added optional block.

A playlist entry's `sizeBytes` stays null until assembly, because a playlist declares no segment sizes. The row shows its container and nothing more until a file exists.

`variants` is the one field the engine needs and the page would not think to send. It exists because "show only the master" (AC-4) cannot be implemented without knowing which rows to drop, and dropping rows is something the engine does, never the page. `manifest` exists for the same kind of reason: without it a DASH manifest can derive to `assemblable`, because DASH segments are usually fragmented MP4, and the engine cannot then tell an HLS playlist from a DASH one.

**State transitions**:

The state is derived by a pure engine function, `derivePlaylistState(signals)`, never by the page. It returns one state and nothing else, mirroring `deriveStreamState` so there is one pattern in the codebase for this.

| State | From | Trigger | Row shown | Control |
|---|---|---|---|---|
| `unread` | any | no `playlist` block on a manifest container, because the page could not read it | yes | none |
| `encrypted` | any | `encrypted` | yes | none |
| `byte_ranged` | any | `byteRanged` | yes | none |
| `unsupported_container` | any | `manifest` is `dash`, or `segments` is `ts` or `unknown` | yes | none |
| `live` | any | `live` | yes | none |
| `assemblable` | any | none of the above | yes | yes |

The order is the contract and each position earns it. `encrypted` first, because scrambled bytes are never worth a control whatever else is true, the same reason spec 0005 puts it first. Then `byte_ranged`, then `unsupported_container`, because both are the reason we cannot assemble and the byte range case is the more specific of the two. Then `live`, because an endless playlist has no whole file at any size. Then `assemblable`.

**API surface**:

There is no HTTP surface. The messages are the whole interface, and the page to content script channel carries the same shapes.

| Message | From and to | Key inputs | Key outputs | Key errors |
|---|---|---|---|---|
| `ENTRIES_REPORTED` | content script to worker, now also carrying playlist entries | `contractVersion`, `pageUrl`, `pageTitle`, `status`, `entries` (a draft may carry `playlist`) | `{ ok: true }` | a report without the current page token is dropped before it is sent |
| `READ_PLAYLIST` (new) | worker to content script over `chrome.tabs.sendMessage`, relayed into the page | `url` | nothing of its own; the answer rides the next snapshot | a page that is not there is counted, not answered |
| `STREAM_ASSEMBLE` | popup to worker, then worker to content script, then into the page | `url`, `filename` optional | `{ ok, error }` where error is `not_listed`, `already_running`, `no_bytes`, or `page_refused` | unchanged from spec 0005 |
| page channel `read-playlist` (new) | content script into the page | `token`, `url` | the facts, in the next snapshot | |
| page channel `assemble` | content script into the page | `token`, and exactly one of `streamId` or `playlistUrl`, `filename` | | |
| page channel `streams` snapshot | page to content script | `token`, `pageUrl`, `streams`, and a new `playlists` list | | |

The extension contract keeps its six messages. `STREAM_ASSEMBLE` does not change at all, because a playlist entry's url is already what the popup sends and what the worker looks up. `ENTRIES_REPORTED` gains an optional block, which is a payload shape change and therefore a contract version bump, the second this slice.

**Value sourcing**:

| Action | Value produced or displayed | Source |
|---|---|---|
| Read a playlist | whether it ends | the page, from the end of stream marker or the declared playlist type |
| Read a playlist | whether it is encrypted | the page, from the key or sample encryption tags |
| Read a playlist | whether it uses byte ranges | the page, from the byte range tag on any segment |
| Read a playlist | what the segments are | the page, from the initialisation segment the playlist points at, falling back to the segment naming |
| Read a playlist | the list of variants | the page, from a master playlist's variant entries |
| Read a playlist | the number of segments | the page, counted from the media playlist |
| Choose what to assemble | which variant | the page reads every variant playlist it listed, reports each one's segment kind, and takes the highest declared bandwidth among those whose reported kind is `mp4` |
| Assemble | the joined bytes | the page, the initialisation segment followed by every segment in order |
| Assemble | the row's size | the joined file's size, once it exists |
| Display a playlist row before assembly | its size | none, so the row shows no size. HLS declares no segment sizes, and asking each for its length would cost a request per segment for a rough total at best |
| Decide a row's state | what a person is told | the engine's `derivePlaylistState` |
| Decide a row is listed | whether it is a variant of a listed master | the engine, from the `variants` lists on the record |
| Name the file | the base name | the existing six step rule, page title first |
| Name the file | the extension | `mp4`, from the segment container being fragmented MP4 |
| Offer a control | whether the row is savable | the engine, `assemblable` alone |

**Key invariants**:
- No media byte and no playlist byte ever enters the extension. Enforced by where the code runs, and pinned by a test that asserts the size of everything the extension stores.
- The page reports facts; the engine derives every state and every sentence.
- The page never decides which playlists are listed and never drops a row.
- A playlist that the parser only half understands produces no file.
- An entry whose url appears in the `variants` of any listed playlist is not listed.
- The extension makes no outbound request. Everything is fetched by the page.
- Only the master playlist is listed, however many qualities it offers.

**Security model**: one actor, the person using the extension, and one privileged action, saving a file they chose. No authentication, no personal data, nothing leaves the browser, unchanged from spec 0005.

The trust boundary is the page, as it already is for spec 0005, and this feature adds one thing to say about it. The hook fetches on behalf of a url the worker named, and the worker only names urls it saw the page request, so the set of addresses is the page's own. The hook's requests are subject to the same cross origin rules the page's own would be, so a response it can read is one the page could have read, and a hostile page gains no new read primitive. A playlist is untrusted text: a hostile playlist naming an address on an internal network would be fetched by the page and its response could not be read back across origins, so nothing is exposed. The file name comes from the six step rule, which strips path separators, so a playlist cannot write outside the download directory.

**Configuration required**: none. No environment variables and no credentials. The manifest gains no field.

**Popup copy this slice owns**, fixed here the way spec 0005 fixed its own:

| State | Copy |
|---|---|
| `unread` | `This page streams video we could not read` |
| `live` | `This is a live stream, so there is no file to save` (the same sentence as spec 0005) |
| `encrypted` | `This stream is encrypted, so there is nothing we can save` |
| `byte_ranged` | `This playlist points into one file in pieces, which we do not follow yet` |
| `unsupported_container` | `This page streams video in a format we cannot save yet` |
| Sent to the browser | `Sent to your downloads` (the same sentence as spec 0005) |
| One already running | `One download is already being assembled` (the same sentence as spec 0005) |
| A segment failed | `Segment 4 of 210 could not be fetched, so no file was made` |
| The page cap reached | `This page reached its 512 MB limit, so no file was made` |

A row that is `assemblable` carries no sentence before assembly, only a control, because there is nothing to explain until someone presses it. A manifest row that has not been read yet is `unread` rather than nothing, because a row with no explanation reads as a bug, which is the whole complaint this feature answers.

**Critical test scenarios** (each maps to an acceptance criterion):
- Happy path: a video on demand playlist of whole fragmented MP4 segments is listed as one row, its control joins the initialisation segment and every segment, and the file plays, verifies **AC-1**, **AC-3**, **AC-11**
- Labelled: a live playlist, a byte ranged one, an encrypted one and a transport stream one each say which they are and offer no control, verifies **AC-2**, **AC-9**
- One row: a master offering four qualities lists one row and none of the four, verifies **AC-4**
- Partial failure: the fourth of 210 segments returns an error, no file is offered, and the row names segment four, verifies **AC-6**
- Cap: an assembly that would cross 512 MB produces nothing and the row says the page reached its limit, verifies **AC-7**
- Unreadable: a playlist on an origin the page cannot read is listed with a sentence saying so, verifies **AC-10**
- Concurrency: two presses on one playlist fetch the segments once and the second says one is already running, verifies **AC-8**
- Reader: a playlist using tags outside the supported subset is treated as unsupported rather than assembled, verifies **AC-12**

## Build plan

Ordered by the project's Tracer Bullet approach, which means the thin end to end thread first and the thickening after. That shapes the order here more than usual, because half this feature is unconditional and half is gated: the labelling thread is built and works whatever the probe says, and the assembling thread waits on it.

1. **The probe, before anything is built on it**: with the extension loaded, open a page that plays HLS natively, with no JavaScript player, and record whether a stream row appears. A row means spec 0005 already covers those sites and tasks 5 to 7 shrink to a much smaller thing. No row means this feature is the only thing that saves them. Record the answer in this spec's `Follow-up`. This task gates tasks 4 to 7 rather than satisfying one
2. **The data model in the engine**: the `playlist` block on the draft and the entry schemas, a pure `derivePlaylistState` returning one state, a pure variant suppression that also clears the counted keys, the copy above, and the contract version bumped because a payload shape changes, satisfies **AC-2**, **AC-4**, **AC-5**, **AC-9**
3. **The read request and the honest row**: the worker asks the page to read a playlist it saw, the relay passes the ask down, the page fetches and reports only facts, and the popup renders each labelled state with no control. This is the thread that is complete on its own and is worth having whichever way the probe went, satisfies **AC-5**, **AC-10**, **AC-12**
4. **The playlist reader**: a hand written parser for the supported subset only, with tests over a master playlist, a media playlist, an end marker, a key, a byte range and an initialisation segment map, and a test that a playlist outside the subset is refused rather than half read, satisfies **AC-12**
5. **Assembling**, only if task 1 found we cannot already see the stream: fetch the chosen variant's segments with a bounded concurrency of four, named as a constant so the loop and the tests share it, hold them under the existing 512 MB cap, join initialisation segment first, and click a link to the result, reusing spec 0005's request, its in progress flag and its cap, satisfies **AC-1**, **AC-3**, **AC-8**, **AC-11**
6. **The failures**, each with its own sentence: a segment that cannot be fetched, the cap reached, a second press while one is running, and the row naming a manifest we cannot read, satisfies **AC-6**, **AC-7**, **AC-8**, **AC-10**
7. **Real sites**: one video on demand site with fragmented MP4, one live, one encrypted, and one MPEG-DASH, recording what each does, satisfies **AC-1**, **AC-2**, **AC-9**

Every acceptance criterion traces to at least one task and every task to at least one criterion. There is no migration: session storage has no schema to migrate, and a record from an earlier build is discarded whole by the engine's own schema check, which is what the contract version bump is for.

## Consequences

**Positive**:
- The list stops offering a text file as though it were a video, which is the whole complaint.
- Sites whose video Chrome plays itself stop being dead ends, conditional on the probe.
- One row per video instead of one per quality, which is what a person wants from a list.
- No media byte and no playlist byte enters the extension, so the privacy promise survives intact and session storage stays small.
- The reader and the fetch loop are small enough to read on a Tuesday, and there is no new dependency.

**Negative / tradeoffs**:
- The page's cross origin rules decide what can be saved, so some playlists a person is watching will be labelled rather than assembled. A worker side fetch would have saved them, at the cost of the invariant and of credentials.
- MPEG-TS playlists are not assembled at all, which is a real and probably common family of streams left on the table for this slice.
- The hook grows a parser, a fetch loop and a join, which is the most page logic the extension will carry and the part most likely to meet a site that resists it.
- A joined file is built whole in the page's memory, so a long film can reach the cap and produce nothing. That is the honest failure, and it is also a failure a person will meet.
- Until task 7, none of this has met a real site.
- The gate in task 1 can remove most of the value of tasks 5 to 7, and finding that out after building task 4 is wasted work.

**Neutral**:
- DASH is labelled and never assembled.
- The contract version is bumped a second time in this slice.
- The page channel gains one command and one target; the extension's own message set does not change.
- The 512 MB cap stays a constant until scope feature 12 gives it a home in settings.

## Follow-up

- [ ] The outcome of build task 1 belongs here, recorded in this spec rather than only in a commit message, because the shape of tasks 5 to 7 depends on it.
- [ ] MPEG-TS assembly needs a transport stream to MP4 remuxer, which is a real dependency rather than a parser. Until one exists those playlists are labelled, which is honest but is a known gap.
- [ ] `isListable` in `src/engine/media-rules.ts` must not drop a manifest that has no `playlist` block, because "we could not read it" is a row with something to say. Slice 6 added that function and did not have this case in mind.
- [ ] Scope feature 9, subtitles and thumbnails, may want the variant list for language tracks, which is the same read this feature performs. If that feature is built next, the reader should be built so it can hand over what it parsed.
- [ ] The 512 MB cap now governs two things, stream chunks and playlist assembly, and is a constant in the engine. Scope feature 12 is where it becomes a setting.

## References

**Project sources** (verifiable, in this repo):
- `AGENTS.md`: the engine purity rule and the comment rule this slice follows, and the manifest trap about flat build output names
- spec 0001: the engine boundary, the state port, and the single writer rule the worker keeps
- spec 0005: the page hook, the assembly request, the derived stream state, the page wide cap and the copy sentences reused here
- `src/engine/media-rules.ts`: where `m3u8` and `mpd` are already known containers and already refused as unsavable
- `README.md`: the privacy claim that Option 1 keeps true

**Practices & standards**:
- Same origin policy as it applies to `fetch` but not to media elements, which is the asymmetry that caps this design
- Media Source Extensions byte stream format, for why MPEG-TS is a container the browser demuxes rather than one it plays
- Progressive disclosure in the list: a row either offers the thing or says why not, never neither

**Links** (web verified):
- Google Chrome adds native HLS playback on desktop with version 142: https://tech-ish.com/2025/12/08/google-chrome-microsoft-edge-chromium-native-hls-playback-desktop/
- Confirmation from the hls.js project that Chrome 142 plays `.m3u8` natively: https://github.com/video-dev/hls.js/discussions/7644
- Chromium developers group, Chrome does not play a standalone MPEG-TS file and downloads it instead: https://groups.google.com/a/chromium.org/g/chromium-dev/c/1tBgPWRGKgw
- W3C, Media Source Extensions byte stream format for MPEG-2 transport streams: https://www.w3.org/TR/mse-byte-stream-format-mp2t/
- dash.js, the reference MPEG-DASH client, which plays through Media Source Extensions: https://dashif.org/dash.js/