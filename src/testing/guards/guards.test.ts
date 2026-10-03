import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findProjectRoot } from './ast'
import { collectModulesMissingTests } from './co-located-tests'
import {
  collectDesignTokenViolations,
  DEFAULT_PALETTE_FAMILIES,
} from './design-tokens'
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

  // The assertions that make the guard mean anything. The fixture cases prove the rules
  // fire; these two make a browser call in the real engine a red build, which is the
  // whole reason the engine is a directory rather than a convention.
  // covers: AC-7
  describe('the real engine', () => {
    const engineDir = join(findProjectRoot(process.cwd()), 'src', 'engine')

    it('has modules to check, so this cannot pass by finding nothing', () => {
      expect(collectPurityViolations(engineDir).inspected).toBeGreaterThan(0)
    })

    it('calls no browser API and imports no runtime module', () => {
      const result = collectPurityViolations(engineDir)
      const report = result.violations.map(
        (violation) => `${violation.file}:${violation.line} ${violation.rule} ${violation.text}`
      )

      expect(report).toEqual([])
    })
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

  // The same reasoning as the real engine purity check above: the fixture cases prove
  // the rules fire, and this makes a new engine module shipped without a test a red
  // build rather than something a reviewer has to notice.
  it('finds no untested module in the real engine', () => {
    const engineDir = join(findProjectRoot(process.cwd()), 'src', 'engine')
    const result = collectModulesMissingTests(engineDir)

    expect(result.inspected).toBeGreaterThan(0)
    expect(result.untested).toEqual([])
  })
})

