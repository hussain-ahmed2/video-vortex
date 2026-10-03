# src

## Overview

Everything the extension runs at once: the popup React UI, the Manifest V3 service worker, and the content script injected into every page. They are separate runtimes with separate rules, and the shared types are the only thing that crosses between them, so most surprises live here.

## Key files

| File | Owns |
|---|---|
| `index.html` | Popup shell, and the file Chrome opens as the action popup |
| `src/main.tsx` | Popup entry, mounts `App` into the shell |
| `src/App.tsx` | The whole popup: the read path, the two lists split by kind, download buttons, progress, and the three disclosures. It holds no detection, merge or file naming rule, which is why every value it shows arrives already decided |
| `src/background.ts` | Service worker: the `onHeadersReceived` observer that records media responses, the read and download halves of the message router, downloads with progress, the badge count, and listener re-registration on every start |
| `src/content.ts` | Content script: reports `document.title` and page URL changes, and nothing else. No media entry originates here, so the entries it reports are an empty array |
| `src/engine/` | The pure rules all three runtimes share, and the only place a message shape or a file name is decided. See [engine/AGENTS.md](engine/AGENTS.md) |
| `src/lib/utils.ts` | The `cn` helper, which is `clsx` plus `tailwind-merge` |
| `src/index.css` | Tailwind v4 entry, the colour tokens on `:root`, the `--color-*: initial` reset and the `@theme inline` mappings |
| `src/components/ui/` | Generated shadcn primitives: `button`, `card`, `badge`, `scroll-area`, `skeleton`, `progress`, `tooltip` |
| `src/components/` | Project compositions that are not generated: `empty-state.tsx`, `notice.tsx` |
| `src/testing/` | The Vitest harness, the browser API fakes under `chrome/`, and the guards under `guards/` |

## Conventions

- Messages are the five upper case names in `src/engine/messages.ts` (`ENTRIES_REPORTED`, `GET_TAB_MEDIA`, `TAB_MEDIA_UPDATED`, `DOWNLOAD_MEDIA`, `DOWNLOAD_PROGRESS`). Keep that style, and ignore names you do not handle. Never add a sixth for routing.
- Every runtime reaches the worker with `chrome.runtime.sendMessage`. Nothing uses `chrome.tabs.sendMessage` any more, and the worker never messages the content script: it reaches it only by injecting it.
- When a listener answers with `sendResponse` after any await or promise, it must `return true`.
- Per tab state lives in `chrome.storage.session`, one key per tab behind the engine's state port, and never in a worker global, because the worker can be idled out at any moment. `chrome.tabs.onRemoved` deletes the record and drops the id from the index key.
- Detection today is one generic observer on 2xx media responses, with no per site rules. A site's own extractor arrives with scope feature 8, and it plugs in beside the fallback rather than replacing it.
- The popup re-reads when the worker says the record changed and when the person asks, never on a timer. Its only interval recomputes the staleness string from a timestamp it already holds. A read in flight cannot be re-read, so triggers during one are kept and honoured when it finishes, which is why a broadcast that arrives mid-read is not lost.
- Every message boundary closes its channel even when its own work failed, and the failure is counted rather than thrown. A caller waiting on an open channel waits for the life of the popup, and an unhandled rejection in a service worker is a bug report nobody wrote. The worker keeps two counts: `droppedMessageCount` for input it refused, `workerFailureCount` for work it failed. A read answers `undefined` when it fails, which its caller already handles; a download answers the refusal it would have sent anyway. Inventing a "the worker could not do it" field would be a contract change wearing a fix's clothes.
- The two lists are split by the engine's `kind`, not by anything a row decides for itself: `video` and `audio`.

## Gotchas

- Content scripts run in an isolated world and cannot read page variables. Reading the page's own data still needs the handshake in `src/engine/` or a `world: 'MAIN'` injection, whichever the extractor uses.
- The service worker can be stopped between events, so anything the popup needs must be reachable again by message rather than only held in memory. Its `webRequest` registration is the exception that proves the rule: it outlives the worker, so a matching request starts the worker again and that request is recorded. Do not design around the worker being asleep.
- The observer keeps at most 50 entries per tab and drops the least recently seen, which is `MAX_ENTRIES_PER_TAB` in `src/engine/merge.ts`. `hiddenCount` is derived from the distinct identities seen less what is held, never incremented, so an entry dropped at the cap and seen again is not counted twice.
- A payload that type checks is not yet one that is valid. Every message is parsed with zod on arrival and dropped when it fails, which is why the fakes answer `null` for a bad payload rather than throwing.
- `background.js` and `content.js` must land flat in `dist/`. That comes from the `entryFileNames` rule in `vite.config.ts:22`, not from the manifest. The content script has its own build in `vite.content.config.ts` so it stays one self contained file, because it is injected into pages that never asked for it.
- The shadcn CLI misreads this repo's `components.json`, because `utils` is `@/lib/utils`: it writes `import { cn } from "cn"` and adds a junk `cn` dependency to `package.json`. Repoint the import at `@/lib/utils` and revert the dependency after every `shadcn add`, or the popup fails to resolve its own `cn`.
- The primitives in `src/components/ui/` are generated and the compositions beside them are not. `shadcn add` overwrites a primitive wholesale, so any deliberate override in one (the `progress` fill token, for instance) has to be reapplied, which is why each override carries a comment saying so.

## Related specs

- [0001 Detection engine architecture](../docs/specs/0001-detection-engine-architecture/index.md): what replaces the current pipeline. Scope features A and B in `docs/scope/scope.md` are marked superseded, so read this before extending `src/background.ts` or `src/content.ts`: their logic lives in `src/engine/` (one shared engine, pure, no `chrome.*` at run time) and both runtimes are thin shells over it. Scope feature 5 rewrote both files; `src/engine/match.ts`, `page-access.ts` and `extractors/` arrive with features 6 and 8.
- [0003 Popup design language](../docs/specs/0003-popup-design-language/index.md): the colour tokens, type, spacing and component rules the popup is built to, plus the `src/components/ui/` guarantees. Read it before adding a colour, a primitive or a transition. The popup is built to it as of scope feature 5, and `src/design-language.test.ts` holds the rules as assertions.

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._
