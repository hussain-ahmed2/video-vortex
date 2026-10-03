# Rationale: 0005 Media source and blob stream detection

The decision record for [index.md](index.md). Read by humans and by `/architect` on an update; `/develop` skips it.

## Context

Three forces shaped this slice, and none of them is a preference.

**The bytes are in the wrong place.** A `SourceBuffer` cannot be read back. Whatever the page appended is unreachable from outside the page, so anything worth saving has to be copied as it arrives, and copying it means copying it from inside. That is not a preference between designs; it is the shape of the platform. The same is true of a `blob:` address, which never produces a network request at all, so there is nothing for the observer to see and nothing for the worker to fetch.

**The extension cannot always tell whether a stream is worth offering.** Encrypted media has scrambled bytes, so no amount of work produces a playable file, and the signal that it is encrypted arrives from the page's own API rather than from anything we can observe from outside. A live broadcast has no end and therefore no file. Showing a row for either means offering an action that cannot work, which is the state the empty state was written to avoid.

**The size is unbounded from our side and bounded from the page's.** A stream we collect has whatever length the page feeds it. We hold the copy in the page's memory, not ours, so the limit protects the tab rather than our storage, and a limit nobody is told about is a limit that looks like a hang.

Against those, the extension's own constraints from spec 0001 apply unchanged: the engine stays pure, the worker stays the only writer, and detection keeps running as a generic mechanism rather than a per site one. The mechanism for reaching the page was already decided there, with the proof deferred to a later slice, and this is that slice.

## Options considered

The load bearing decision is how an assembled file reaches the disk. Everything else in the design follows from the answer.

### Option 1: the page assembles the file and starts the download

The hook holds the chunks it copied. On request it joins them into one file and starts the download itself with the name the worker computed.

**Pros**:
- No media byte ever crosses into the extension, so there is no size limit problem in our storage and no message size problem on the wire.
- No new permission and no new runtime. The extension needs no offscreen document and no ability to build a blob url inside a service worker, which is the part that would have made every other option harder.
- The file is exactly what the page assembled, so it is the same bytes the person is watching.

**Cons**:
- We never call `chrome.downloads` for a stream, so we cannot observe whether it saved. The row has to say the file was sent rather than saved, which is a weaker promise than a file row makes.
- The download happens in the page, so the person's only confirmation is the browser's own download UI, one click away.
- We depend on a page initiated download working without a fresh user gesture in that page, which is the one platform assumption here that has not been measured yet.

### Option 1b, for `blob:` origins only: hold the object and click the existing link

This was not an option at all until a cross check asked where the bytes actually are. A `blob:` video is already a finished file in the page's memory. The hook records the `Blob` **object** and does nothing else, and saving it is a click on a link to the url the page already made. There is nothing to copy, so nothing is copied.

**Pros**:
- It deletes the entire byte path for this origin: no chunk list, no cap, no assembly, no partial state, no size tracking, no second copy in memory at peak.
- Holding the object rather than the url string means a page that calls `revokeObjectURL` on us does not break the row, so there is no need to patch that function either.
- The saved file is the page's own object, byte for byte, with nothing reconstructed.

**Cons**:
- A blob gives no signal about encryption, so a DRM blob is offered and its file will not play. There is nothing to detect, which is why the spec records this as a consequence rather than a fix.
- A blob must be bound to a player to be worth a row, which needs a `currentSrc` comparison on each report tick rather than a direct association.
- `createObjectURL` fires for every object on the page, images and fonts included, so blobs must be admitted by their own `type`.

Taking 1b for blobs and Option 1 for MediaSource is the actual decision, and it came out of the cross check rather than out of the original design conversation.

### Option 2: move the bytes to the worker and save with `chrome.downloads`

The page streams chunks to the worker, which owns the name, the progress and the save.

**Pros**:
- Full control and real progress, with the engine's own filename rule end to end and no difference between a file row and a stream row.
- The row could say Saved, because we would see the outcome.

**Cons**:
- Megabytes of media through `chrome.runtime` messaging, which serialises and is not built for it.
- A service worker cannot create the blob url `chrome.downloads` needs, so this also requires an offscreen document: a second runtime, a new permission, and a new build entry to keep alive. That is the cost that decides it.

### Option 3: rebuild the file in the worker from the network segments

The hook reports ordering, container and encryption only, never bytes. The worker concatenates the segments it already sees.

**Pros**:
- The page never hands us a byte, which is the strongest possible answer to the trust question.
- No accumulation in the page at all, so the memory cost disappears.

**Cons**:
- The segments are usually `application/octet-stream` with no filename and often served by byte range, which is precisely why these sites show nothing today. Making them visible is a change to the observer's filter, which widens what every site is scanned for.
- Ordering parallel range requests reliably, and knowing which chunk is the initialisation segment, is fragile in a way that fails as partial files rather than as errors.
- The runner up if Option 1's gesture assumption fails in practice, and the first thing to try then.

### Option 4: re-record playback in real time with `MediaRecorder`

**Pros**:
- Works for anything the browser can play, including formats the byte path cannot reassemble.

**Cons**:
- The file takes as long as the video, is re-encoded rather than copied, loses quality, and captures nothing until it has been watched. It is a last resort, not a design.

## Rationale

Option 1 wins because the other three all fight the platform somewhere, and Option 1's one unproven assumption is cheap to test and has a named fallback. The forces from Context line up: the bytes can only be had from inside the page, so the page is where they should stay; the extension gains no new permission and no new runtime, which keeps it inside spec 0001's least privilege decision; and the weakness it accepts, not being able to see the save, is a wording problem rather than a capability problem.

