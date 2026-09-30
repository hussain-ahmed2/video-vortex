# 0001.1 Engine boundaries

*Child of [0001 Detection engine architecture](index.md). No status line: the umbrella carries it.*

## Summary

This fixes who owns what across the three browser runtimes, where the shared code sits, and one rule that makes the rest testable: code in the engine never calls a browser API. Today the popup, the worker and the content script each hold their own copy of the same rules, which is why they disagree. After this, the rules exist once, the runtimes are thin shells that move data, and the browser facing code is easy to name.

## Decision

**Chosen option**: one shared engine folder that all three entry points import, the worker as the only hub, and the browser touching code confined to the two runtime files.

(basis: the manifest naming `background.js` and `content.js` by flat name, your chosen test target, and the convention of one hub per extension)

**Implementation skills**: `chrome-extension` (`samber/cc-skills`, `.agents/skills/chrome-extension/`) · `chrome-extensions` (`googlechrome/modern-web-guidance`, `.agents/skills/chrome-extensions/`)

## Boundaries

| Concern | Decision | Reason |
|---|---|---|
| Where the shared rules live | `src/engine/`, imported by the popup, the worker and the content script, with Vite bundling a copy into each entry | One implementation instead of three drifting copies, and the only shape where the rules can be tested with no browser |
| Engine purity | No module under `src/engine/` calls a browser API at run time. Type only imports from the browser type packages are allowed. Extractors are pure over the `PageAccess` port, so a hook installing extractor is still pure code | This is the rule that makes "pure logic plus message contract" tests possible at all. It is worth more than the indirection it costs |
| How the engine causes effects | Through a port for state, through the `PageAccess` port for anything on a page, and through messages for everything else. No direct calls | Keeps every side effect visible at a port or message boundary, which is where the tests live |
| Who talks to whom | The worker is the only hub. The content script and the popup send to it. The worker broadcasts out to any open popup. It never opens a conversation with the popup | One place where the rules and the state live, one contract to test, no two way conversations to reason about |
| Which extractors run | The content script matches its own page URL against the registry. There is no routing message | The content script already has the URL, and matching it is a pure function, so routing from the worker would carry information the sender already had |
| The old implementation | `src/background.ts` and `src/content.ts` are rewritten in place as each slice lands. No feature flag, no second live path, no archive copy | Two engines running at once is two things to debug at the same time, and the scope already marks the old pipeline superseded |
| Build inputs | Unchanged: `index.html`, `src/background.ts`, `src/content.ts` stay the three Vite inputs. The engine is not a fourth entry | The manifest names `background.js` and `content.js` by flat file name, so adding or renaming an input breaks the extension silently. Keeping three inputs keeps that risk where it already is |
| Header rules | A static rules file in `public/`, so it is copied into the built extension beside the manifest, and a static ruleset needs no permission of its own | Rules are the only supported way to change request headers now, and the values they set never change at run time, so there is nothing to make dynamic |

## Module layout

The target shape. Exact file names may move during the build, the boundaries may not.

| Path | Owns | May call a browser API |
|---|---|---|
| `src/engine/types.ts` | `MediaEntry`, `TabMedia`, `MediaEntryDraft`, the status enum, `CONTRACT_VERSION` | No |
| `src/engine/identity.ts` | The entry identity rule: what makes two findings the same entry | No |
| `src/engine/merge.ts` | Merging a batch of reported entries into a record, field by field, with the per tab serialisation and the cap | No |
| `src/engine/media-rules.ts` | Deriving `container`, `kind` and `quality` from what was observed, and the derived `isDownloadable` rule | No |
| `src/engine/filename.ts` | The file name rule, which scope feature 13 replaces | No |
| `src/engine/match.ts` | Glob URL pattern matching, used by the content script to find its extractors | No |
| `src/engine/state-port.ts` | The `StateStore` interface the engine needs: load, save, remove, tabs | No |
| `src/engine/page-access.ts` | The `PageAccess` interface an extractor is given, which the content script implements | No |
| `src/engine/messages.ts` | The five message names, their zod schemas and their types | No |
| `src/engine/extractors/` | One file per site extractor, plus the generic network observer as the fallback. Pure over `PageAccess` | No |
| `src/background.ts` | The `StateStore` implementation over session storage, request observation, header rules, routing downloads, the badge, the message listener, the per tab merge chain | Yes |
| `src/content.ts` | Injection, the `PageAccess` implementation, registry matching, DOM observation, the postMessage bridge out of the page's world, reporting | Yes |
| `src/App.tsx` | Rendering and sending messages. No rules | Yes |

The naming and the file split follow what scope feature 2 sets (one short header per module saying what it owns and why). If the build wants a different file split, that is fine; the column that matters is the last one.

## Invariants

- No import path from `src/engine/` reaches a runtime module, and no runtime module is imported by the engine. This is checkable with a lint rule or a test that walks the import graph, and feature 3 (the test harness) is the natural place for it.
- The popup holds no detection rules. If a rule ends up in `src/App.tsx`, it belongs in the engine.
- The content script holds no merge rules. It reports; the worker merges.
- Both runtimes stay thin enough to read in one sitting. When one grows past a few hundred lines, the logic inside it is engine logic that has not been moved yet.

## Consequences

**Positive**:
- The rules are written once, so a fix lands in one place for all three runtimes.
- The engine can be tested with no browser, no fake globals and no extension APIs, which is the test target this project chose.
- Naming the boundary makes the next question ("where does this go?") answerable from a table instead of from taste.

**Negative / tradeoffs**:
- A little ceremony on every effectful action, since it goes through a port or a message rather than a direct call.
- The engine ships as duplicated bytes inside each bundle, a few kilobytes for the lot.
- Rewriting the two runtime files in place means slices 1 and 2 touch code that currently works, so each slice needs a real check after it lands.
- The purity rule is a convention with teeth only if something enforces it. Until feature 3 adds that check, a stray direct call will not fail anything.

**Neutral**:
- The import graph check is a lint rule or a test, not a compiler guarantee, because TypeScript cannot express "no runtime browser API here" directly.
- Nothing about React, Vite, Tailwind or the popup changes. This decision is below the UI.

## Follow-up

- [ ] Feature 3 (test harness) should add the import graph check for engine purity. Without it the rule decays the first time someone is in a hurry.
- [ ] The `crxjs` skill is installed but this decision keeps the existing three input setup. If hot reloading the worker and content script becomes painful in practice, that is a separate decision with its own spec.
- [ ] Root `AGENTS.md` does not yet say that engine code is pure. `/sync` should add it, since it is a project wide rule that every future file must follow.

## Rationale

The alternative shapes were a separate engine bundle the worker owns, and logic left duplicated inside each runtime. The separate bundle was rejected because it turns every read into a round trip, so the popup can no longer render from a value it already holds, and because it puts the testable code one message away from the code that is hardest to test. Leaving the logic duplicated was rejected because it is the arrangement that produced the current drift. The purity rule was not an option the engineer was asked to accept as a goal; it was asked as a question about testability, and it is the one constraint that makes the chosen test target achievable without a browser. Cost of being wrong: if a future feature genuinely needs the engine to reach the browser directly, the fix is a new port, not a hole in the rule.
