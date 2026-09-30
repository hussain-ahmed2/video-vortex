// The co located test guard: every engine module that exports something at run
// time needs a test file beside it.
//
// A module with no value exports is exempt, because a file holding only types or
// interfaces has nothing to exercise. That is decided from the syntax tree rather
// than a list of names, so a new pure type module is exempt automatically.
//
// Unlike the purity guard, a missing directory reports empty rather than
// throwing: the engine legitimately does not exist yet, and only the purity guard
// needs to protect against being pointed at the wrong path.

import { existsSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import ts from 'typescript'
import { collectSourceFiles, findProjectRoot, parseSourceFile } from './ast'

export interface CoLocatedWalkResult {
  inspected: number
  untested: string[]
}

/** True when the file exports at least one value, not only types. */
export function hasValueExport(source: ts.SourceFile): boolean {
  let found = false

  const visit = (node: ts.Node): void => {
    if (found) return
    const modifiers = ts.canHaveModifiers(node) ? node.modifiers : undefined
    const isExported = modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
    )

    if (isExported) {
      // An interface, a type alias, or a `declare`d signature is erased, so there
      // is nothing in it to run.
      if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return
      if (modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) return
      found = true
      return
    }

    if (ts.isExportDeclaration(node)) {
      // `export type { X }` is erased; `export { x }` and `export * from` are not.
      if (node.isTypeOnly) return
      const clause = node.exportClause
      const specifiers = clause && ts.isNamedExports(clause) ? clause.elements : []
      if (specifiers.length === 0 || specifiers.some((spec) => !spec.isTypeOnly)) {
        found = true
      }
      return
    }

    // `export default x` is a third shape entirely: neither an export modifier
    // nor an export declaration, so without this case it is never seen.
    if (ts.isExportAssignment(node)) {
      found = true
      return
    }

    ts.forEachChild(node, visit)
  }

  visit(source)
  return found
}

export function collectModulesMissingTests(engineDir: string): CoLocatedWalkResult {
  const projectRoot = findProjectRoot(engineDir)
  const modules = collectSourceFiles(engineDir)
  const untested: string[] = []

  for (const filePath of modules) {
    if (!hasValueExport(parseSourceFile(filePath))) continue
    if (hasSiblingTest(filePath)) continue
    untested.push(relative(projectRoot, filePath).split('\\').join('/'))
  }

  return { inspected: modules.length, untested }
}

const TEST_SUFFIXES = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx']

/** A sibling in the same directory whose name matches the runner's test pattern. */
export function hasSiblingTest(filePath: string): boolean {
  const stem = basename(filePath).replace(/\.[^.]+$/, '')
  const dir = dirname(filePath)
  return TEST_SUFFIXES.some((suffix) => existsSync(join(dir, `${stem}${suffix}`)))
}
