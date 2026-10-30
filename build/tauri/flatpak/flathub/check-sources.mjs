// Fails when cargo-sources.json / node-sources.json no longer match the lockfiles they were generated from.
// Offline and instant: compares the lockfiles' hashes with the ones recorded by update-sources.sh.
// Usage: node check-sources.mjs
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tauriDir = path.resolve(here, '../..');
const lockfiles = ['src-tauri/Cargo.lock', 'package-lock.json'];
const hash = (file) => createHash('sha256').update(readFileSync(path.join(tauriDir, file))).digest('hex');

const recorded = Object.fromEntries(readFileSync(path.join(here, 'lockfiles.sha256'), 'utf8')
  .split('\n').filter(Boolean).map((line) => line.split(/\s+/).reverse()));
const stale = lockfiles.filter((file) => recorded[file] !== hash(file));
if (stale.length) {
  console.error(`Flathub sources are stale: ${stale.join(', ')} changed since they were generated.`);
  console.error('Run build/tauri/flatpak/flathub/update-sources.sh and commit the result.');
  process.exit(1);
}
console.log('Flathub sources match the lockfiles.');
