import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// `public/manifest.json` is the contract with Chrome, and it is the one file in this
// project that nothing type checks. A permission left behind after the code that used
// it is deleted is invisible in review until a store reviewer reads it, and a content
// script declared here runs on every page whether or not anyone is watching.
//
// Spec 0004 AC-13 pins both changes, so they are asserted here rather than left to a
// hand check of a JSON file.

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(projectRoot, 'public', 'manifest.json')
const contentConfigPath = join(projectRoot, 'vite.content.config.ts')
const mainConfigPath = join(projectRoot, 'vite.config.ts')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  permissions: string[]
  host_permissions: string[]
  content_scripts?: Array<{ matches: string[]; js: string[] }>
  background: { service_worker: string; type?: string }
  action: { default_popup: string }
}

describe('AC-13, the permissions the manifest asks for', () => {
  it('asks for scripting, which is how the content script reaches a page on demand', () => {
    expect(manifest.permissions).toContain('scripting')
  })

  it('no longer asks for the header rewriting permission, which nothing uses', () => {
    // The blocking request listener it served is gone from the code entirely, and
    // spec 0001's static ruleset needs a permission of its own that this slice does
    // not add.
    expect(manifest.permissions).not.toContain('declarativeNetRequestWithHostAccess')
  })

  it('keeps every permission the code still has a path behind', () => {
    expect(manifest.permissions).toEqual([
      'activeTab',
      'tabs',
      'downloads',
      'storage',
      'webRequest',
      'scripting',
    ])
  })

  it('keeps host access to all sites, which the observer needs to see any request', () => {
    expect(manifest.host_permissions).toEqual(['<all_urls>'])
  })
})

describe('AC-13, the content script is injected on demand', () => {
  it('declares no declarative content script at all', () => {
    // A declared content script runs on every page load whether or not the popup is
    // ever opened, and this slice reads a tab only when someone asks it to.
    expect(manifest.content_scripts).toBeUndefined()
  })
})

describe('the build inputs the manifest names by flat file name', () => {
  it('still points at background.js, because renaming that input breaks silently', () => {
    expect(manifest.background.service_worker).toBe('background.js')
    // The declaration is what lets the worker be an ES module and import a shared chunk.
    expect(manifest.background.type).toBe('module')
  })

  it('still points at the popup shell', () => {
    expect(manifest.action.default_popup).toBe('index.html')
  })
})

describe('the content script cannot be an ES module', () => {
  const contentConfig = readFileSync(contentConfigPath, 'utf8')

  it('is built by a pass of its own, as a single file with no code splitting', () => {
    // A content script is injected with `executeScript({ files })` and evaluated as a
    // classic script, so a single shared `import` at the top of it stops the whole file
    // from parsing. The build then looks green and the popup waits forever. Library mode
    // with one entry is what makes the output import free.
    expect(contentConfig).toContain("formats: ['iife']")
    expect(contentConfig).toContain("entry: resolve(__dirname, 'src/content.ts')")
  })

  it("is not one of the main build's inputs, which would let it become a module", () => {
    const mainConfig = readFileSync(mainConfigPath, 'utf8')

    expect(mainConfig).not.toContain("resolve(__dirname, 'src/content.ts')")
  })

  it('keeps the second build from wiping the first one', () => {
    expect(contentConfig).toContain('emptyOutDir: false')
  })

  it('names the output file flat, because the manifest injects it by that name', () => {
    expect(contentConfig).toContain("fileName: () => 'content.js'")
  })
})
