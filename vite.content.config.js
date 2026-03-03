/**
 * Vite config – contentScript.js as IIFE
 *
 * Content scripts run in the page context and do NOT support ES modules.
 * They must be bundled as a self-contained IIFE.
 * We use Vite's library mode which supports IIFE for a single entry.
 */
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    // Append to dist (do NOT clear it – that already happened in first pass)
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry:   resolve(__dirname, 'src/contentScript.js'),
      name:    'VoxEditCS',
      formats: ['iife'],
      // Output filename must match what manifest.json declares
      fileName: () => 'contentScript.js',
    },
    rollupOptions: {
      // No external deps – everything inline
      external: [],
      output: {
        // Suppress the default "dist/contentScript.iife.js" → name it exactly
        entryFileNames: 'contentScript.js',
      },
    },
    sourcemap: false,
    minify: false,
  },
});
