# src

## Overview

Everything the extension runs at once: the popup React UI, the Manifest V3 service worker, and the content script injected into every page. They are separate runtimes with separate rules, and the shared types are the only thing that crosses between them, so most surprises live here.

## Key files

| File | Owns |
|---|---|
| `index.html` | Popup shell, and the file Chrome opens as the action popup |
| `src/main.tsx` | Popup entry, mounts `App` into the shell |
| `src/App.tsx` | The whole popup: polling, stream cards, download buttons, progress, plus the local `StreamCard` component |
| `src/background.ts` | Service worker: URL sniffing, the googlevideo header rewrite, downloads, badge counts, the message router, download progress broadcast |
| `src/content.ts` | Content script: YouTube player response extraction, DOM video and audio scan, the SPA URL observer |
| `src/lib/schemas.ts` | `VideoSource` (a zod schema used for its type), `DownloadStatus`, `YouTubeMeta` |
| `src/lib/utils.ts` | The `cn` helper, which is `clsx` plus `tailwind-merge` |
| `src/index.css` | Tailwind v4 entry, the colour tokens on `:root`, the `--color-*: initial` reset and the `@theme inline` mappings |
| `src/components/ui/` | Generated shadcn primitives: `button`, `card`, `badge`, `scroll-area`, `skeleton`, `progress`, `tooltip` |
| `src/components/` | Project compositions that are not generated: `empty-state.tsx`, `notice.tsx` |
| `src/testing/` | The Vitest harness, the four browser API fakes, and the guards under `guards/` |

## Conventions

- Message types are upper case strings (`GET_VIDEOS`, `FETCH_YOUTUBE_DATA`, `DOWNLOAD_VIDEO`, `URL_CHANGED`, `DOWNLOAD_PROGRESS`, `GET_PAGE_INFO`, `GET_YOUTUBE_DATA`, `GET_PAGE_VIDEOS`). Keep that style, and ignore types you do not handle.
- The popup reaches the service worker with `chrome.runtime.sendMessage` and the content script with `chrome.tabs.sendMessage`. Those two channels are not interchangeable, and none of the three runtimes import each other.
- When a listener answers with `sendResponse` after any await or promise, it must `return true` (`src/background.ts:134`, `src/background.ts:154`, `src/content.ts:174`).
- Per tab state lives in module level `Map`s in the service worker, keyed by tab id, and is dropped in `chrome.tabs.onRemoved`.
- YouTube is deliberately kept out of the URL sniffer: `videoplayback` is skipped and the tab URL is checked again before storing. YouTube sources arrive from the content script instead, so a change to that split has to touch both files.
- The popup re reads on a 3 second interval. That is the current design, not a bug to chase while you are in there.
- Streams are split into two lists in the UI: everything whose `type` is not `audio` is video, everything that is `audio` is audio.

## Gotchas

- Content scripts run in an isolated world and cannot read page variables. `extractYouTubeData` injects a `<script>` into the page, then waits for a `__VORTEX_YT_DATA__` `postMessage` with a 3 second timeout (`src/content.ts:22`). Any new read of page state needs that same handshake.
- Only YouTube formats that carry a direct `url` are kept, so signature protected formats never show up and some qualities are simply missing.
- Adaptive streams stay separate. Audio only and video only formats are two rows and two downloads, and nothing merges them afterwards.
- The header rewrite in `src/background.ts:8` registers a blocking request listener, and that form is no longer available to an ordinary extension, so the listener never runs and the YouTube download is rejected for a missing Referer. The replacement is a `declarativeNetRequest` ruleset, decided in `docs/specs/0001-detection-engine-architecture/`. Verified against Chrome's own migration guidance, not assumed.
- The service worker can be stopped between events, so anything the popup needs must be reachable again by message rather than only held in memory.
- The sniffer keeps at most 50 sources per tab and drops the oldest with `shift()` (`src/background.ts:63`).
- Types are loose at the message boundary: `src/background.ts:98` and `src/background.ts:107` walk the YouTube payload as `any`, and the popup progress listener in `src/App.tsx:76` takes `any`. Tighten those with `src/lib/schemas.ts` when you are already in the code.
- `background.js` and `content.js` must land flat in `dist/`. That comes from the `entryFileNames` rule in `vite.config.ts:22`, not from the manifest.
- The popup shows a version string hardcoded in the footer (`src/App.tsx:281`) and the real version lives in `public/manifest.json`. Bump both.
- The shadcn CLI misreads this repo's `components.json`, because `utils` is `@/lib/utils`: it writes `import { cn } from "cn"` and adds a junk `cn` dependency to `package.json`. Repoint the import at `@/lib/utils` and revert the dependency after every `shadcn add`, or the popup fails to resolve its own `cn`.
- The primitives in `src/components/ui/` are generated and the compositions beside them are not. `shadcn add` overwrites a primitive wholesale, so any deliberate override in one (the `progress` fill token, for instance) has to be reapplied, which is why each override carries a comment saying so.

## Related specs

- [0001 Detection engine architecture](../docs/specs/0001-detection-engine-architecture/index.md): what replaces the current pipeline. Scope features A and B in `docs/scope/scope.md` are marked superseded, so read this before extending `src/background.ts` or `src/content.ts`: their logic moves into `src/engine/` (one shared engine, pure, no `chrome.*` at run time) and both runtimes become thin shells. Slice 1 (scope feature 5) is what starts that, and it rewrites both files.
- [0003 Popup design language](../docs/specs/0003-popup-design-language/index.md): the colour tokens, type, spacing and component rules the popup is built to, plus the `src/components/ui/` guarantees. Read it before adding a colour, a primitive or a transition. The popup itself is still being rebuilt onto them in slice 1 (scope feature 5), so the language is settled while the row and state work is not.

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._
