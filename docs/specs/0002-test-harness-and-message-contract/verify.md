# Verify: test harness and message contract · spec 0002 · updated 2026-09-30

_Steps derived from spec 0002 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

## Commands

- [x] `npm test` → exits 0, all test files pass, under 10 seconds → AC-1, AC-7
- [x] Temporarily break one assertion in any test file, then `npm test` → exits non zero and names the file → AC-1
- [x] `npx vitest run src/lib` → both real pure module suites pass, with no browser and no `chrome` global defined → AC-2
- [x] `npx vitest run src/testing/chrome` → the fake suites pass, covering the storage round trip by reference, the callback form, `lastError` on the failure path, a rejecting broadcast and a driven download → AC-3
- [x] `npx vitest run src/testing/guards` → every guard test passes, including one fixture per rule that must fail the guard → AC-4, AC-5, AC-6
- [x] `npm run build` → `tsc -b`, then the suite, then `vite build`, all green, and `dist/background.js` plus `dist/content.js` land flat → AC-8
- [x] Temporarily add a type error inside a test file, then `npx tsc -b` → fails, proving the existing type check covers the tests → AC-8
- [x] `node -e "const p=require('./package.json');console.log(Object.keys({...p.dependencies,...p.devDependencies}).filter(n=>/playwright|puppeteer|cypress|selenium|webdriverio/.test(n)))"` → prints an empty list → AC-9
- [x] `grep -rlE "installFakeChrome|Cceiving end does not exist" dist/` → no matches, so no fake code ships → AC-9
- [x] `npm run lint` → the same 12 pre-existing errors as before this feature, and none in `src/testing` or the new test files → AC-1 (hygiene, not an acceptance criterion)

## Manual

- [x] Read `src/testing/guards/engine-purity.ts` and confirm it walks the TypeScript syntax tree rather than the text, and that it skips type only references, comments and the engine's own test files → AC-4
- [x] Add a scratch engine module under `src/engine` that calls `chrome.tabs`, then run the purity guard: it must report that file, line and rule, and the suite must go red → AC-4
- [x] Add a scratch engine module with a value export and no test file, then run the co located guard: it must be reported as untested, while a type only module beside it is exempt → AC-5
- [x] Delete `src/engine` entirely (or point the guards at a path that does not exist): the purity guard must throw, the co located guard must report empty, and the two must never look alike → AC-4, AC-5
- [x] Confirm `engines.node` in `package.json` is satisfied by this machine's Node, and that it is at least as strict as the runner's and the DOM shim's own floors → AC-9

## Acceptance criteria coverage

- AC-1 → `npm test` green, and non zero on a broken assertion
- AC-2 → `npx vitest run src/lib`
- AC-3 → `npx vitest run src/testing/chrome`
- AC-4 → purity guard suite, plus the scratch module that must be reported
- AC-5 → co located guard suite, plus the scratch module and the missing directory case
- AC-6 → each guard has a failing fixture and a clean fixture in the same run
- AC-7 → the `npm test` duration, and no environment marker on the pure test files
- AC-8 → `npm run build` green, and `npx tsc -b` catching a type error in a test file
- AC-9 → the dependency check, the `dist` leak check, and the `engines` check
