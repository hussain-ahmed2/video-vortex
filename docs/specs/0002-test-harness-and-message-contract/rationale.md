# 0002 Test harness and message contract, reasoning and references

*Decision record for [index.md](index.md). Read by humans and by `/architect` on a
later update. `/develop` skips this file.*

## Context

Spec 0001 settled how the engine is shaped and delegated four pieces of work to this feature: the engine purity check (`0001-engine-boundaries.md`), the in memory `StateStore` and the tests for merge, identity, cap and per tab serialisation (`0001-state-store.md`), and the contract tests with their bad payload, unknown name and version mismatch cases (`0001-message-contract.md`). The project default test target, chosen in the scope pass, is pure logic plus the message contract.

That target is not reachable with what is in the repository today. There is no test runner, so `npm test` does not exist. More seriously, nothing can test the three runtimes, because they call the browser's `chrome.*` globals directly and there is no browser in a test process. The current code proves the point: `src/background.ts` walks a YouTube payload as `any` in two places, the popup's progress listener takes `any`, and the content script's handshake has a three second timeout no test can currently reach. Those are exactly the failures a harness catches, and they are why the project cannot verify a single slice of the rebuild.

Three facts about the repository shaped the design and are easy to get wrong from a distance. The compiler config names the browser types but not the node types, so test files cannot use node globals as the project stands. The node side of the build only includes `vite.config.ts`, so a second config file would never be typechecked. And the existing code is written in the callback style, reading `chrome.runtime.lastError` after every call, so a fake that only supports promises would make today's code hang and would report its own fault as the code's.

One scoping fact shaped the deliverable. `src/engine/` does not exist yet, so the engine, contract, merge and handler tests this feature nominally owns cannot be written today, and the three runtimes are still the old pipeline that slice 1 replaces. The engineer chose to narrow this feature to the harness and the guards, and to leave those tests to slice 1, which is what they are for.

## Options considered

### The runner

**Vitest 5.** The current major, reads the existing Vite config so the alias and TypeScript handling are inherited, mocking is first class, and both this project's Node (24.13) and Vite (8.0.10) clear its floors. One trap: Vite 8's full bundle mode breaks module mocking, so it must stay off.

**Vitest 4.1.** The release that added Vite 8 support, so it has the most field exposure to Vite 8 specifically, and one major behind on everything else.

**Jest.** Needs its own TypeScript transform plus a second React 19 and ESM setup, and reuses nothing from the Vite config. The most operational cost of the four for no gain here.

**Node's built in runner.** Zero dependencies, which is genuinely appealing, but it needs a TypeScript loader and quietly diverges from the Vite pipeline for CSS, assets and plugins, so a passing suite stops telling you the build is fine.

### The DOM environment

**jsdom, applied per file.** Pure tests run in plain Node and only the files that touch the DOM get jsdom, marked with a one line comment. Slower per environment, but it behaves like a browser where the code under test actually needs one.

**jsdom everywhere.** One config line, nothing to forget, and the pure engine tests pay for a DOM they never touch on every run.

**happy-dom.** Much faster and it ships its own types, but it has an open bug where a `MutationObserver` plus fake timers hangs indefinitely, and the content script's page URL watcher is a `MutationObserver`. That is a trap waiting for the first test that uses both.

### Faking the browser APIs

**Hand written fakes, each namespace typed against the browser's own definition.** The only option where behaviour is real: storage stores what you write, downloads report progress, a broadcast to nobody rejects, and a failed callback sets `lastError`. The typing means a namespace gaining a member fails the type check. It is more code to write and maintain than the alternatives.

**Auto stub every namespace with spies.** Almost no code, and it runs fast. But a test that reads back what it just wrote passes because the stub lies, which is the exact bug class this feature exists to catch.

**A community fake package.** The maintained one, `@webext-core/fake-browser`, fakes the `browser` and polyfill shape rather than the `chrome` global, so it cannot be used without the polyfill this project deliberately never loads. `vitest-chrome-mv3` generates mocks from the official docs and ships types, but has one release and under a hundred weekly downloads, so it is unproven. `vitest-chrome` and `vitest-webextension-mock` are dead ends with open questions about matching the real specification.

**A real browser.** The only true fake, via Playwright's documented support for loading an unpacked extension. Viable today, with known traps: the worker restarting after 30 seconds idle breaks in flight calls, and a Linux runner needs a headed browser under a virtual display. Deferred, for the reason in the Build plan.

### Enforcing engine purity

**A test that walks the syntax tree.** The only option that catches both halves of the rule, because a lint rule can restrict import paths but cannot see a direct API call, and it can distinguish value position from a type only reference. Needs no new dependency. It cannot run in the editor, so the feedback arrives at commit time rather than as you type.

**The built in lint rule on import paths.** Free, and it flags a bad import in the editor as you write it, which is the better moment to find out. It misses dynamic imports entirely, and it cannot see a direct API call, which is the half that actually rots.

**Both.** Two places to keep in step for one rule, and the lint rule still leaves the gap the test has to close.

