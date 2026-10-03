# src/engine

## Overview

The rules the popup, the service worker and the content script all need and must agree on: what one detected file is, what one tab's list is, what a message looks like, when a file can be saved, what a file is called, and how a batch of findings becomes a list. Nothing here reaches a browser API, so the same code decides in all three runtimes instead of three copies drifting apart.

## Key files

| File | Owns |
|---|---|
| `types.ts` | The data model: `MediaEntry`, `TabMedia`, the finding draft, and `CONTRACT_VERSION`. Also the derived helpers `seenCountOf` and `hiddenCountOf` |
| `messages.ts` | The five messages and their zod schemas, `parseMessage` for anything arriving from another runtime, and `request` so no call site can forget the contract version |
| `media-rules.ts` | The content type to container map, the known container list, `containerFromPath`, `kindFor`, `isDownloadable`, and `isSuccessStatus` |
| `identity.ts` | The identity tuple that makes two findings the same file, plus the network fallback's own id and reason |
| `merge.ts` | The field by field merge, `MAX_ENTRIES_PER_TAB`, the derived `hiddenCount`, and the per tab serial queue |
| `filename.ts` | The six step file name rule |
| `format.ts` | The computed strings the popup renders: byte counts, staleness, the hidden count line, transfer percentage |
| `state-port.ts` | The four state operations and the keys they live under, so the engine never calls storage |

## Commands

```bash
# Just this area. No browser, no network, no chrome global defined at all
npx vitest run src/engine
# The purity guard over this directory, which is the rule below made executable
npx vitest run src/testing/guards/guards.test.ts
```

## Conventions

- **Pure, with type only imports.** No `chrome.*` call at run time. Effects leave through a port or a message. `src/testing/guards/` fails the build if that stops being true, so do not work around it.
- Every module opens with a short header saying what it owns and why it exists. Keep that shape when you add a module.
- Every message crossing a runtime boundary is parsed with zod before use, on both ends. A payload that type checks is not yet one that is valid.
- Every engine module is tested with no browser and no network. That is why the merge, the cap and the identity rules are provable at all, so keep new logic here rather than in a runtime.
- `hiddenCount` is derived from what has been counted less what is held, never incremented, so an entry dropped at the cap and seen again is not counted twice.
- `container: 'unknown'` compares equal to itself across findings, so one file first seen without a path extension and again with one stays a single row.
- A record that fails schema validation on read is discarded, not repaired.

## Gotchas

- Merges for one tab are serialised through a promise chain, because `await` yields. Two reports arriving together both survive because of that queue; removing it reintroduces a lost entry that no test would notice until it happened.
- `container: 'unknown'` is in the identity tuple on purpose. It is the one value that has to compare equal to itself, and it looks like a bug the first time you read it.
- `filename.ts` is the single seam feature 13 replaces with a template and a settings store. Keep the rule in one place rather than letting a runtime grow its own.
- The engine does not know what a site is. Adding a site means a new extractor file beside the generic observer, never an edit to a module here.

## Related specs

- [0001 Detection engine architecture](../../docs/specs/0001-detection-engine-architecture/index.md): the purity rule, the state port, the message contract, and why each layer sits where it does. Read it before adding a module or widening the port.
- [0004 Walking skeleton](../../docs/specs/0004-walking-skeleton/index.md): the module layout this slice built, the data model including `seenCount`, and the acceptance criteria each module satisfies.

_Drafted by /sync from the introducing change, worth a quick human pass._