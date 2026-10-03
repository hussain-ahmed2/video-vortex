import { defineConfig } from 'vite'
import { resolve } from 'path'

// The content script, built as one self contained classic script.
//
// A content script is injected with `chrome.scripting.executeScript({ files })`, which
// evaluates it as a classic script in an isolated world. It cannot use `import`, so the
// moment it shares a module with the popup or the worker, the bundler hoists that
// module into a shared chunk and `content.js` begins with an import statement that fails
// to parse at run time. Nothing reports the failure: the script simply never runs, the
// worker never hears from the page, and the popup sits on "Watching this page" forever.
//
// So this is a second build with no code splitting, and the engine it shares with the
// other two runtimes is bundled into it whole. A few kilobytes of duplication is the
// price of a content script that actually loads, and the alternative is not a smaller
// build but a broken one.
//
// `emptyOutDir` is off because this runs second and must not wipe the popup build, and
// `publicDir` is off because the first build already copied the icons.
//
// Library mode with a single entry already builds one file with no code splitting, which
// is what makes the output import free. The explicit `inlineDynamicImports` that used to
// sit here was ignored for that reason, and a config line that does nothing is worse
// than no config line.
//
// The file is larger than the script it wraps, because it carries the engine's schemas
// and zod with them. That is affordable here precisely because of the decision above: an
// on demand injection pays this once, when someone opens the popup, rather than on every
// page load.

export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'src/content.ts'),
      formats: ['iife'],
      // Required by the IIFE format, and never referenced: the file is loaded as a
      // script, not as a library.
      name: 'VideoVortexContent',
      fileName: () => 'content.js',
    },
  },
})
