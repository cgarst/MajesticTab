// Fails a build if a channel contains something it must not (see the store builds plan, "Verification per channel").
// Usage: node build/verify-channel.mjs [channel]   (checks build/tauri/frontend-dist and the Cargo default features)
// build-tauri.mjs also calls verifyChannel() before compiling, and again on the Android project after it is patched.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CHANNEL, cargoFeatures, channels, isValidChannel, resolveChannel } from './channels.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const tauriDir = path.join(scriptDir, 'tauri');
const SANDBOX_CSP = "default-src 'none'; script-src 'self' mtsandbox: 'unsafe-eval'; worker-src blob:";

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'vendor') files.push(...await sourceFiles(entryPath));
    } else if (/\.(?:html|js|mjs)$/i.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

/**
 * @param {string} id channel id
 * @param {object} [options]
 * @param {string} [options.frontendDir] prepared frontend (default build/tauri/frontend-dist)
 * @param {string} [options.cargoToml] Cargo.toml as patched for this build
 * @param {string} [options.androidProject] generated Android project (checked after patching)
 * @param {boolean} [options.debugTools] whether devtools were requested
 * @returns {Promise<{errors: string[], warnings: string[]}>}
 */
export async function verifyChannel(id, options = {}) {
  const frontendDir = options.frontendDir ?? path.join(tauriDir, 'frontend-dist');
  const errors = [];
  const warnings = [];
  const expected = resolveChannel(id);
  const store = id !== DEFAULT_CHANNEL;

  // channel.json is exactly what build/channels.mjs says
  try {
    const actual = JSON.parse(await readFile(path.join(frontendDir, 'channel.json'), 'utf8'));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) errors.push(`channel.json does not match the "${id}" definition in build/channels.mjs`);
  } catch {
    errors.push(`${frontendDir}/channel.json is missing or unreadable`);
  }

  const files = await sourceFiles(frontendDir).catch(() => []);
  const contents = new Map();
  for (const file of files) contents.set(path.relative(frontendDir, file), await readFile(file, 'utf8'));
  const containing = (needle) => [...contents].filter(([, text]) => text.includes(needle)).map(([name]) => name);

  // Curated sources and userscripts only ship with the full Tab Downloader
  if (expected.tabDownloader !== 'full') {
    if (contents.has('tabDownloaderFullSources.js')) errors.push('tabDownloaderFullSources.js is present but the Tab Downloader is not "full"');
    for (const marker of ['UG_DEFAULT_USERSCRIPT = `', 'MajesticTab UG Userscript', 'ultimate-guitar', 'classtab.org']) {
      const hits = containing(marker);
      if (hits.length) errors.push(`"${marker}" ships in: ${hits.join(', ')}`);
    }
  } else if (!expected.userscripts) {
    errors.push('userscripts are off but the full Tab Downloader (which carries them) is on; use tabDownloader "google-only"');
  }

  // Extension sandbox CSP is unchanged in every channel
  const frame = contents.get(path.join('extensionSandbox', 'frame.html'));
  if (!frame) errors.push('extensionSandbox/frame.html is missing');
  else if (!frame.includes(SANDBOX_CSP)) errors.push('extensionSandbox/frame.html no longer carries the expected no-network CSP');
  try {
    const rust = await readFile(path.join(tauriDir, 'src-tauri', 'src', 'lib.rs'), 'utf8');
    if (!rust.includes(`"${SANDBOX_CSP}"`)) errors.push('src-tauri/src/lib.rs sandbox CSP differs from frame.html');
  } catch {
    errors.push('could not read src-tauri/src/lib.rs');
  }
  if (contents.has('extensionSandbox.js') && containing('codemirror').length) errors.push('an in-app code editor (CodeMirror) ships in the frontend');

  // Rust features follow the channel
  if (options.cargoToml) {
    const toml = await readFile(options.cargoToml, 'utf8');
    const actual = /^default\s*=\s*\[(.*?)\]$/m.exec(toml)?.[1].split(',').map((f) => f.trim().replace(/"/g, '')).filter(Boolean) ?? null;
    if (!actual || actual.join() !== cargoFeatures(id).join()) errors.push(`Cargo default features are [${actual}] but the channel needs [${cargoFeatures(id)}]`);
  }

  // Android: the downloader webview (third-party pages) gets only close and onTabDownloaded
  if (channels[id].platforms.includes('android')) {
    const activity = await readFile(path.join(tauriDir, 'android-MainActivity.kt'), 'utf8');
    const start = activity.indexOf('private fun addDownloaderBridges');
    let body = '';
    if (start >= 0) {
      let depth = 0;
      for (let i = activity.indexOf('{', start); i < activity.length; i++) {
        if (activity[i] === '{') depth++;
        if (activity[i] === '}' && --depth === 0) { body = activity.slice(start, i + 1); break; }
      }
    }
    if (!body) {
      errors.push('android-MainActivity.kt has no addDownloaderBridges (downloader bridge split)');
    } else {
      const names = [...body.matchAll(/addJavascriptInterface\([\s\S]*?\}, "(\w+)"\)/g)].map((m) => m[1]);
      if (names.join() !== 'MajesticDownloaderNative') errors.push(`downloader webview registers bridges [${names}], expected only MajesticDownloaderNative`);
      const methods = [...body.matchAll(/@JavascriptInterface\s+fun (\w+)/g)].map((m) => m[1]).sort();
      if (methods.join() !== 'close,onTabDownloaded') errors.push(`downloader bridge exposes [${methods}], expected only close and onTabDownloaded`);
    }
    if (!/if \(!isAppWebView\) \{\s*addDownloaderBridges\(webView\)\s*return/.test(activity)) {
      errors.push('onWebViewCreate no longer routes non-app webviews to addDownloaderBridges before registering other bridges');
    }
  }

  // Android: no updater pieces when selfUpdate is off
  if (options.androidProject && !expected.selfUpdate) {
    const manifest = await readFile(path.join(options.androidProject, 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
    for (const marker of ['REQUEST_INSTALL_PACKAGES', 'updateprovider']) {
      if (manifest.includes(marker)) errors.push(`AndroidManifest.xml contains ${marker}`);
    }
    const activity = await readFile(path.join(options.androidProject, 'app', 'src', 'main', 'java', 'net', 'zathu', 'majestictab', 'MainActivity.kt'), 'utf8');
    if (activity.includes('AndroidUpdater')) errors.push('MainActivity.kt still registers AndroidUpdater');
  }

  // Store builds never ship devtools
  if (store && options.debugTools) errors.push('devtools (--debug-tools/--debug) are not allowed in store channels');

  return { errors, warnings };
}

export async function verifyOrExit(id, options) {
  const { errors, warnings } = await verifyChannel(id, options);
  for (const warning of warnings) console.warn(`[verify-channel:${id}] warning: ${warning}`);
  if (errors.length) {
    console.error(`[verify-channel:${id}] FAILED\n${errors.map((error) => `  - ${error}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`[verify-channel:${id}] ok`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const id = process.argv[2] ?? DEFAULT_CHANNEL;
  if (!isValidChannel(id)) {
    console.error(`Unknown channel "${id}"`);
    process.exit(2);
  }
  await verifyOrExit(id);
}