Option 1b takes the blob half further, and it is the largest single improvement in this spec. Copying the bytes of a blob would have been the obvious way to make the two origins look alike, and it would have cost a chunk list, a cap, an assembly step and a partial state for an object that was already complete. Treating the two origins differently is less uniform and much less work, and uniformity was never a goal worth having here.

Option 2 was the runner up on paper and loses on operations. It needs an offscreen document purely because a service worker cannot mint a blob url, which means a second runtime kept alive to serve a download, and megabytes of media through a messaging channel that was designed for five small messages. The engineer expressed a preference for simplicity across the whole slice, and here that preference and the right answer are the same thing.

Option 3 is the one to revisit if the page initiated download turns out not to work. It is worth keeping in mind precisely because it needs no page side bytes at all, which would also remove the memory problem for MediaSource entirely.

Because Option 1's assumption is the one everything else stands on, it is the first task rather than the last. The original plan proved it at the end, which would have meant building nine tasks that all presuppose an anchor click works from page bytes. If it does not work, the fallback is Option 3, and the cheapest moment to learn that is before any of it exists.

Four smaller decisions are worth recording because they had real runners up.

**The hook observes and the engine decides.** The first draft had the hook classify each stream and report a verdict. That quietly breaks the project's own rule that every decision is made in `src/engine/`, and it would have put the state machine somewhere it can only be tested with a browser. Reporting raw signals instead and deriving the state with a pure function in the engine costs one extra field per signal and buys a state machine provable with no browser at all.

**Why the partial reasons latch, and why there are three of them.** A stream can stop being savable in full for three unrelated reasons: our own page cap, the browser's per buffer quota rejecting an append, and a player calling `abort()` and walking away. They are worth telling apart because the person reading the row can act on two of them and neither on the third, and one sentence cannot honestly cover all three. The browser's quota was not in the first draft at all, which is a good argument for writing the cause list from what the platform actually does rather than from what we expect players to do.

They latch, on the page, because the only copy of the truth lives there and it cannot be un said. The bytes already copied are still copied, so a stream that lost bytes is in that state permanently, and a hook that reported `none` again after a re-append would have the engine render a whole file over a gapped one with nothing to catch the contradiction. Making them three separate states rather than one state beside a reason is the simpler of the two shapes once there are three: it removes the only place the engine returns two values, which is a place a caller can forget to read, and it collapses the copy mapping onto one state per sentence.

**Why `remove()` is left out.** This is the one place in the spec where the honest answer was "not yet". A `remove()` does tear a hole in what we copied, so excluding it means a real gap can be assembled into a file that will not play from the start. But players call `remove()` routinely, for DVR trimming and seek back cleanup, and often re-append the range immediately, so latching on it would mark healthy streams partial for the rest of the tab's life. Latching is what makes that wrong later rather than now. The correct fix is to track the stream's actual byte ranges and let a re-append heal the gap, which is real work in the hook and is recorded as a Follow-up rather than smuggled in here.

**Why playable comes from buffered ranges.** The first draft derived it from the media element's playback progress, on the reasonable-sounding grounds that the element knows whether the video plays. It does not, in the case that matters. A paused or still buffering element never passes its metadata, so a video on a page nobody pressed play on would never be listed at all, and a stream that had already finished would read as collecting forever. Both are the common case, not the edge case. The `SourceBuffer`'s own buffered ranges say what we actually need, which is whether the player's buffer holds media we could hand over, and the browser maintains them for us.

**The cap is 512 MB, not 2 GB.** Two reasons, and neither is about taste. A renderer does not honour a limit we impose: a tab near its memory ceiling is killed rather than throwing something we can catch, so a 2 GB cap is a promise the platform will not keep, and the outcome would be a dead tab rather than a row that says partial. And peak is about twice the cap, because assembly builds a second copy before the file is handed over. 512 MB with a stated 2x peak is a number a tab can actually survive.

**Carrying stream findings on `ENTRIES_REPORTED`** rather than adding a dedicated report message keeps the contract at six instead of seven, and the report already has an entries array that exists only because this slice was anticipated.

**Testing the hook through fakes** in the existing harness keeps `npm test` as the gate, with a real browser test named as the fallback rather than adopted up front, because a new test runner is a decision this project has not made. That needed one more fake than expected, a message delivery capability, because the existing fake resolves without ever reaching a content script listener.

Two premises in the first draft were wrong and were corrected against Chrome's documentation and the source rather than left as beliefs.

The draft claimed that injecting a file into the page's world requires a `web_accessible_resources` entry, and recorded a follow up to correct spec 0001 for saying otherwise. That was backwards. Those resources govern a web page fetching an extension resource, or another extension reading one; `chrome.scripting` loads a packaged file from the extension's own origin, so no manifest entry is needed and no site can read the hook. Spec 0001 was right, the manifest gains no new field, and the store review concern disappears.

The draft claimed a per injection token stopped a page from inventing a stream row. A hook in the page's world shares `window` with the page, so the page can read the token and post anything it likes. The token is still worth minting, for a stale build, a duplicate hook and another extension's injection, but the honest claim is narrower than the one first written, and the acceptance criterion now says only that.

## What was deliberately not decided here

Which three real sites prove this. They are unnamed in the scope row and naming them late would mean discovering the hardest player at the end of the slice, so the spec makes choosing them a task rather than an assumption.

Whether an extractor registry exists for streams. It should not: the hook is generic and is not matched against a page url, which is the distinction spec 0001 draws between an extractor and the fallback. The registry still arrives with feature 8.