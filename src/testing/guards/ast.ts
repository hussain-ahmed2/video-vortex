// Shared plumbing for the two guards: finding the project root, walking a
// directory, and parsing a file with the TypeScript syntax tree.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'
import { isTestFile } from './test-file-pattern'

const SOURCE_EXTENSIONS = ['.ts', '.tsx']

/**
 * Extensions for a guard that reads files as plain text, such as the design token
 * guard scanning the stylesheet where the colour tokens live. Exported so the
 * guard names them rather than repeating the list, the way the test file pattern
 * is shared: a second copy is how two guards drift apart.
 */
export const STYLE_EXTENSIONS = ['.css']

/** Walks up from a directory to the one holding `package.json`. */
export function findProjectRoot(from: string): string {
  let current = resolve(from)
  while (true) {
    if (existsSync(join(current, 'package.json'))) return current
    const parent = dirname(current)
    if (parent === current) {
      throw new Error(`No package.json above ${from}, cannot resolve the project root`)
    }
    current = parent
  }
}

/**
 * Every source file under a directory, recursively.
 *
 * `extensions` is additive for a guard that reads files as text rather than as a
 * syntax tree, such as the design token guard scanning the stylesheet where the
 * colour tokens live. It is a parameter rather than a widened default because the
 * purity guard parses everything it collects, and handing it a stylesheet would
 * hand `ts.createSourceFile` a file it cannot parse.
 */
export function collectSourceFiles(dir: string, extensions: string[] = []): string[] {
  // A missing directory yields nothing rather than throwing, so a guard can
  // decide for itself whether "not there yet" is a failure. The purity guard
  // treats it as one; the co located guard does not.
  if (!existsSync(dir)) return []

  const wanted = [...SOURCE_EXTENSIONS, ...extensions]
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      found.push(...collectSourceFiles(full, extensions))
      continue
    }
    if (isTestFile(entry)) continue
    if (!wanted.some((ext) => entry.endsWith(ext))) continue
    if (entry.endsWith('.d.ts')) continue
    found.push(full)
  }
  return found.sort()
}

export function parseSourceFile(filePath: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true
  )
}

/** One based line number, so a report points at what a human sees. */
export function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
}

export function textOf(source: ts.SourceFile, node: ts.Node): string {
  return source.getFullText().split('\n')[lineOf(source, node) - 1]?.trim() ?? ''
}

/** True when a node sits inside a type annotation rather than running code. */
export function isInTypePosition(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent
  while (current) {
    if (ts.isTypeNode(current)) return true
    if (ts.isImportTypeNode(current)) return true
    current = current.parent
  }
  return false
}

/** A type only import declaration, which the guards treat as erased code. */
export function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  return node.importClause?.isTypeOnly === true
}

/**
 * A dynamic `import(...)`. TypeScript's public API has no `isImportExpression`:
 * a dynamic import is a call expression whose expression is the import keyword.
 */
export function isDynamicImport(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
  )
}

export function moduleSpecifierOf(
  node: ts.ImportDeclaration | ts.ExportDeclaration | ts.CallExpression
): ts.StringLiteralLike | undefined {
  if (ts.isCallExpression(node)) {
    return ts.isStringLiteralLike(node.arguments[0]) ? node.arguments[0] : undefined
  }
  const specifier = node.moduleSpecifier
  return specifier && ts.isStringLiteralLike(specifier) ? specifier : undefined
}
