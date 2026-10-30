// Builds the latest.json manifest read by tauri-plugin-updater from signed update artifacts.
// Usage: node build/make-update-manifest.mjs <artifactsDir> <version> <downloadBaseUrl> <outFile> [notes]
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [artifactsDir, version, baseUrl, outFile, notes = ''] = process.argv.slice(2);
if (!artifactsDir || !version || !baseUrl || !outFile) {
  console.error('Usage: node build/make-update-manifest.mjs <artifactsDir> <version> <downloadBaseUrl> <outFile> [notes]');
  process.exit(2);
}

// Update bundle file name -> platform key used by the updater plugin.
function platformFor(name) {
  if (/_arm64-setup\.exe$/i.test(name)) return 'windows-aarch64';
  if (/\.exe$/i.test(name)) return 'windows-x86_64';
  if (/^MajesticTab_aarch64\.app\.tar\.gz$/.test(name)) return 'darwin-aarch64';
  if (/^MajesticTab_x86_64\.app\.tar\.gz$/.test(name)) return 'darwin-x86_64';
  if (/\.AppImage$/i.test(name)) return 'linux-x86_64';
  return null;
}

const platforms = {};
for (const name of await readdir(artifactsDir)) {
  const platform = platformFor(name);
  if (!platform) continue;
  let signature;
  try {
    signature = (await readFile(path.join(artifactsDir, `${name}.sig`), 'utf8')).trim();
  } catch {
    continue; // Not a signed update bundle (for example the plain installer on an unsigned build).
  }
  platforms[platform] = { signature, url: `${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(name)}` };
}

if (Object.keys(platforms).length === 0) {
  console.log('No signed update bundles found; not writing a manifest.');
  process.exit(0);
}

await writeFile(outFile, JSON.stringify({ version, notes, pub_date: new Date().toISOString(), platforms }, null, 2));
console.log(`Wrote ${outFile} for: ${Object.keys(platforms).join(', ')}`);
