# Verify: media source and blob stream detection · spec 0005 · updated 2026-10-03

_Steps derived from spec 0005 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

Built so far: build plan tasks 2 and 3 only. Task 1 is the gesture proof and tasks 4 to 12 are unbuilt, so most steps below are engine level and need no browser. Rows marked "not built" name the acceptance criterion and wait for their task.

## UI / manual

- [ ] Load the extension on a real MediaSource site, open the popup → the stream is listed with a control, and clicking it saves a file that plays → AC-1, AC-5, AC-10 (task 1 and tasks 8 to 12, not built)
- [ ] Click download on a stream row with no fresh gesture in the page → Chrome still starts the download, which is the assumption the whole slice rests on → AC-10 (task 1, not built, needs a person)
- [ ] Play a paused video nobody pressed play on → the row still appears, because it comes from buffered bytes rather than playback progress → AC-5 (task 7, not built)
- [ ] Play an endless stream → the row says there is no file and offers no control → AC-7 (task 10, not built)
- [ ] Fill a page past 512 MB of stream bytes → every row on that page says the page reached its limit, and playback is not interrupted → AC-9 (task 10, not built)
- [ ] Trigger `SourceBuffer.abort()` → the row says the player abandoned the stream, not the cap sentence, and a later re-append does not clear it → AC-9, AC-14 (task 10, not built)
- [ ] Trigger an append Chrome rejects against its own per buffer quota → the row says the browser's limit, which is neither of the other two sentences → AC-9 (task 10, not built)
- [ ] Navigate a single page app between two videos without a reload → the streams still listed survive → AC-20 (task 11, not built)
- [ ] Reload the page → stream rows the fresh hook does not know are dropped, and the page's file rows survive → AC-15, AC-21 (tasks 6 and 11, not built)
- [ ] Open three real MediaSource sites, at least one with a DVR style player → each lists and each download plays → AC-19 (task 12, not built)

## Commands

- [ ] `npx vitest run src/engine/identity.test.ts` → the stream url is unique per page and per stream, and `containerFromPath` returns null for every minted url → AC-3
- [ ] `npx vitest run src/engine/media-rules.test.ts` → one test per precedence position: encrypted above all, partial above live, partial above assembling, partial above ended, live above assembling, plus the three partial reasons each mapping to their own state → AC-5, AC-7, AC-8, AC-9
- [ ] `npx vitest run src/engine/media-rules.test.ts` → `isStreamSavable` is true only for `playable` and `ended`, so a live row and each partial row carry no control → AC-7, AC-9, AC-10
- [ ] `npx vitest run src/engine/merge.test.ts` → a stream survives a merge with its signals taken whole, an unknown stream is dropped along with its counted key, the hidden count is rebuilt rather than decremented, and a file entry is never touched → AC-15, AC-21
- [ ] `npx vitest run src/engine/messages.test.ts` → the contract declares exactly six names, `STREAM_ASSEMBLE` parses with and without a filename, the filename survives a parse and revalidation, a mismatched contract version is refused, and an unknown refusal string is rejected → AC-2, AC-17
- [ ] `npx vitest run src/testing/chrome/chrome.fakes.test.ts` → a tab message resolves through the content script listener the test registered, the listener is told which tab it is on, and a page with no content script still refuses → AC-2
- [ ] `npx vitest run src/engine/types.test.ts` → the stream schema accepts what the page reports, refuses NaN and Infinity and a negative byte count, and a malformed block fails the whole entry rather than being dropped → AC-5, AC-7, AC-9
- [ ] `npm test` → 598 tests across 28 files, green → every criterion above
- [ ] `npx tsc -b` → clean, so the two changed payload shapes typecheck end to end → AC-3, AC-17
- [ ] `npm run build` → both bundles build, so the content script is still one self contained file → AC-18 (partial, the hook build is task 4)

## Acceptance-criteria coverage

- AC-1 → not built. Needs the page hook, task 4.
- AC-2 → covered by `src/engine/messages.test.ts` and `src/testing/chrome/chrome.fakes.test.ts`. The token itself is task 5.
- AC-3 → covered by `src/engine/identity.test.ts`.
- AC-4 → not built. The rule the engine enforces, no hook yet to prove it.
- AC-5 → engine rules covered by `media-rules.test.ts` and `types.test.ts`. The row appearing is task 7.
- AC-6 → not built. Report cadence is task 9.
- AC-7 → engine rules covered by `media-rules.test.ts`. The row and its copy are task 10.
- AC-8 → engine rule covered by `media-rules.test.ts`. The worker discarding the entry is task 6.
- AC-9 → engine rules covered by `media-rules.test.ts` and `types.test.ts`. The page latch and the cap are task 10.
- AC-10 → engine savability covered by `media-rules.test.ts`. The two hops in a browser are tasks 1 and 8.
- AC-11 → not built. Task 10.
- AC-12 → not built. Task 8.
- AC-13 → not built. The filename's stream branch is task 8.
- AC-14 → covered by `src/engine/merge.test.ts` for two streams being two rows. One id per `MediaSource` is task 9.
- AC-15 → covered by `src/engine/merge.test.ts` for the drop. The fresh hook announcing itself is task 6.
- AC-16 → not built. Task 10.
- AC-17 → covered by `src/engine/messages.test.ts`.
- AC-18 → partial. The message delivery fake exists; the third Vite config and the MediaSource, SourceBuffer and blob fakes are task 4.
- AC-19 → not built. Task 12, and it needs three named sites that the spec does not have yet.
- AC-20 → not built. Task 11.
- AC-21 → covered by `src/engine/merge.test.ts`.