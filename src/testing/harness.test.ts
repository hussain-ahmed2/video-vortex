import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The harness's own guarantees, stated as checks rather than as claims.
//
// This file runs in plain Node with no DOM, which is itself part of what it
// asserts: a suite that needed a browser or a network would not get this far.

interface PackageJson {
  scripts: Record<string, string>
  devDependencies: Record<string, string>
  dependencies?: Record<string, string>
  engines?: { node?: string }
}

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(join(projectRoot(), 'package.json'), 'utf8')) as PackageJson
}

/** The project root, found by walking up to the `package.json` the same way the guards do. */
function projectRoot(): string {
  let dir = import.meta.dirname
  while (true) {
    try {
      readFileSync(join(dir, 'package.json'), 'utf8')
      return dir
    } catch {
      const parent = join(dir, '..')
      if (parent === dir) throw new Error('no package.json found')
      dir = parent
    }
  }
}

const pkg = readPackageJson()

describe('the test harness', () => {
  it('runs the suite with one command, and the build gates on it', () => {
    expect(pkg.scripts.test).toBe('vitest run')
    expect(pkg.scripts['test:watch']).toBe('vitest')
    // Type check first so a type error in a test file fails before the suite runs.
    //
    // The last two passes are the two build inputs that cannot be ES modules, because
    // each is evaluated as a classic script in a world with no module loader: the content
    // script in an isolated world, and the page hook in the page's own. Both need a config
    // of their own, and both must come after the main build, which is the one that clears
    // `dist`. The order is the contract, so it is written out rather than looped over.
    expect(pkg.scripts.build).toBe(
      'tsc -b && vitest run && vite build' +
        ' && vite build --config vite.content.config.ts' +
        ' && vite build --config vite.hook.config.ts'
    )
    expect(pkg.scripts['build:hook']).toBe('vite build --config vite.hook.config.ts')
  })

  it('names every self contained build output flat, because a rename breaks it silently', () => {
    // `background.js` and `content.js` are named by the manifest and `hook.js` by the
    // worker's injection call. All three have to land at the root of `dist` rather than in
    // a hashed directory, and none of the three failures announces itself.
    for (const config of ['vite.content.config.ts', 'vite.hook.config.ts']) {
      const source = readFileSync(join(projectRoot(), config), 'utf8')
      expect(source).toContain("outDir: 'dist'")
      expect(source).toContain('emptyOutDir: false')
      expect(source).toMatch(/fileName: \(\) => '[a-z]+\.js'/)
    }
  })

  it('depends on the runner and a DOM shim, and nothing else for testing', () => {
    expect(pkg.devDependencies).toHaveProperty('vitest')
    expect(pkg.devDependencies).toHaveProperty('jsdom')
  })

  it('pulls in no browser automation, so the suite needs no browser binary', () => {
    const all = { ...pkg.dependencies, ...pkg.devDependencies }
    const browserPackages = [
      'playwright',
      '@playwright/test',
      'puppeteer',
      'puppeteer-core',
      'cypress',
      'selenium-webdriver',
      'webdriverio',
      'jsdom-global',
    ]
    for (const name of browserPackages) {
      expect(all).not.toHaveProperty(name)
    }
  })

  it('records the Node floor the toolchain needs', () => {
    expect(pkg.engines?.node).toBeTruthy()
  })
})
