import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectModulesMissingTests } from './co-located-tests'
import { collectPurityViolations } from './engine-purity'
import { isTestFile, TEST_FILE_PATTERN } from './test-file-pattern'

// The guards' own tests. A guard that cannot be shown to fail is not a guard, so
// every rule gets a fixture that trips it and a clean fixture that does not.
//
// Fixtures are written to a temporary directory at test time and never checked
// in. A checked in fixture under `src` would be typechecked by the build and
// collected by the runner as a real test.

const created: string[] = []

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'vortex-guard-'))
  created.push(root)
  for (const [relativePath, contents] of Object.entries(files)) {
    const full = join(root, relativePath)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, contents, 'utf8')
  }
  return root
}

/** The guards resolve the project root by walking up to `package.json`. */
function fixtureWithManifest(files: Record<string, string>): string {
  return fixture({ 'package.json': '{"name":"fixture"}\n', ...files })
}

afterEach(() => {
  while (created.length > 0) {
    rmSync(created.pop() as string, { recursive: true, force: true })
  }
})

describe('the test file pattern', () => {
  it('matches what the runner default include matches', () => {
    // The runner's default is `**/*.{test,spec}.?(c|m)[jt]s?(x)`. If the runner's
    // include is ever narrowed, this list is what has to change with it.
    for (const name of [
      'merge.test.ts',
      'merge.spec.ts',
      'merge.test.tsx',
      'merge.spec.tsx',
      'merge.test.js',
      'merge.test.mjs',
    ]) {
      expect(isTestFile(name)).toBe(true)
    }
    for (const name of ['merge.ts', 'merge.tsx', 'testing.ts', 'latest.ts']) {
      expect(isTestFile(name)).toBe(false)
    }
  })

  it('is anchored to the end of the name', () => {
    expect(TEST_FILE_PATTERN.test('a.test.ts.bak')).toBe(false)
  })
})

