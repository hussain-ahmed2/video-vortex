// The design token guard: every colour a component can render must resolve to a
// named token. From spec 0003.
//
// This is the second line of defence, not the first. The `--color-*: initial`
// reset in src/index.css already deletes every default colour utility from the
// build, so a raw palette value cannot be typed into a class and still work. That
// reset is silent: an unknown utility is not an error in Tailwind v4, so a
// reintroduced colour builds cleanly and then does nothing at run time. A silent
// failure inside a design token system is the exact failure this standard exists
// to prevent, so this guard makes the mistake loud and names the file.
//
// It reads class names out of string and template literals rather than scanning
// whole lines, because a line of markup carries many classes and a rule that
// fires on the whole line would report the innocent ones alongside the guilty.

import { existsSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'
import {
  collectSourceFiles,
  findProjectRoot,
  lineOf,
  parseSourceFile,
  STYLE_EXTENSIONS,
} from './ast'

export type DesignTokenRule =
  | 'palette-step'
  | 'raw-colour-name'
  | 'transparent-text'
  | 'arbitrary-colour'
  | 'inline-colour'
  | 'css-literal'

export interface DesignTokenViolation {
  /** Path relative to the project root, so a report is stable across machines. */
  file: string
  line: number
  rule: DesignTokenRule
  /** The offending class or declaration, not the whole line it sits on. */
  text: string
}

export interface DesignTokenWalkResult {
  inspected: number
  violations: DesignTokenViolation[]
}

/**
 * Tailwind's default palette families, mirrored from
 * `node_modules/tailwindcss/theme.css`. A self test reads that file and fails if
 * the two drift, so a new Tailwind release adding a family cannot quietly open a
 * hole here.
 */
export const DEFAULT_PALETTE_FAMILIES = [
  'amber',
  'blue',
  'cyan',
  'emerald',
  'fuchsia',
  'gray',
  'green',
  'indigo',
  'lime',
  'mauve',
  'mist',
  'neutral',
  'olive',
  'orange',
  'pink',
  'purple',
  'red',
  'rose',
  'sky',
  'slate',
  'stone',
  'taupe',
  'teal',
  'violet',
  'yellow',
  'zinc',
]

/** The utility prefixes that take a colour in Tailwind v4. */
const COLOUR_PREFIXES = [
  'accent',
  'bg',
  'border',
  'caret',
  'decoration',
  'divide',
  'fill',
  'from',
  'outline',
  'placeholder',
  'ring',
  'shadow',
  'stroke',
  'text',
  'to',
  'via',
]

/** A side or corner segment a border or outline utility may carry. */
const SIDE_SEGMENT = /^(?:[xytrblse])-/

/**
 * Colour functions and hex literals, for the arbitrary value rule.
 *
 * The lookbehind excludes a preceding letter, digit or hyphen but deliberately
 * allows an underscore, because Tailwind's arbitrary value encoding replaces
 * spaces with underscores: `shadow-[0_0_15px_rgba(...)]` puts the function name
 * straight after one. A plain `\b` would not match there, because an underscore
 * is a word character and so no boundary exists between it and the name.
 */
const COLOUR_LITERAL =
  /#[0-9a-fA-F]{3,8}\b|(?<![a-zA-Z0-9-])(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color-mix|light-dark|color)\s*\(/

/** The `white` and `black` keyword utilities. */
const RAW_COLOUR_NAMES = new Set(['white', 'black'])

/**
 * The CSS named colours, which are the third way a colour can be typed into an
 * arbitrary value and the easiest of the three to type. The two shapes the guard
 * already caught were a hex literal and a colour function, because those are the
 * two examples the spec gave. A keyword matched neither, so `text-[crimson]`
 * passed the guard and then shipped as `#dc143c` with the suite green, which is
 * the exact silent failure this file exists to make loud.
 *
 * The system keywords are deliberately absent. `transparent` and `currentColor`
 * mean "no colour of my own", so `bg-[transparent]` is a legitimate way to write
 * no fill. `text-transparent` is still caught, by the rule above it, because on
 * text that choice hides the text rather than the background.
 */
const NAMED_COLOURS = new Set(
  `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue
   blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue
   cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey
   darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon
   darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet
   deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen
   fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew
   hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon
   lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey
   lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey
   lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine
   mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue
   mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose
   moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid
   palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink
   plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon
   sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey
   snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white
   whitesmoke yellow yellowgreen`.split(/\s+/)
)

/**
 * True when an arbitrary value contains a bare CSS colour keyword.
 *
 * The value is split on the underscore Tailwind uses to encode a space, and each
 * fragment is compared whole rather than by substring, so `url(red.png)` and
 * `var(--red)` are left alone. A `color:` style function is unwrapped first,
 * because `bg-[color:red]` is a colour in exactly the same way `bg-[red]` is.
 */
function hasNamedColour(value: string): boolean {
  return value
    .split(/[\s_]+/)
    .some((fragment) => NAMED_COLOURS.has(fragment.split(':').pop()?.toLowerCase() ?? ''))
}

/**
 * The style properties that take a colour, so a literal in a style object is
 * caught too. A style object escapes the class name rules entirely, because
 * `{ color: '#7c3aed' }` has no utility prefix for `colourValue` to read and no
 * brackets for the arbitrary value rule to open.
 */
const STYLE_COLOUR_PROPERTIES = new Set([
  'accentColor',
  'background',
  'backgroundColor',
  'border',
  'borderBlockColor',
  'borderBottomColor',
  'borderColor',
  'borderInlineColor',
  'borderLeftColor',
  'borderRightColor',
  'borderTopColor',
  'boxShadow',
  'caretColor',
  'color',
  'columnRuleColor',
  'fill',
  'outline',
  'outlineColor',
  'stroke',
  'textDecorationColor',
  'textShadow',
])

const PALETTE_STEP = new RegExp(`^(?:${DEFAULT_PALETTE_FAMILIES.join('|')})-\\d+$`)

/**
 * Splits a class attribute into candidate class names.
 *
 * Variants are split off first, so `hover:border-purple-500/20` is checked as
 * `border-purple-500/20` and the `hover:` does not hide the prefix.
 */
function classCandidates(source: string): string[] {
  return source
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map(stripVariant)
}

/**
 * The class with its variant prefixes removed.
 *
 * Only a colon outside every `[...]` counts, so `dark:bg-[color:red]` keeps the
 * `color:` that belongs to the arbitrary value. Taking the last colon blindly
 * turned that class into `red]`, which no rule could read.
 */
function stripVariant(token: string): string {
  let depth = 0
  for (let index = token.length - 1; index >= 0; index -= 1) {
    const char = token[index]
    if (char === ']') depth += 1
    else if (char === '[') depth -= 1
    else if (char === ':' && depth === 0) return token.slice(index + 1)
  }
  return token
}

/** Strips an opacity suffix, so `bg-slate-950/80` is read as `bg-slate-950`. */
function withoutOpacity(value: string): string {
  const slash = value.lastIndexOf('/')
  return slash === -1 ? value : value.slice(0, slash)
}

/**
 * The name of an object literal property, normalised to camel case, or undefined
 * when it is computed or a pattern. A style object may spell a property either
 * way, so `border-color` and `borderColor` have to reach the same set entry.
 */
function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase())
  }
  return undefined
}