### Whether the suite gates the build

**The build runs the suite.** The engineer chose this over the alternative, and it holds up better than it first looks: the quick inner loop is `npm run dev`, which does not build, so only deliberate rebuilds pay for the suite. The benefit is that nothing can be built with a red test, which matters for a project about to ship to a store.

**A separate `npm test`.** The smallest change that satisfies "one command runs the suite", and the build stays fast. Cost: a build can succeed with a broken test, and whoever wires up CI later has to remember to call both.

## Rationale

The runner choice turned on a fact rather than a preference. Vitest 4.1 is the release that added Vite 8 support, and Vitest 5 requires Vite 6.4 or newer, so this project's Vite 8.0.10 is comfortably inside it, and Node 24.13 clears the 22.12 floor. What decided it was reuse: the runner reads the Vite config, so the `@/` alias and TypeScript handling are inherited rather than duplicated, and the alternatives each need a second transform pipeline that will drift from the first one silently.

The fake strategy is the load bearing decision, and it came down to what a passing test is worth. Auto stubbing is faster to write and produces a green suite that means very little, because the stub returns nothing and a read after a write therefore "succeeds". The community packages were rejected on evidence rather than taste: the maintained one fakes the polyfill shape this project never uses, and the two that fake the `chrome` global are either unproven or abandoned.

The typing approach was corrected by the cross check and is worth stating because the obvious version does not work. The browser's `chrome` is a declared namespace carrying roughly forty sub namespaces, so a fake covering four of them can never satisfy `typeof chrome`, and assigning a value to `globalThis.chrome` is a type error. Typing each namespace fake against its own counterpart, `const storage: typeof chrome.storage = { ... }`, is where the drift detection actually lives: a member Chrome adds fails the type check in the fake, not in production. The composition into a `Pick` of the namespaces in use, installed through a single documented cast, is the smallest honest way to get a real global without loosening the types everywhere.

Purity enforcement went the engine's way rather than the linter's, against my recommendation, for a specific reason. A lint rule restricted to paths cannot see a direct browser API call, which is the violation that actually happens, because someone is in a hurry and reaches for `chrome.tabs` right there in a merge function. It also misses dynamic imports entirely. The syntax tree walk catches both, and it distinguishes value position from a type only reference, which a text scan cannot: spec 0001 explicitly permits type only imports of the browser types, and every engine module header names browser APIs in prose. The cost is that the feedback lands at commit time rather than in the editor.

Two scope calls came out of the same review and are the engineer's, recorded here honestly. The in memory state store and the per tab serialisation helper were dropped from this feature. Both exist for slice 1's tests, and shipping them now would mean shipping a hand written copy of a port interface that slice 1 immediately replaces with the real import, with nothing failing when the two drift; the serialisation helper is worse, because a copy of the worker's promise chain means the test exercises the copy while the real chain stays untested. The fake set was also cut from seven namespaces to the four the code touches today, because `webRequest`, `action` and `scripting` serve only the old pipeline that slice 1 deletes. Both calls move a small amount of work forward, and both keep this feature's deliverable honest about what it actually delivers.

## References

**Project sources** (verifiable, in this repo):
- `docs/specs/0001-detection-engine-architecture/`, the engine shape, the message contract, the state store, and the four pieces of work delegated to this feature
- `AGENTS.md` and `src/AGENTS.md`, the stack, the engine purity rule, and the two `any` payloads this harness exists to catch
- `src/background.ts` and `src/content.ts`, the source of the list of browser APIs the fakes must implement, and the reason the fakes speak the callback form
- `tsconfig.app.json`, `tsconfig.node.json`, `vite.config.ts` and `eslint.config.js`, the real configuration this spec has to fit inside
- Installed skill `chrome-extensions`, which governs the platform rules the fakes model

**Practices & standards**:
- Test doubles that behave, over mocks that return nothing, because a stub that lies makes a green suite worthless
- Ports and adapters, the same seam spec 0001 uses for the engine, applied to the browser APIs in tests
- A guard test that can pass because it found nothing is not a guard, hence the inspected count, the explicit empty report and the self tests
- Foundations before features, so the harness lands before the code it will test

**Links** (verified on 2026-09-30):
- Migrating to Vitest 5.0: https://vitest.dev/guide/migration
- Vitest 4.1 is out! (the release that added Vite 8 support): https://vitest.dev/blog/vitest-4-1.html
- Vite 8.0 is out!: https://vite.dev/blog/announcing-vite8
- Vitest does not work with Vite 8 in full bundled mode: https://github.com/vitest-dev/vitest/issues/9477
- Configuring Vitest: https://vitest.dev/config/
- Test Environment: https://vitest.dev/guide/environment
- happy-dom: MutationObserver broken with Vitest fake timers: https://github.com/capricorn86/happy-dom/issues/2097
- Chrome extensions (Playwright, for the deferred smoke test): https://playwright.dev/docs/chrome-extensions
- Playwright: the service worker event is never emitted on an MV3 worker restart: https://github.com/microsoft/playwright/issues/39475