describe('the purity guard', () => {
  it('passes a clean engine that imports only from itself', () => {
    const dir = fixtureWithManifest({
      'src/engine/merge.ts': "import { identity } from './identity'\nexport const merge = identity\n",
      'src/engine/identity.ts': 'export const identity = (x: string) => x\n',
    })
    const result = collectPurityViolations(join(dir, 'src/engine'))
    expect(result.violations).toEqual([])
    expect(result.inspected).toBe(2)
  })

  it('flags an import of a runtime module, by relative path', () => {
    const dir = fixtureWithManifest({
      'src/engine/merge.ts': "import { helper } from '../background'\nexport const merge = helper\n",
    })
    const [violation] = collectPurityViolations(join(dir, 'src/engine')).violations
    expect(violation.rule).toBe('runtime-import')
    expect(violation.file).toBe('src/engine/merge.ts')
    expect(violation.line).toBe(1)
  })

  it('flags an import of a runtime module through the path alias', () => {
    const dir = fixtureWithManifest({
      'src/engine/merge.ts': "import { helper } from '@/content'\nexport const merge = helper\n",
    })
    const [violation] = collectPurityViolations(join(dir, 'src/engine')).violations
    expect(violation.rule).toBe('runtime-import')
  })

  it('flags an import of the test helpers', () => {
    const dir = fixtureWithManifest({
      'src/engine/merge.ts': "import { fake } from '@/testing'\nexport const merge = fake\n",
    })
    const [violation] = collectPurityViolations(join(dir, 'src/engine')).violations
    expect(violation.rule).toBe('testing-import')
  })

  it('flags an import that escapes the engine for anything else', () => {
    const dir = fixtureWithManifest({
      'src/engine/merge.ts': "import { cn } from '../lib/utils'\nexport const merge = cn\n",
    })
    const [violation] = collectPurityViolations(join(dir, 'src/engine')).violations
    expect(violation.rule).toBe('outside-engine')
  })

  it('flags a dynamic import too', () => {
    const dir = fixtureWithManifest({
      'src/engine/merge.ts':
        "export async function merge() {\n  return import('../background')\n}\n",
    })
    const [violation] = collectPurityViolations(join(dir, 'src/engine')).violations
    expect(violation.rule).toBe('runtime-import')
    expect(violation.line).toBe(2)
  })

  it('flags a browser API used in value position', () => {
    const dir = fixtureWithManifest({
      'src/engine/merge.ts': "export const tabs = chrome.tabs\n",
    })
    const [violation] = collectPurityViolations(join(dir, 'src/engine')).violations
    expect(violation.rule).toBe('browser-api')
    expect(violation.line).toBe(1)
  })

  it('flags a browser API that was destructured first', () => {
    // The case a text scan misses.
    const dir = fixtureWithManifest({
      'src/engine/merge.ts':
        'const { tabs } = chrome\nexport const query = () => tabs.query({})\n',
    })
    const [violation] = collectPurityViolations(join(dir, 'src/engine')).violations
    expect(violation.rule).toBe('browser-api')
    expect(violation.line).toBe(1)
  })

  it('does not flag a type only reference to a browser API', () => {
    // Spec 0001 allows type only imports of the browser types, and a type
    // annotation is not a use.
    const dir = fixtureWithManifest({
      'src/engine/types.ts':
        'export type Tab = chrome.tabs.Tab\nexport type Ext = typeof chrome.storage\n',
    })
    expect(collectPurityViolations(join(dir, 'src/engine')).violations).toEqual([])
  })

  it('does not flag a browser API named in prose', () => {
    const dir = fixtureWithManifest({
      'src/engine/merge.ts':
        '// Reads chrome.storage.session through the port, never directly.\nexport const merge = 1\n',
    })
    expect(collectPurityViolations(join(dir, 'src/engine')).violations).toEqual([])
  })

  it('does not flag the engine test files, which import the runner', () => {
    const dir = fixtureWithManifest({
      'src/engine/merge.ts': 'export const merge = 1\n',
      'src/engine/merge.test.ts': "import { expect } from 'vitest'\nimport { merge } from './merge'\n",
    })
    const result = collectPurityViolations(join(dir, 'src/engine'))
    expect(result.violations).toEqual([])
    expect(result.inspected).toBe(1)
  })

  it('allows a third party package', () => {
    const dir = fixtureWithManifest({
      'src/engine/messages.ts': "import { z } from 'zod'\nexport const schema = z.string()\n",
    })
    expect(collectPurityViolations(join(dir, 'src/engine')).violations).toEqual([])
  })

  it('recurses into subdirectories', () => {
    const dir = fixtureWithManifest({
      'src/engine/extractors/youtube.ts': "import { x } from '@/background'\nexport const y = x\n",
    })
    const [violation] = collectPurityViolations(join(dir, 'src/engine')).violations
    expect(violation.file).toBe('src/engine/extractors/youtube.ts')
  })

  it('flags a re export from a runtime module', () => {
    // The `export { x } from` form is a different node from an import, and it
    // reaches the runtime just as directly.
    const dir = fixtureWithManifest({
      'src/engine/merge.ts': "export { helper } from '../background'\n",
    })
    const [violation] = collectPurityViolations(join(dir, 'src/engine')).violations
    expect(violation.rule).toBe('runtime-import')
  })

  it('allows a star re export of a third party package', () => {
    const dir = fixtureWithManifest({
      'src/engine/messages.ts': "export * from 'zod'\n",
    })
    expect(collectPurityViolations(join(dir, 'src/engine')).violations).toEqual([])
  })

  it('flags a star re export from a runtime module', () => {
    // The star form carries no named specifiers, so it exercises a different
    // branch of the same check.
    const dir = fixtureWithManifest({
      'src/engine/merge.ts': "export * from '../background'\n",
    })
    const [violation] = collectPurityViolations(join(dir, 'src/engine')).violations
    expect(violation.rule).toBe('runtime-import')
  })

  it('allows an import of a sibling inside a subdirectory of the engine', () => {
    // The engine is allowed to be layered internally, so the inside check has to
    // hold for a nested path and not only for a sibling in the same folder.
    const dir = fixtureWithManifest({
      'src/engine/merge.ts':
        "import { youtube } from './extractors/youtube'\nexport const merged = youtube\n",
      'src/engine/extractors/youtube.ts': 'export const youtube = 1\n',
    })
    const result = collectPurityViolations(join(dir, 'src/engine'))
    expect(result.violations).toEqual([])
    expect(result.inspected).toBe(2)
  })

  it('flags the polyfill style browser namespace too', () => {
    // The guard checks `browser` as well as `chrome`, because the polyfill
    // exposes the same APIs under that name.
    const dir = fixtureWithManifest({
      'src/engine/merge.ts': 'export const storage = browser.storage\n',
    })
    const [violation] = collectPurityViolations(join(dir, 'src/engine')).violations
    expect(violation.rule).toBe('browser-api')
  })

  it('skips declaration files and non source files in the engine', () => {
    // A `.d.ts` cannot call anything, and a stray note is not code.
    const dir = fixtureWithManifest({
      'src/engine/types.d.ts': 'export declare const chrome: unknown\n',
      'src/engine/notes.md': 'chrome.tabs is forbidden\n',
      'src/engine/merge.ts': 'export const merge = 1\n',
    })
    const result = collectPurityViolations(join(dir, 'src/engine'))
    expect(result.violations).toEqual([])
    expect(result.inspected).toBe(1)
  })

  it('skips a .spec.ts file as well as a .test.ts file', () => {
    const dir = fixtureWithManifest({
      'src/engine/merge.ts': 'export const merge = 1\n',
      'src/engine/merge.spec.ts': "import { x } from '@/background'\n",
    })
    const result = collectPurityViolations(join(dir, 'src/engine'))
    expect(result.violations).toEqual([])
    expect(result.inspected).toBe(1)
  })

  it('reports how many files it inspected, so a clean run is distinguishable from no run', () => {
    const dir = fixtureWithManifest({ 'src/engine/merge.ts': 'export const merge = 1\n' })
    expect(collectPurityViolations(join(dir, 'src/engine')).inspected).toBe(1)
  })

  it('throws on a missing directory rather than reporting nothing', () => {
    const dir = fixtureWithManifest({})
    expect(() => collectPurityViolations(join(dir, 'src/engine'))).toThrow()
  })
})

