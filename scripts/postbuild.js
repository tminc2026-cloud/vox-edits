/**
 * Post-build script: copies static extension assets into dist/
 * and patches HTML files for Chrome extension compatibility.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const dist = join(root, 'dist');

// Ensure dist exists
if (!existsSync(dist)) {
  mkdirSync(dist, { recursive: true });
}

// Copy manifest
copyFileSync(join(root, 'manifest.json'), join(dist, 'manifest.json'));
console.log('Copied manifest.json → dist/');

// Copy icons if present
const iconsDir = join(root, 'icons');
if (existsSync(iconsDir)) {
  const distIcons = join(dist, 'icons');
  if (!existsSync(distIcons)) mkdirSync(distIcons, { recursive: true });
  for (const file of readdirSync(iconsDir)) {
    copyFileSync(join(iconsDir, file), join(distIcons, file));
    console.log(`Copied icons/${file} → dist/icons/${file}`);
  }
}

// Patch HTML files: Vite emits absolute paths like /popup.js
// In Chrome extensions served from chrome-extension:// this resolves correctly
// but we strip crossorigin attributes which aren't needed.
for (const htmlFile of ['popup.html', 'sidebar.html']) {
  const htmlPath = join(dist, htmlFile);
  if (!existsSync(htmlPath)) continue;

  let html = readFileSync(htmlPath, 'utf-8');
  // Remove crossorigin attribute (not needed for extension pages)
  html = html.replace(/ crossorigin/g, '');
  writeFileSync(htmlPath, html, 'utf-8');
  console.log(`Patched ${htmlFile}`);
}

console.log('Post-build complete.');
