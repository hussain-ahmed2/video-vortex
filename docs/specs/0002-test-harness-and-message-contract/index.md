# 0002. Test harness and message contract

**Date**: 2026-09-30
**Status**: In Progress

## Summary

This stands up the test harness the rest of the rebuild depends on: a runner, a DOM shim, hand written fakes for the browser APIs the code actually calls, and two guard tests that enforce the engine's purity rule. The fakes are the important part. They behave like the real APIs in both the callback and promise forms, so a test that writes state and reads it back actually proves something, and each namespace fake is typed against the browser's own definition of that namespace, so a real API change breaks the build rather than quietly drifting. What it does not do is test the engine, because the engine does not exist yet. Those tests arrive with slice 1 and use this harness.

## Requirements

**User stories**:
- As a developer on this extension, I want one command that runs every test, so that I know the engine and the three runtimes still agree before I build the next slice.
- As a developer, I want to import a pure module in a test with no browser present, so that the rules can be tested directly rather than through the loaded extension.
- As a developer, I want the browser APIs faked with real behaviour, so that a test which writes state and reads it back actually proves something.
- As the project, I want the engine purity rule enforced by a test, so that it survives a hurried change.

**Acceptance criteria** (the contract, each criterion is IDed and independently checkable):
- **AC-1**: `npm test` runs the whole suite and exits non zero when any test fails.
- **AC-2**: two real pure modules from `src` can be imported and exercised in a test with no browser present and no `chrome` global defined, one of them parsing a zod schema rather than only merging class names.
- **AC-3**: the fakes store what a test writes and return it on read, support both the callback and the promise form of every call, set `runtime.lastError` on the callback failure path, reject a broadcast with no listener, and let a test drive a download from in progress to complete.
- **AC-4**: the purity walk fails when a module under `src/engine` imports a runtime module, imports anything outside the engine, imports the test helpers, or touches a browser API in value position, including through a dynamic import, while skipping the engine's own test files, type only references and comments.
- **AC-5**: the co located test walk fails for a module with a value export and no sibling test file, skips a module with no value exports, and reports explicitly when the folder holds no modules, so an empty engine can never read as a tested one.
- **AC-6**: both guards are pure functions over a directory, each is proven to fail against a broken fixture tree written to a temporary directory at test time, and the real guard asserts it inspected at least one file.
- **AC-7**: tests that need no page run in plain Node, only files that need one carry the documented environment marker, and the suite finishes in under ten seconds. That is a budget to watch, not a gate to fail on.
- **AC-8**: `npm run build` runs the type check, then the suite, then the bundle, in that order, and passes with the test files present, so the existing type check covers them.
- **AC-9**: the suite's only new development dependencies are the runner and the DOM shim, it needs no browser binary and no network, and exactly one browser type package is installed, the one the compiler config names.

## Decision

**Chosen option**: Vitest 5 with jsdom applied per file, four hand written namespace fakes each typed against the browser's own definition of that namespace, two pure guard functions over a directory, and the build running type check, suite and bundle in order.

**Implementation skills**: `vitest` (installed globally, project conventions not yet in `AGENTS.md`) · `chrome-extensions` (`googlechrome/modern-web-guidance`, `.agents/skills/chrome-extensions/`)

## Rationale

Reasoning, options weighed and references: see [rationale.md](rationale.md).

## Feature design

**Data model sketch**:

No persistent data and no schema of its own. The real data model is `TabMedia` and `MediaEntry` in `0001-state-store.md`, which this feature does not touch. What this feature defines is the set of test side objects, and the shape of a guard's report:

| Object | Shape | Notes |
|---|---|---|
| `installFakeChrome()` | `() => FakeChrome` | Builds a fresh set of namespace fakes, installs them as the global, returns them. The returned object is the handle: tests reach `fake.storage`, `fake.downloads` and so on directly. No separate handle type, and no reset, because a fresh object per test is the whole mechanism |
| `FakeChrome` | `Pick<typeof chrome, 'storage' \| 'runtime' \| 'tabs' \| 'downloads'>` | The four namespaces the code calls today. One documented cast installs it as the global |
| `fakeStorage` | `get`, `set`, `remove`, `clear` over an in memory map, keyed by area (`session`, `local`, `sync`) then by key | `get` returns the stored value by reference with no deep copy, and returns the supplied default when the key is absent |
| `fakeRuntime` | `onMessage.addListener` and `removeListener`, `sendMessage`, and a `lastError` property | `sendMessage` calls every listener and rejects when there are none, with an error whose message matches the browser's own wording. `lastError` is set on the failure path so callback style code behaves as it does in the browser |
| `fakeDownloads` | `download` returning an incrementing id, `search`, `onChanged`, and a test driver that sets a download's state | Every call supports both forms: with a callback it invokes the callback and sets `lastError` on failure, without one it returns a promise. The driver lets a test move a download to complete or interrupted |
| `fakeTabs` | `get`, `query`, `sendMessage`, and `onRemoved` | `sendMessage` rejects when no content script is listening, which is how "the page cannot be read" gets tested |
| `Violation` | `{ file: string, line: number, rule: 'runtime-import' \| 'outside-engine' \| 'testing-import' \| 'browser-api', text: string }` | The report shape both guards use. Tests assert on `rule` and `file`, never on prose, so wording can change freely |
| `WalkResult` | `{ inspected: number, violations: Violation[] }` for the purity walk, `{ inspected: number, untested: string[] }` for the co located walk | `inspected` exists so a walk that found nothing is visibly different from a clean tree |

