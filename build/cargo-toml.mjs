// Rewrites the crate's Cargo.toml for a channel and target: the lib crate types and the default features.
// Used by build-tauri.mjs, and run directly by the Flathub manifest: node build/cargo-toml.mjs <channel> [target]
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cargoFeatures } from './channels.mjs';

export function rewriteCargoToml(content, target, channel) {
  const crateTypes = target === 'android'
    ? 'crate-type = ["staticlib", "cdylib", "rlib"]'
    : 'crate-type = ["staticlib", "rlib"]';
  const pattern = /crate-type\s*=\s*\[.*?\]/;
  if (pattern.test(content)) {
    content = content.replace(pattern, crateTypes);
  }
  // Channel capabilities (self-update, userscripts) become the crate's default features.
  const defaultFeatures = `default = [${cargoFeatures(channel).map((feature) => `"${feature}"`).join(', ')}]`;
  return content.replace(/^default\s*=\s*\[.*?\]$/m, defaultFeatures);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [channel, target = 'desktop'] = process.argv.slice(2);
  if (!channel) {
    console.error('Usage: node build/cargo-toml.mjs <channel> [target]');
    process.exit(1);
  }
  const cargoTomlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tauri', 'src-tauri', 'Cargo.toml');
  await writeFile(cargoTomlPath, rewriteCargoToml(await readFile(cargoTomlPath, 'utf8'), target, channel));
}