/**
 * True when an object literal is the value of a JSX `style` attribute.
 *
 * The property name alone is not enough to identify one. `chrome.action
 * .setBadgeBackgroundColor({ color: '#a855f7' })` names a colour too, and it is
 * not a design token violation, because a service worker has no stylesheet for a
 * token to live in and `var()` was never an option for it. Scoping the rule to a
 * real style attribute keeps the API out of a rule written about CSS.
 */
function isStyleAttribute(node: ts.ObjectLiteralExpression): boolean {
  const expression = node.parent
  if (!expression || !ts.isJsxExpression(expression)) return false
  const attribute = expression.parent
  if (!attribute || !ts.isJsxAttribute(attribute)) return false
  const name = attribute.name
  return ts.isIdentifier(name) ? name.text === 'style' : name.getText() === 'style'
}

/**
 * The colour carrying part of a class, or undefined when the class is not a
 * colour utility. `text-sm` returns undefined because `sm` is a font size, which
 * is why this cannot simply allowlist the token names and reject the rest.
 */
function colourValue(className: string): string | undefined {
  for (const prefix of COLOUR_PREFIXES) {
    if (!className.startsWith(`${prefix}-`)) continue
    let value = className.slice(prefix.length + 1)
    // `border-t-purple-500` and `border-x-2` both start with a side segment.
    if (prefix === 'border' || prefix === 'divide') {
      const stripped = value.replace(SIDE_SEGMENT, '')
      if (stripped !== value) value = stripped
    }
    return withoutOpacity(value)
  }
  return undefined
}

/**
 * The contents of each balanced `[...]` group in a class, innermost removed.
 *
 * Brackets nest, as in `[&_svg:not([class*='size-'])]:size-4`, so a naive
 * `indexOf` pair would read the wrong span and then miss a colour sitting after
 * the inner close.
 */
