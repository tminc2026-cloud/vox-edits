/**
 * Vite config – HTML pages + background service worker
 * root:'src' so HTML files output to dist/ not dist/src/
 */
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  // Use relative base so built HTML files reference assets with relative paths
  // (required for chrome-extension:// URLs regardless of load directory)
  base: './',
  // Treat src/ as Vite's project root so HTML paths are resolved correctly
  root: resolve(__dirname, 'src'),
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        popup:      resolve(__dirname, 'src/popup.html'),
        sidebar:    resolve(__dirname, 'src/sidebar.html'),
        background: resolve(__dirname, 'src/background.js'),
      },
      output: {
        // ES module format for extension pages and background SW
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: '[name]-[hash].js',
        assetFileNames: '[name][extname]',
      },
    },
    sourcemap: false,
    minify: false,
  },
});
