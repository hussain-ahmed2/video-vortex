// The engine purity guard: every module under the engine must be pure.
//
// It reads the syntax tree rather than the text, which is what makes the rule
// precise. A text scan would fire on a module header that names a browser API in
// prose, and on the type only imports the engine is explicitly allowed to make,
// while missing a destructured call like `const { tabs } = chrome`. The tree also
// gives real line numbers.
//
// A missing directory throws on purpose: an empty result and a misconfigured path
// must not look the same, and the directory not existing yet is the one case
// where there is genuinely nothing to check.

import { existsSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import {
  collectSourceFiles,
  findProjectRoot,
  isDynamicImport,
  isInTypePosition,
  isTypeOnlyImport,
  lineOf,
  moduleSpecifierOf,
  parseSourceFile,
  textOf,
} from './ast'

export type PurityRule =
  | 'runtime-import'
  | 'testing-import'
  | 'outside-engine'
  | 'browser-api'

export interface PurityViolation {
  /** Path relative to the project root, so a report is stable across machines. */
  file: string
  line: number
  rule: PurityRule
  text: string
}

export interface PurityWalkResult {
  inspected: number
  violations: PurityViolation[]
}

/** The runtime files the engine must never reach into. From spec 0001. */
const RUNTIME_MODULES = ['background', 'content', 'App']

/** Mirrors the `@/` alias in vite.config.ts. Change both together. */
const ALIAS_PREFIX = '@/'

/** True when `target` is `parent` or sits inside it. */
function isInside(target: string, parent: string): boolean {
  const from = resolve(parent)
  const to = resolve(target)
  return to === from || to.startsWith(`${from}${sep}`)
}

function classifySpecifier(
  specifier: string,
  filePath: string,
  engineDir: string,
  srcDir: string
): PurityRule | undefined {
  let target: string

  if (specifier.startsWith('.')) {
    target = resolve(join(filePath, '..', specifier))
  } else if (specifier.startsWith(ALIAS_PREFIX)) {
    target = resolve(join(srcDir, specifier.slice(ALIAS_PREFIX.length)))
  } else {
    // A third party package. The engine is allowed to depend on libraries.
    return undefined
  }

  if (RUNTIME_MODULES.includes(relative(srcDir, target))) return 'runtime-import'
  if (isInside(target, join(srcDir, 'testing'))) return 'testing-import'
  // Importing from inside the engine itself is the one allowed case.
  if (isInside(target, engineDir)) return undefined
  return 'outside-engine'
}

/** True for `chrome` used as a value, not as a type and not as a property name. */
function isBrowserApiValueUse(node: ts.Identifier): boolean {
  if (node.text !== 'chrome' && node.text !== 'browser') return false
  if (isInTypePosition(node)) return false

  const parent = node.parent
  if (!parent) return false
  // The `chrome` in `foo.chrome` is a property name, not the global.
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false
  if (ts.isBindingElement(parent) && parent.name === node) return false
  if (ts.isVariableDeclaration(parent) && parent.name === node) return false
  if (ts.isParameter(parent) && parent.name === node) return false
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return false
  // `declare const chrome` is a declaration, not a use.
  if (
    ts.isVariableStatement(parent) &&
    parent.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)
  ) {
    return false
  }
  return true
}

export function collectPurityViolations(engineDir: string): PurityWalkResult {
  // A missing engine is a misconfigured path, not an empty result, and the two
  // must never look alike. See the header for why this guard differs from the
  // co located one here.
  if (!existsSync(engineDir)) {
    throw new Error(
      `Engine directory not found: ${engineDir}. The purity guard cannot tell a missing engine from a wrong path, so it refuses to report a clean run.`
    )
  }

  const projectRoot = findProjectRoot(engineDir)
  const srcDir = join(projectRoot, 'src')
  const files = collectSourceFiles(engineDir)
  const violations: PurityViolation[] = []

  for (const filePath of files) {
    const source = parseSourceFile(filePath)
    const report = fileRelativeTo(projectRoot, filePath)

    const checkSpecifier = (node: ts.Node): void => {
      const specifierNode = moduleSpecifierOf(
        node as ts.ImportDeclaration | ts.ExportDeclaration | ts.CallExpression
      )
      if (!specifierNode) return
      const rule = classifySpecifier(
        specifierNode.text,
        filePath,
        engineDir,
        srcDir
      )
      if (!rule) return
      violations.push({
        file: report,
        line: lineOf(source, node),
        rule,
        text: textOf(source, node),
      })
    }

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && !isTypeOnlyImport(node)) {
        checkSpecifier(node)
      } else if (ts.isExportDeclaration(node) || isDynamicImport(node)) {
        checkSpecifier(node)
      } else if (ts.isIdentifier(node) && isBrowserApiValueUse(node)) {
        violations.push({
          file: report,
          line: lineOf(source, node),
          rule: 'browser-api',
          text: textOf(source, node),
        })
      }
      ts.forEachChild(node, visit)
    }

    visit(source)
  }

  return { inspected: files.length, violations }
}

function fileRelativeTo(projectRoot: string, filePath: string): string {
  return relative(projectRoot, filePath).split('\\').join('/')
}