function arbitraryGroups(className: string): string[] {
  const groups: string[] = []
  const stack: number[] = []
  for (let i = 0; i < className.length; i += 1) {
    const char = className[i]
    if (char === '[') stack.push(i)
    else if (char === ']' && stack.length > 0) {
      const open = stack.pop() as number
      groups.push(className.slice(open + 1, i))
    }
  }
  return groups.sort((a, b) => b.length - a.length)
}

/** Classifies one class name, or undefined when it is clean. */
export function classifyClass(className: string): DesignTokenRule | undefined {
  const value = colourValue(className)
  if (value !== undefined) {
    if (PALETTE_STEP.test(value)) return 'palette-step'
    if (RAW_COLOUR_NAMES.has(value)) return 'raw-colour-name'
    // `to-transparent` is a gradient endpoint and `bg-transparent` means no fill,
    // so only transparent applied to text is a finding: it hides the text, and it
    // does so silently once its gradient stops stop compiling.
    if (value === 'transparent' && className.startsWith('text-')) return 'transparent-text'
  }

  for (const group of arbitraryGroups(className)) {
    if (COLOUR_LITERAL.test(group) || hasNamedColour(group)) return 'arbitrary-colour'
  }
  return undefined
}

/** True when a stylesheet line may hold a colour literal: a token declaration. */
function isTokenDeclaration(line: string): boolean {
  const declaration = /^\s*(--[\w-]+)\s*:/.exec(line)
  if (!declaration) return false
  // The `--color-` namespace is reset by the build, so declaring one directly is
  // always wrong: the supported path is a plain token plus a `@theme inline`
  // mapping, which is a `var()` reference rather than a literal.
  return !declaration[1].startsWith('--color-')
}

function scanStylesheet(filePath: string, report: string): DesignTokenViolation[] {
  const lines = readFileSync(filePath, 'utf8').split('\n')
  const violations: DesignTokenViolation[] = []
  lines.forEach((line, index) => {
    if (isTokenDeclaration(line)) return
    if (!COLOUR_LITERAL.test(line)) return
    violations.push({
      file: report,
      line: index + 1,
      rule: 'css-literal',
      text: line.trim(),
    })
  })
  return violations
}

function scanTypescript(filePath: string, report: string): DesignTokenViolation[] {
  const source = parseSourceFile(filePath)
  const violations: DesignTokenViolation[] = []

  const visit = (node: ts.Node): void => {
    let literal: string | undefined
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      // The literal spans of a template that does interpolate. A class attribute
      // is often written as `bg-slate-900 ${rest}`, and the head is where the
      // class before the first interpolation lives.
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      literal = node.text
    }
    if (literal !== undefined) {
      for (const candidate of classCandidates(literal)) {
        const rule = classifyClass(candidate)
        if (!rule) continue
        violations.push({
          file: report,
          line: lineOf(source, node),
          rule,
          text: candidate,
        })
      }
    }

    // A colour in a style object is the one place the class name rules cannot
    // reach, so it is checked where the property name says what the value is for.
    if (ts.isObjectLiteralExpression(node) && isStyleAttribute(node)) {
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property)) continue
        const name = propertyName(property.name)
        if (!name || !STYLE_COLOUR_PROPERTIES.has(name)) continue
        const value = ts.isStringLiteralLike(property.initializer)
          ? property.initializer.text
          : property.initializer.getText(source)
        if (!COLOUR_LITERAL.test(value) && !hasNamedColour(value)) continue
        violations.push({
          file: report,
          line: lineOf(source, property),
          rule: 'inline-colour',
          text: `${name}: ${value.trim()}`,
        })
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(source)
  return violations
}

export function collectDesignTokenViolations(srcDir: string): DesignTokenWalkResult {
  if (!existsSync(srcDir)) {
    throw new Error(
      `Source directory not found: ${srcDir}. The design token guard cannot tell a missing source tree from a wrong path, so it refuses to report a clean run.`
    )
  }

  const projectRoot = findProjectRoot(srcDir)
  const files = collectSourceFiles(srcDir, STYLE_EXTENSIONS)
  const violations: DesignTokenViolation[] = []

  for (const filePath of files) {
    const report = relative(projectRoot, filePath).split(sep).join('/')
    violations.push(
      ...(filePath.endsWith('.css')
        ? scanStylesheet(filePath, report)
        : scanTypescript(filePath, report))
    )
  }

  return { inspected: files.length, violations }
}

/** The project root, from the guard's own location. Used by the real tree test. */
export function projectRootFrom(guardDir: string): string {
  return findProjectRoot(join(guardDir, '..'))
}