describe('the co located test guard', () => {
  it('passes a module with a sibling test', () => {
    const dir = fixtureWithManifest({
      'src/engine/merge.ts': 'export const merge = 1\n',
      'src/engine/merge.test.ts': "import { expect } from 'vitest'\n",
    })
    const result = collectModulesMissingTests(join(dir, 'src/engine'))
    expect(result.untested).toEqual([])
    expect(result.inspected).toBe(1)
  })

  it('counts a .spec.ts sibling as a test too', () => {
    const dir = fixtureWithManifest({
      'src/engine/merge.ts': 'export const merge = 1\n',
      'src/engine/merge.spec.ts': "import { expect } from 'vitest'\n",
    })
    expect(collectModulesMissingTests(join(dir, 'src/engine')).untested).toEqual([])
  })

  it('reports a module with a value export and no test', () => {
    const dir = fixtureWithManifest({
      'src/engine/merge.ts': 'export const merge = 1\n',
    })
    const result = collectModulesMissingTests(join(dir, 'src/engine'))
    expect(result.untested).toEqual(['src/engine/merge.ts'])
  })

  it('exempts a module with no value exports', () => {
    const dir = fixtureWithManifest({
      'src/engine/types.ts':
        'export interface Entry { url: string }\nexport type Kind = string | number\n',
    })
    const result = collectModulesMissingTests(join(dir, 'src/engine'))
    expect(result.untested).toEqual([])
    expect(result.inspected).toBe(1)
  })

  it('exempts a module that re-exports only types', () => {
    const dir = fixtureWithManifest({
      'src/engine/types.ts': "export type { Entry } from './entry'\n",
    })
    expect(collectModulesMissingTests(join(dir, 'src/engine')).untested).toEqual([])
  })

  it('does not exempt a module that re-exports a value', () => {
    const dir = fixtureWithManifest({
      'src/engine/entry.ts': 'export const entry = 1\n',
      'src/engine/barrel.ts': "export { entry } from './entry'\n",
    })
    // Both are reported: the barrel re-exports a value, and the module it
    // re-exports from is a value exporting module with no test of its own.
    expect(collectModulesMissingTests(join(dir, 'src/engine')).untested).toEqual([
      'src/engine/barrel.ts',
      'src/engine/entry.ts',
    ])
  })

  it('recurses into subdirectories and looks for the sibling there', () => {
    const dir = fixtureWithManifest({
      'src/engine/extractors/youtube.ts': 'export const youtube = 1\n',
      'src/engine/extractors/youtube.test.ts': "import { expect } from 'vitest'\n",
    })
    expect(
      collectModulesMissingTests(join(dir, 'src/engine')).untested
    ).toEqual([])
  })

  it('reports empty for a directory with no modules, rather than passing silently', () => {
    const dir = fixtureWithManifest({})
    const result = collectModulesMissingTests(join(dir, 'src/engine'))
    expect(result).toEqual({ inspected: 0, untested: [] })
  })

  it('reports empty for a missing directory, because the engine may not exist yet', () => {
    const dir = fixtureWithManifest({})
    expect(collectModulesMissingTests(join(dir, 'src/engine'))).toEqual({
      inspected: 0,
      untested: [],
    })
  })

  it('reports a class with a value export and no test', () => {
    const dir = fixtureWithManifest({
      'src/engine/registry.ts': 'export class Registry {}\n',
    })
    expect(collectModulesMissingTests(join(dir, 'src/engine')).untested).toEqual([
      'src/engine/registry.ts',
    ])
  })

  it('reports a function with a value export and no test', () => {
    const dir = fixtureWithManifest({
      'src/engine/identity.ts': 'export function identity(x: string) {\n  return x\n}\n',
    })
    expect(collectModulesMissingTests(join(dir, 'src/engine')).untested).toEqual([
      'src/engine/identity.ts',
    ])
  })

  it('reports a star re export, which carries values', () => {
    const dir = fixtureWithManifest({
      'src/engine/entry.ts': 'export const entry = 1\n',
      'src/engine/barrel.ts': "export * from './entry'\n",
    })
    expect(collectModulesMissingTests(join(dir, 'src/engine')).untested).toContain(
      'src/engine/barrel.ts'
    )
  })

  it('reports a default export with no test', () => {
    // `export default` is a different node again, and it is still a value that
    // can be exercised.
    const dir = fixtureWithManifest({
      'src/engine/filename.ts': "const name = 'x'\nexport default name\n",
    })
    expect(collectModulesMissingTests(join(dir, 'src/engine')).untested).toEqual([
      'src/engine/filename.ts',
    ])
  })

  it('accepts a .tsx sibling as the module test', () => {
    const dir = fixtureWithManifest({
      'src/engine/merge.ts': 'export const merge = 1\n',
      'src/engine/merge.test.tsx': "import { expect } from 'vitest'\n",
    })
    expect(collectModulesMissingTests(join(dir, 'src/engine')).untested).toEqual([])
  })

  it('does not accept a test in a subdirectory as a sibling', () => {
    // "Beside it" is the rule, so a test filed elsewhere does not satisfy it and
    // the module is still reported.
    const dir = fixtureWithManifest({
      'src/engine/merge.ts': 'export const merge = 1\n',
      'src/engine/__tests__/merge.test.ts': "import { expect } from 'vitest'\n",
    })
    expect(collectModulesMissingTests(join(dir, 'src/engine')).untested).toContain(
      'src/engine/merge.ts'
    )
  })
})
