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
  // Walk up to the project root the same way the guards do.
  let dir = import.meta.dirname
  while (true) {
    try {
      return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson
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
    expect(pkg.scripts.build).toBe('tsc -b && vitest run && vite build')
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