**State transitions**:

The fixture lifecycle, which is the only state machine here: `installFakeChrome()` builds four fresh namespace fakes, installs them as the global, the test uses them, and the next test replaces the whole set. A fresh instance per test is what keeps one test's stored state out of the next one's assertions. Cross file leakage is prevented by the runner's per file isolation, which this spec pins in the config rather than assuming.

**API surface** (the surface tests call, which is this feature's equivalent of an endpoint table):

| Surface | Signature | What it does | Notes |
|---|---|---|---|
| `npm test` | command | Runs the suite once and exits non zero on any failure | No arguments needed |
| `npm run test:watch` | command | The same suite in watch mode | For the inner loop |
| `installFakeChrome()` | `() => FakeChrome` | Fresh fakes, installed as the global, returned | Called explicitly by the tests that need it, so a test that wants no browser global simply does not call it |
| `collectPurityViolations(dir)` | `(dir: string) => WalkResult` | Walks the syntax tree of every non test module, reporting every violation with a file and a line | A pure function over a directory, so a fixture tree can be pointed at it |
| `collectModulesMissingTests(dir)` | `(dir: string) => WalkResult` | Recurses into subdirectories, reporting value exporting modules with no sibling test file | Same shape as the purity walk, so both guards report the same way |

**Value sourcing**:

| Action | Value produced / displayed | Source |
|---|---|---|
| Running the suite | Pass and fail counts, and the exit code | The runner's own report |
| Deciding a test's environment | Node or jsdom | The `// @vitest-environment jsdom` marker the test author writes at the top of the file. The older glob based mechanism is gone in current Vitest, so the marker is the only way |
| The list of engine modules | The set of non test source files under `src/engine`, found by walking the directory | Read from the filesystem when the test runs, never a hand maintained list |
| The pattern that counts as "has a test" | A sibling file matching the runner's own test include pattern, `*.test.ts` and `*.spec.ts` | The runner's default include, mirrored exactly, so a test the runner picks up is never read as untested |
| Which modules need a test | Whether a module has at least one value export | Decided by the syntax tree walk, so a pure type module is exempt by a rule rather than by a name list |
| A violation's line number | The position of the offending node | The syntax tree walk, which is why a text scan was rejected |
| A fake's stored value | The in memory map inside that namespace fake | Written by the test, returned by the fake; nothing reads real browser storage |
| Which namespaces the fakes cover | `storage`, `runtime`, `tabs`, `downloads` | Every `chrome.*` call in `src/background.ts` and `src/content.ts` today, which is four namespaces and not the seven the first draft listed |
| Which browser type package is the source of truth | `@types/chrome` | The compiler config's `types` array already names `chrome`. The unused second package is removed so the two cannot diverge |
| The order of the build steps | type check, suite, bundle | The `build` script string in `package.json` |
| The runner's own type checking | Whether it runs | Off, by the runner's default. The existing `tsc -b` covers the test files because they live under `src` |

**Key invariants**:
- No test reaches the network or loads a real browser. The only new dependencies are the runner and the DOM shim.
- Each namespace fake is typed as its own real counterpart, so a member Chrome gains fails the type check rather than a test at run time.
- Every fake call supports both the callback and the promise form, and sets `lastError` on the callback failure path. A fake that only speaks promises would make today's callback style code hang.
- The purity walk skips the engine's own test files, type only references and comments, so the guard does not fire on the engine's tests importing the runner, nor on prose that names a browser API.
- The two guards treat a missing directory differently, on purpose: the purity walk fails hard, because a missing path means the walk is pointed at the wrong place; the co located walk reports an empty result, because an engine that does not exist yet is a legitimate state today. Only the first guards against a misconfiguration.
- Both guards return how many files they inspected, and the real guard asserts it inspected at least one, so a green suite cannot mean a broken walk.
- Both guards are pure functions over a directory, and the broken fixtures they are tested against are written to a temporary directory at test time, never checked in. A checked in fixture under `src` would be typechecked by the build and collected by the runner as a real test.
- Nothing under `src/engine` imports `src/testing`, and the bundler only walks from the three entry points, so the fakes cannot reach the built extension.
- Test files live under `src`, so the existing type check covers them. That requires adding the node types to the compiler config, because a test needs node globals and a filesystem root.
- Tests import what they use rather than relying on globals, so the ESLint config needs no test environment block. That holds today only because the TypeScript preset turns the undefined variable rule off, and it would need revisiting if a type checked config is adopted.

**Security model**:

Nothing sensitive is handled. Three rules matter. The fakes hold only synthetic data, so no test can read or write the developer's real extension storage. No test loads the built extension or opens a real browser profile. And the fakes are not shipped: they are unreachable from the three entry points, and the purity walk asserts the engine does not import them.

**Configuration required**:

None. No environment variables, no secrets, no third party credentials. Two configuration changes are compiler and manifest level rather than credentials, and both are in the build plan: adding the node types and the iterable DOM lib to the app compiler config, and removing the unused second browser type package.

**Critical test scenarios** (each maps to an acceptance criterion in `## Requirements`):
- Happy path: `npm test` on a clean tree with `src/engine` not yet created passes, having imported two real pure modules from `src`, one of which parses a schema, and run the fakes' own tests, verifies **AC-1**, **AC-2**, **AC-7**
- Failure case: a fixture module in a temporary engine folder that calls a browser API directly makes the purity walk report that file and line, and the guard's own test passes only because the fixture fails it, verifies **AC-4**, **AC-6**
- Guard with teeth, the analogue of a permission check: a fixture engine module with a value export and no sibling test is reported by the co located walk, while a pure type module beside it is exempt, and a missing directory is reported as empty rather than passing silently, verifies **AC-5**
- Fake fidelity: a test writes a record through fake storage and reads it back by reference, the same call in callback form receives the value, a failed callback observes `lastError`, a broadcast with no listener rejects, and a fake download is driven from in progress to complete, verifies **AC-3**, **AC-9**
- Build gate: `npm run build` fails on a red suite and passes on a green one, with the type check having run first and having covered the test files, verifies **AC-8**

## Build plan

1. Add `vitest` and `jsdom` as development dependencies, remove the unused second browser type package so only the one the compiler config names remains, and add an `engines` field recording Node 22.12 or newer. Do not enable Vite 8's full bundle mode; module mocking is broken there. satisfies **AC-1**, **AC-7**, **AC-9**
2. Add the test settings inside the existing `vite.config.ts` behind a type reference, rather than in a second config file, because the node side of the build only includes that file and a new one would never be typechecked. Pin the pool and isolation so per file isolation is a recorded decision rather than a default that can change. satisfies **AC-1**, **AC-7**
3. Add the node types and the iterable DOM lib to the app compiler config, so test files can use node globals and a filesystem root, and a DOM test can spread a node list. satisfies **AC-2**, **AC-8**
4. Add `test` and `test:watch` scripts, and change `build` to run the type check, then the suite, then the bundle, in that order. satisfies **AC-1**, **AC-8**
5. Write the first tests against two pure modules that already exist, `src/lib/utils.ts` and a zod parse of `src/lib/schemas.ts`, in plain Node with no DOM and with no `chrome` global defined, since nothing installs one yet. This is the proof the harness works before anything depends on it. satisfies **AC-2**, **AC-7**
6. Build the four namespace fakes, one small file each, under `src/testing/`, each typed as its own real counterpart and composed into a `Pick` of the namespaces in use, installed through a single documented cast. Every call takes both a callback and no callback, and sets `lastError` on the callback failure path. Two compiler settings constrain the style here: erasable syntax only bans enums, namespaces and constructor parameter properties, and the unused parameter rule bans stub methods that ignore their arguments. satisfies **AC-3**
7. Write the fakes' own tests: a storage round trip returning the stored value by reference, the same call in callback form, a failure path that sets `lastError`, a runtime listener registry, a broadcast that rejects when nothing is listening, a tab send that rejects with no content script, and a download driven from in progress to complete. satisfies **AC-3**, **AC-9**
8. Write the purity walk as a pure function over a directory using the TypeScript syntax tree: report a runtime import, an import outside the engine, an import of the test helpers, and a browser rooted access in value position, static or dynamic, with a file and a line. Skip the engine's own test files, type only imports and comments, and return how many files were inspected. satisfies **AC-4**
9. Write the co located test walk as a pure function over a directory: recurse into subdirectories, skip test files and modules with no value exports, report a value exporting module whose sibling does not match the runner's own test include pattern, report an empty folder explicitly, and fail on a missing directory. satisfies **AC-5**
10. Write both guards' self tests against fixture trees written to a temporary directory at test time: one broken module per violation, one value exporting module with no test, one pure type module, one clean tree, and one missing directory. Each guard must fail on the broken inputs and pass on the clean one. satisfies **AC-6**, **AC-4**, **AC-5**
11. Confirm the suite runs with no browser binary and no network, that it stays inside the ten second budget, and that `npm run build` is green with every test file present. satisfies **AC-9**, **AC-7**, **AC-8**

## Consequences

**Positive**:
- The engine purity rule gets teeth before the first engine module is written, which is the only moment the guard is cheap to add.
- A test can now import a pure module and call the runtime handlers directly, which is what makes the chosen test target reachable at all.
- Each namespace fake is typed against the browser's own definition, so API drift fails the build rather than surfacing later.
- The suite needs no browser and no network, so it stays fast and works anywhere Node does, including a future CI runner.
- Every future slice arrives with a harness already in place, which is the retrofit this arc exists to avoid.
- Keeping the fake to four namespaces means less code to maintain now, and no code at all for the old pipeline's needs.

**Negative / tradeoffs**:
- The fakes are the largest single piece of this feature by volume, and someone has to maintain them. The typing is what keeps that honest, and it is also what makes a namespace change cost a few lines here.
- Purity failures surface at commit time rather than in the editor, which is later than a lint rule would catch them. Accepted, because a lint rule would miss the direct API call that actually happens and would flag the type only references the engine is allowed to make.
- The build now runs the suite, so a red test blocks a rebuild. The inner loop uses `npm run dev` and is unaffected, but a broken test will stop you building until it is fixed.
- Adding a runner and a DOM shim brings a dependency tree of a few hundred packages into a project that currently has none for testing. That is the ordinary cost of having tests at all.
- The guards skip the engine's own test files and type only references. That is deliberate, and it is also the place a real violation could hide, so the walk's skip rules are part of the spec rather than an implementation detail.
- This feature does not test the engine, the contract, the merge rules or the handlers, because none of them exist yet. Its value is entirely in what slice 1 inherits.
- Two small pieces of work moved forward to slice 1: the in memory state store fake and the per tab serialisation test. Both need the real port type to exist first.

**Neutral**:
- The DOM shim has no layout engine, so `getBoundingClientRect` returns zeros. Harmless while nothing renders, and the thing to remember when the popup gets component tests.
- Fake timers are a convention with an explicit call site in the tests that wait, not a global setting, so a three second handshake timeout costs no wall clock time and no flake.
- The runner's own type checking stays off, because the existing `tsc -b` already covers the test files.
- The ten second budget in AC-7 is a thing to watch, not a threshold that fails a build.

## Follow-up

- [ ] The `vitest` skill is installed globally but its conventions are in no context file. They apply to every file in the project, so they belong in root `AGENTS.md`, which `/sync` owns. Flagged rather than written.
- [ ] Root `AGENTS.md` says no test runner is installed and that no specs exist. Both go false with this slice, and the build approach placeholder is still unfilled from the scope pass. All three are `/sync` fixes.
- [ ] The scope row for this feature says the Done when covers the three runtimes and the message shapes. That part lands with slice 1, so the row's Done when should be reworded. `/scope` owns that wording; I have not changed it.
- [ ] Slice 1 adds the in memory `StateStore` fake against the real port type, and the per tab serialisation test against the real chain in `src/engine/merge.ts`, which `0001-state-store.md` already places there. Neither should be a copy.
- [ ] Slice 1 adds the three deferred namespace fakes, `webRequest`, `action` and `scripting`, when the code that calls them exists.
- [ ] Slice 1 should add the real browser smoke test: load the built `dist` folder with Playwright, using the Chromium channel, and ping the real service worker. That is the only thing that catches the manifest and the flat built file names, which is this project's known silent breakage. It is deferred because there is no engine to smoke until slice 1.
- [ ] When the browser smoke test is written, note the side loading trap: Chrome and Edge removed the command line flags that load an unpacked extension, so it needs Playwright's persistent context with the Chromium channel and the two load flags, running headed. Pointing it at your everyday Chrome profile loads nothing and fails silently.
- [ ] The content script's page world access cannot be tested for real without a browser, since the page's own script policy applies even to a main world injection. The page access port is what keeps that testable: tests fake the port, and the browser smoke test covers the rest.
- [ ] A React component testing skill exists in the registry, covering Testing Library, MSW and axe accessibility assertions. It was considered here and deliberately skipped, because it serves the popup layer this spec excludes. It is the right addition when the popup gets component tests, and the `vitest` skill does not cover that layer.
- [ ] An extension aware MCP server was considered and set aside in favour of `chrome-devtools-mcp`, which now ships five dedicated extension tools including loading the extension. The one that was passed over has three GitHub stars and is vendor backed. Recorded so it is not offered again.
- [ ] If the engine grows past a dozen modules, reconsider the co located test walk. At that scale an import boundary plugin with real layer policy may be worth the dependency.