describe('the design token guard', () => {
  function scan(files: Record<string, string>) {
    const dir = fixtureWithManifest(files)
    return collectDesignTokenViolations(join(dir, 'src'))
  }

  function classesIn(files: Record<string, string>) {
    return scan(files).violations.map((v) => `${v.rule}:${v.text}`)
  }

  it('flags a default palette step', () => {
    expect(classesIn({ 'src/a.tsx': 'const c = "bg-slate-950"\n' })).toEqual([
      'palette-step:bg-slate-950',
    ])
  })

  it('sees through a variant prefix and an opacity suffix', () => {
    expect(classesIn({ 'src/a.tsx': 'const c = "hover:border-purple-500/20"\n' })).toEqual([
      'palette-step:border-purple-500/20',
    ])
  })

  it('sees through a border side segment', () => {
    expect(classesIn({ 'src/a.tsx': 'const c = "border-t-slate-800"\n' })).toEqual([
      'palette-step:border-t-slate-800',
    ])
  })

  it('flags a gradient colour stop', () => {
    expect(classesIn({ 'src/a.tsx': 'const c = "from-purple-400 to-blue-400"\n' })).toEqual([
      'palette-step:from-purple-400',
      'palette-step:to-blue-400',
    ])
  })

  it('flags white and black used as colours', () => {
    expect(classesIn({ 'src/a.tsx': 'const c = "bg-white text-black"\n' })).toEqual([
      'raw-colour-name:bg-white',
      'raw-colour-name:text-black',
    ])
  })

  it('flags text-transparent, which hides text once its stops stop compiling', () => {
    expect(classesIn({ 'src/a.tsx': 'const c = "bg-clip-text text-transparent"\n' })).toEqual([
      'transparent-text:text-transparent',
    ])
  })

  it('allows transparent where it means no colour', () => {
    expect(
      classesIn({ 'src/a.tsx': 'const c = "to-transparent bg-transparent"\n' })
    ).toEqual([])
  })

  it('flags an arbitrary value carrying a colour function', () => {
    expect(
      classesIn({ 'src/a.tsx': 'const c = "shadow-[0_0_15px_rgba(168,85,247,0.2)]"\n' })
    ).toEqual(['arbitrary-colour:shadow-[0_0_15px_rgba(168,85,247,0.2)]'])
  })

  it('flags an arbitrary hex', () => {
    expect(classesIn({ 'src/a.tsx': 'const c = "bg-[#7c3aed]"\n' })).toEqual([
      'arbitrary-colour:bg-[#7c3aed]',
    ])
  })

  it('reads past a nested bracket without mistaking it for the whole value', () => {
    expect(
      classesIn({ 'src/a.tsx': 'const c = "[&_svg:not([x])]:bg-[oklch(0.5_0_0)]"\n' })
    ).toEqual(['arbitrary-colour:bg-[oklch(0.5_0_0)]'])
  })

  it('ignores arbitrary values that carry no colour', () => {
    expect(
      classesIn({
        'src/a.tsx':
          'const c = "text-[9px] w-[420px] rounded-[min(var(--radius-md),10px)] ' +
          'grid-cols-[1fr_auto] [&_svg:not([class*=\'size-\'])]:size-4"\n',
      })
    ).toEqual([])
  })

  it('does not mistake a font size for a colour', () => {
    expect(classesIn({ 'src/a.tsx': 'const c = "text-sm text-[10px] font-black"\n' })).toEqual([])
  })

  it('accepts the token utilities, including opacity variants', () => {
    expect(
      classesIn({
        'src/a.tsx':
          'const c = "bg-background text-foreground bg-card text-subtle-foreground ' +
          'border-border ring-ring/50 bg-input/30 fill-muted-foreground/20"\n',
      })
    ).toEqual([])
  })

  it('reads class names out of a template literal too', () => {
    expect(classesIn({ 'src/a.tsx': 'const c = `bg-slate-900 ${x}`\n' })).toEqual([
      'palette-step:bg-slate-900',
    ])
  })

  it('reports the line the class sits on', () => {
    const [violation] = scan({
      'src/a.tsx': 'const one = 1\nconst c = "bg-red-500"\n',
    }).violations
    expect(violation.line).toBe(2)
    expect(violation.file).toBe('src/a.tsx')
  })

  it('flags a colour literal in a stylesheet rule', () => {
    expect(
      classesIn({ 'src/a.css': '.brand { background: #a855f7; }\n' })
    ).toEqual(['css-literal:.brand { background: #a855f7; }'])
  })

  it('allows a colour as a token declaration', () => {
    expect(
      classesIn({ 'src/a.css': ':root {\n  --brand: oklch(0.6 0.2 300);\n}\n' })
    ).toEqual([])
  })

  it('flags a colour declared straight into the reset colour namespace', () => {
    expect(
      classesIn({ 'src/a.css': '@theme {\n  --color-brand: #a855f7;\n}\n' })
    ).toEqual(['css-literal:--color-brand: #a855f7;'])
  })

  it('leaves test files alone, which is where literal colours are allowed', () => {
    expect(classesIn({ 'src/a.test.ts': 'const c = "bg-slate-950"\n' })).toEqual([])
  })

  it('refuses to report a clean run when the source tree is missing', () => {
    const dir = fixtureWithManifest({ 'package.json': '{"name":"fixture"}\n' })
    expect(() => collectDesignTokenViolations(join(dir, 'src'))).toThrow()
  })

  it('keeps its palette list in step with the installed Tailwind', () => {
    const theme = readFileSync(
      join(findProjectRoot(process.cwd()), 'node_modules/tailwindcss/theme.css'),
      'utf8'
    )
    const families = new Set(
      [...theme.matchAll(/--color-([a-z]+)-\d+/g)].map((match) => match[1])
    )
    expect([...families].sort()).toEqual([...DEFAULT_PALETTE_FAMILIES].sort())
  })

  // A keyword is the third way a colour fits inside an arbitrary value, after a hex
  // and a colour function, and it is the shortest of the three to type. It used to
  // pass unnoticed, because the guard matched the two shapes the spec illustrated
  // and `text-[crimson]` is neither of them.
  it('flags a named colour inside an arbitrary value', () => {
    expect(classesIn({ 'src/a.tsx': 'const c = "bg-[red] text-[tomato]"\n' })).toEqual([
      'arbitrary-colour:bg-[red]',
      'arbitrary-colour:text-[tomato]',
    ])
  })

  it('sees through the color() form and a keyword buried in a shorthand', () => {
    expect(
      classesIn({ 'src/a.tsx': 'const c = "bg-[color:red] shadow-[inset_0_0_0_1px_red]"\n' })
    ).toEqual([
      'arbitrary-colour:bg-[color:red]',
      'arbitrary-colour:shadow-[inset_0_0_0_1px_red]',
    ])
  })

  it('leaves a colour word that is only part of a larger token alone', () => {
    expect(
      classesIn({ 'src/a.tsx': 'const c = "bg-[url(red.png)] bg-[var(--red)] text-[9px]"\n' })
    ).toEqual([])
  })

  it('flags a colour in a style attribute, which no class name rule can reach', () => {
    expect(classesIn({ 'src/a.tsx': 'const c = <div style={{ color: "#7c3aed" }} />\n' })).toEqual([
      'inline-colour:color: #7c3aed',
    ])
  })

  it('reads a style property spelled either way, and a keyword value', () => {
    expect(
      classesIn({
        'src/a.tsx':
          'const c = <div style={{ backgroundColor: "crimson", "border-color": "blue" }} />\n',
      })
    ).toEqual(['inline-colour:backgroundColor: crimson', 'inline-colour:borderColor: blue'])
  })

  it('allows a var() reference in a style attribute, which is the supported path', () => {
    expect(
      classesIn({ 'src/a.tsx': 'const c = <div style={{ color: "var(--foreground)" }} />\n' })
    ).toEqual([])
  })

  // A service worker has no stylesheet, so a token could never have reached this
  // call. Firing on it would train people to ignore the guard.
  it('leaves a colour in a Chrome API options bag alone', () => {
    expect(classesIn({ 'src/a.ts': 'const o = { color: "#a855f7" }\n' })).toEqual([])
  })

  // The assertion that makes the guard mean anything. The fixture cases prove the
  // rules fire, but only this one makes a raw colour in this codebase a red build.
  it('finds no raw colour in the real source tree', () => {
    const srcDir = join(findProjectRoot(process.cwd()), 'src')
    const result = collectDesignTokenViolations(srcDir)
    expect(result.inspected).toBeGreaterThan(0)
    expect(result.violations).toEqual([])
  })
})
