import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import ts from 'typescript'
import {
  collectSourceFiles,
  findProjectRoot,
  isDynamicImport,
  isInTypePosition,
  isTypeOnlyImport,
  lineOf,
  moduleSpecifierOf,

  textOf,
} from './ast'

// The plumbing both guards stand on. It is exercised directly here because a
// silent mistake in it would make both guards agree on the wrong answer, which
// is the one failure mode two guards cannot catch between them.

const created: string[] = []

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'vortex-ast-'))
  created.push(root)
  for (const [relativePath, contents] of Object.entries(files)) {
    const full = join(root, relativePath)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, contents, 'utf8')
  }
  return root
}

/** Finds the first node of the requested kind in an already parsed file. */
function firstNode<T extends ts.Node>(
  file: ts.SourceFile,
  pick: (node: ts.Node) => node is T
): { file: ts.SourceFile; node: T } {
  let found: T | undefined
  const visit = (node: ts.Node): void => {
    if (found) return
    if (pick(node)) {
      found = node
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  if (!found) throw new Error('no matching node in the fixture')
  return { file, node: found }
}

function withSource(source: string): ts.SourceFile {
  return ts.createSourceFile(
    join(tmpdir(), 'probe.ts'),
    source,
    ts.ScriptTarget.Latest,
    true
  )
}

afterEach(() => {
  while (created.length > 0) {
    rmSync(created.pop() as string, { recursive: true, force: true })
  }
})

describe('findProjectRoot', () => {
  it('walks up to the directory holding package.json', () => {
    const root = fixture({ 'package.json': '{}\n', 'a/b/c/keep.txt': '' })

    expect(findProjectRoot(join(root, 'a/b/c'))).toBe(root)
  })

  it('throws when there is no package.json above the directory', () => {
    // The temp root has no manifest above it, which is the misconfiguration case.
    const orphan = fixture({ 'keep.txt': '' })

    expect(() => findProjectRoot(orphan)).toThrow(/package\.json/)
  })
})

describe('collectSourceFiles', () => {
  it('returns only non test TypeScript sources, recursively', () => {
    const root = fixture({
      'package.json': '{}\n',
      'a.ts': '',
      'b.tsx': '',
      'a.test.ts': '',
      'a.spec.ts': '',
      'types.d.ts': '',
      'notes.md': '',
      'data.json': '{}',
      'nested/deep/c.ts': '',
    })

    const found = collectSourceFiles(join(root, 'nested')).map((p) => p.split(/[\\/]/).pop())

    expect(found).toEqual(['c.ts'])
  })

  it('returns nothing for a directory that does not exist', () => {
    // This is what lets the co located guard report empty while the purity guard
    // throws: the difference between the two lives one level up.
    expect(collectSourceFiles(join(tmpdir(), 'definitely-not-here-12345'))).toEqual([])
  })
})

describe('lineOf and textOf', () => {
  it('reports a one based line and the trimmed text of that line', () => {
    const file = withSource('const a = 1\nconst b = 2\nconst c = 3\n')
    const { node } = firstNode(file, (n): n is ts.Identifier => ts.isIdentifier(n) && n.text === 'c')

    expect(lineOf(file, node)).toBe(3)
    expect(textOf(file, node)).toBe('const c = 3')
  })
})

describe('isInTypePosition', () => {
  it('is true inside a type annotation', () => {
    const file = withSource('export type Tab = chrome.tabs.Tab\n')
    const { node } = firstNode(
      file,
      (n): n is ts.Identifier => ts.isIdentifier(n) && n.text === 'chrome'
    )

    expect(isInTypePosition(node)).toBe(true)
  })

  it('is false for a real use', () => {
    const file = withSource('export const tabs = chrome.tabs\n')
    const { node } = firstNode(
      file,
      (n): n is ts.Identifier => ts.isIdentifier(n) && n.text === 'chrome'
    )

    expect(isInTypePosition(node)).toBe(false)
  })
})

describe('isTypeOnlyImport', () => {
  it('is true for `import type`', () => {
    const file = withSource("import type { X } from './x'\n")
    const { node } = firstNode(file, ts.isImportDeclaration)

    expect(isTypeOnlyImport(node)).toBe(true)
  })

  it('is false for a value import', () => {
    const file = withSource("import { x } from './x'\n")
    const { node } = firstNode(file, ts.isImportDeclaration)

    expect(isTypeOnlyImport(node)).toBe(false)
  })

  it('is false for a side effect only import', () => {
    const file = withSource("import './x'\n")
    const { node } = firstNode(file, ts.isImportDeclaration)

    expect(isTypeOnlyImport(node)).toBe(false)
  })
})

describe('isDynamicImport', () => {
  it('recognises a dynamic import of a string literal', () => {
    const file = withSource("export const load = () => import('./x')\n")
    const { node } = firstNode(file, ts.isCallExpression)

    expect(isDynamicImport(node)).toBe(true)
  })

  it('does not mistake an ordinary call for a dynamic import', () => {
    const file = withSource("export const load = () => fetch('./x')\n")
    const { node } = firstNode(file, ts.isCallExpression)

    expect(isDynamicImport(node)).toBe(false)
  })
})

describe('moduleSpecifierOf', () => {
  it('reads the specifier of a static import', () => {
    const file = withSource("import { x } from './x'\n")
    const { node } = firstNode(file, ts.isImportDeclaration)

    expect(moduleSpecifierOf(node)?.text).toBe('./x')
  })

  it('reads the specifier of a re export', () => {
    const file = withSource("export { x } from './x'\n")
    const { node } = firstNode(file, ts.isExportDeclaration)

    expect(moduleSpecifierOf(node)?.text).toBe('./x')
  })

  it('returns nothing for an export with no module specifier', () => {
    const file = withSource('const x = 1\nexport { x }\n')
    const { node } = firstNode(file, ts.isExportDeclaration)

    expect(moduleSpecifierOf(node)).toBeUndefined()
  })

  it('returns nothing for a dynamic import of a computed value', () => {
    // A blind spot worth pinning: the guard cannot resolve a variable, so it
    // stays quiet rather than guessing.
    const file = withSource('export const load = (p: string) => import(p)\n')
    const { node } = firstNode(file, ts.isCallExpression)

    expect(moduleSpecifierOf(node)).toBeUndefined()
  })
})
