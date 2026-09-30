/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
  test: {
    // Tests need no page unless they say so. A file that wants a DOM puts
    // `// @vitest-environment jsdom` at the top, which is the only mechanism
    // left now that the glob based matching is gone.
    environment: 'node',
    // Pinned rather than inherited: `forks` with isolation is what keeps one
    // test file's faked browser state out of the next file's assertions.
    pool: 'forks',
    isolate: true,
    // `globals` stays off, so tests import what they use and the ESLint config
    // needs no test environment block.
    globals: false,
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        background: resolve(__dirname, 'src/background.ts'),
        content: resolve(__dirname, 'src/content.ts'),
      },
      output: {
        entryFileNames: (chunk) => {
          if (chunk.name === 'background' || chunk.name === 'content') {
            return '[name].js';
          }
          return 'assets/[name]-[hash].js';
        }
      }
    }
  }
})
