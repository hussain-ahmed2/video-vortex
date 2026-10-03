import { defineConfig } from 'vite'
import { resolve } from 'path'

// The page hook, built as one self contained classic script, exactly as `content.js` is.
//
// It runs in the page's own world, injected with `chrome.scripting.executeScript({ world:
// 'MAIN', files: ['hook.js'] })`. That means two things this config has to honour. It is
// evaluated as a classic script, so it cannot use `import`: the moment it shares a module
// with the popup or the worker, the bundler hoists that module into a shared chunk and
// `hook.js` begins with an import statement that fails to parse at run time. Nothing
// reports the failure. The hook simply never runs, no stream is ever reported, and the
// popup shows an empty list on a page that is playing something.
//
// And it is not named by the manifest, unlike `background.js` and `content.js`. Those two
// are pointed at by flat name and renaming either build input breaks the extension
// silently. This one is named by the worker's injection call instead, so the file name is
// written down in `src/background.ts` rather than in `public/manifest.json`. That is the
// same trap with the paperwork in a different file, so it is said here rather than left to
// be rediscovered.
//
// It carries zod and the page channel's schemas with it, for the same reason the content
// script does: a payload arriving across a runtime boundary is parsed before use, in every
// runtime, and the page is the least trustworthy sender in this extension. Affordable for
// the same reason too, which is that both this file and the content script are injected on
// demand rather than declared, so they cost a page nothing until someone opens the popup.
//
// `emptyOutDir` is off because this runs third and must not wipe the two builds before it.
// `publicDir` is off because the first build already copied the icons.

export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'src/hook.ts'),
      formats: ['iife'],
      // Required by the IIFE format, and never referenced: the file is loaded as a script.
      name: 'VideoVortexHook',
      fileName: () => 'hook.js',
    },
  },
})