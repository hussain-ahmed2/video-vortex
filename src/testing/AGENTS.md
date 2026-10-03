# src/testing

## Overview

The test side of the project: hand written fakes for the browser APIs the three runtimes call, so the worker, the popup and the content script can be driven with no browser present, plus the guards that turn project rules into build failures rather than review comments. It is the reason the engine's rules are provable at all, and the reason a raw colour or a browser call inside the engine fails `npm test` instead of shipping.

## Key files

| File | Owns |
|---|---|
| `index.ts` | The entry point a test imports: `installFakeChrome` plus the fakes' own types and the `deliver` / `NO_RECEIVING_END` / `splitCallback` helpers |
| `chrome/install.ts` | Builds one fresh set of fakes and puts them where the extension expects them |
| `chrome/types.ts` | The narrow surface this extension actually calls, owned in one file so a test cannot reach past it |
| `chrome/dual.ts` | The one place that knows a Chrome call can be made two ways, promise or callback |
| `chrome/runtime.ts` | The message registry, the broadcast, and `lastError` |
| `chrome/tabs.ts` | Tab lookups plus the two ways a message to a tab can fail |
| `chrome/storage.ts` | Three storage areas over one in memory map each, `session` included |
| `chrome/downloads.ts` | Real download items a test can drive through their states |
| `chrome/action.ts` | The toolbar badge, the only part of `chrome.action` this extension uses |
| `chrome/scripting.ts` | Injecting the content script onto a tab on demand, including the failure the worker has to survive |
| `chrome/web-request.ts` | The response observer, which is how the engine sees a page's media at all |
| `guards/engine-purity.ts` | Fails the build if a module under `src/engine/` calls a browser API |
| `guards/co-located-tests.ts` | Fails the build if an engine module that exports something has no test beside it |
| `guards/design-tokens.ts` | Fails the build if a component can render a colour that is not a theme token |
| `guards/test-file-pattern.ts` | The one pattern that decides "is this file a test", shared by the guards |
| `guards/ast.ts` | Shared plumbing: finding the project root and walking sources |
| `guards.test.ts` | Where the guards run, over fixture trees and then over the real project |

## Commands

```bash
# The fakes' own tests, and the guards over the real project
npx vitest run src/testing
# Just the guards, which is the fastest way to see what they would reject
npx vitest run src/testing/guards/guards.test.ts
```

## Conventions

- The fakes are hand written and narrow. `types.ts` owns the surface, so a fake that grows a method the extension never calls is a bug in the fake, not a feature.
- Every fake returns a control surface a test drives: `webRequest.respond(...)` fires the observer event, `action.badgeText(tabId)` reads back, `downloads.search(...)` reports items. Tests drive the extension through those, never by reaching into the fake's internals.
- A guard is a test, so the guards run inside `npm test` and nothing extra has to be remembered.
- Each guard is proven twice: against a fixture tree that must trip it, and against the real project, which must not. A guard with no fixture cannot be trusted to fire.
- `deliver`, `NO_RECEIVING_END` and `splitCallback` exist because Chrome's two calling styles and its "nobody is listening" case are real behaviours, not test conveniences.

## Gotchas

- `installFakeChrome(tabs)` installs into the global the extension reads, so a test that installs twice without cleaning up keeps the first set. Each test installs its own in `beforeEach`.
- `chrome.storage.session` is a plain in memory map here, so anything about surviving a worker restart has to be proven against the real worker, not here. The fake cannot lose data, which is exactly what makes it useless for that one question.
- A message with no listener resolves as `NO_RECEIVING_END` rather than throwing, because that is what Chrome does. A test asserting "the worker dropped it" should look for that value, not for a rejection.
- The engine purity guard reads the real `src/engine`, so a `chrome` reference in a comment or a string is fine but a type only import of a browser type is not. Read the guard's message before working around it.

## Related specs

- [0002 Test harness and message contract](../../docs/specs/0002-test-harness-and-message-contract/index.md): why the harness exists in this shape and what the fakes promise.
- [0004 Walking skeleton](../../docs/specs/0004-walking-skeleton/index.md): AC-7, which names the `webRequest` and `action` fakes and the two reports arriving together as the reason they exist.
- [0003 Popup design language](../../docs/specs/0003-popup-design-language/index.md): the rules the design token guard turns into build failures.

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._