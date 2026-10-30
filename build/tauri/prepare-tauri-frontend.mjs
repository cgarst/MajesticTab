import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';
import { DEFAULT_CHANNEL, resolveChannel } from '../channels.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '../..');
const sourceDir = path.join(rootDir, 'src');
const frontendDir = path.join(scriptDir, 'frontend-dist');
const nodeModulesDir = path.join(scriptDir, 'node_modules');
const androidBuild = process.argv.includes('--android');
const iosBuild = process.argv.includes('--ios');
const skipMinify = process.argv.includes('--no-minify') || process.env.MAJESTICTAB_NO_MINIFY === '1';

const assets = [
  ['bootstrap/dist/css/bootstrap.min.css', 'vendor/bootstrap/dist/css/bootstrap.min.css'],
  ['bootstrap/dist/js/bootstrap.bundle.min.js', 'vendor/bootstrap/dist/js/bootstrap.bundle.min.js'],
  ['bootstrap-icons/font', 'vendor/bootstrap-icons/font'],
  ['pdfjs-dist/build/pdf.min.js', 'vendor/pdfjs-dist/build/pdf.min.js'],
  ['pdfjs-dist/build/pdf.worker.min.js', 'vendor/pdfjs-dist/build/pdf.worker.min.js'],
  ['jspdf/dist/jspdf.umd.min.js', 'vendor/jspdf/dist/jspdf.umd.min.js'],
  ['fflate/umd/index.js', 'vendor/fflate/umd/index.js'],
  ['@coderline/alphatab/dist', 'vendor/alphatab/dist'],
  ['pdf-lib/dist/pdf-lib.min.js', 'vendor/pdf-lib/dist/pdf-lib.min.js'],
  ['qrcode-generator/dist/qrcode.js', 'vendor/qrcode-generator/dist/qrcode.js'],
];

const licenses = [
  ['bootstrap/LICENSE', 'vendor/licenses/bootstrap.txt'],
  ['bootstrap-icons/LICENSE', 'vendor/licenses/bootstrap-icons.txt'],
  ['pdfjs-dist/LICENSE', 'vendor/licenses/pdfjs-dist.txt'],
  ['jspdf/LICENSE', 'vendor/licenses/jspdf.txt'],
  ['fflate/LICENSE', 'vendor/licenses/fflate.txt'],
  ['@coderline/alphatab/LICENSE', 'vendor/licenses/alphatab.txt'],
  ['pdf-lib/LICENSE.md', 'vendor/licenses/pdf-lib.txt'],
];

const replacements = new Map([
  ['https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css', 'vendor/bootstrap/dist/css/bootstrap.min.css'],
  ['https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.css', 'vendor/bootstrap-icons/font/bootstrap-icons.css'],
  ['https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css', 'vendor/bootstrap-icons/font/bootstrap-icons.min.css'],
  ['https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', 'vendor/pdfjs-dist/build/pdf.min.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js', 'vendor/pdfjs-dist/build/pdf.worker.min.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/jspdf/4.2.1/jspdf.umd.min.js', 'vendor/jspdf/dist/jspdf.umd.min.js'],
  ['https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js', 'vendor/bootstrap/dist/js/bootstrap.bundle.min.js'],
  ['https://cdn.jsdelivr.net/npm/fflate@0.8.3/umd/index.js', 'vendor/fflate/umd/index.js'],
  ['https://cdn.jsdelivr.net/npm/@coderline/alphatab@1.8.4/dist/alphaTab.min.js', 'vendor/alphatab/dist/alphaTab.min.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js', 'vendor/pdf-lib/dist/pdf-lib.min.js'],
  ['https://cdn.jsdelivr.net/npm/qrcode-generator@2.0.4/dist/qrcode.js', 'vendor/qrcode-generator/dist/qrcode.js'],
  ['https://cdn.jsdelivr.net/npm/@coderline/alphatab@1.8.4/dist/font/Bravura.woff2', 'vendor/alphatab/dist/font/Bravura.woff2'],
  ['https://cdn.jsdelivr.net/npm/@coderline/alphatab@1.8.4/dist/font/Bravura.woff', 'vendor/alphatab/dist/font/Bravura.woff'],
  ['https://cdn.jsdelivr.net/npm/@coderline/alphatab@1.8.4/dist/font/Bravura.otf', 'vendor/alphatab/dist/font/Bravura.otf'],
  ['https://cdn.jsdelivr.net/npm/@coderline/alphatab@1.8.4/dist/soundfont/sonivox.sf2', 'vendor/alphatab/dist/soundfont/sonivox.sf2'],
]);

const allowedRemoteHosts = new Set([
  '127.0.0.1',
  'accounts.google.com',
  'api.github.com',
  'apis.google.com',
  'developers.google.com',
  'github.com',
  'invidious.drgns.space',
  'invidious.f5.si',
  'invidious.private.coffee',
  'iv.ggtyler.dev',
  'inv.vern.cc',
  'pa.il.ax',
  'pipedapi.ducks.party',
  'api.piped.private.coffee',
  'pipedapi.r4fo.com',
  'pipedapi.tokhmi.xyz',
  'policies.google.com',
  'accounts.google.com',
  'oauth2.googleapis.com',
  'www.googleapis.com',
  'www.youtube-nocookie.com',
  'youtube-nocookie.com',
  'www.youtube.com',
  'youtube.com',
  'yt.artemislena.eu',
  'youtu.be',
  'www.w3.org',
  'musicbrainz.org',
  'coverartarchive.org',
  'archive.org',
  'google.com',
  'majestictab.zathu.net',
  'www.google.com',
]);

async function copyAsset(source, destination) {
  const sourcePath = path.join(nodeModulesDir, source);
  const destinationPath = path.join(frontendDir, destination);
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await cp(sourcePath, destinationPath, { recursive: true });
}

async function rewriteFiles(directory) {
  let replacementCount = 0;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      replacementCount += await rewriteFiles(entryPath);
    } else if (/\.(?:html|js|css|mjs)$/i.test(entry.name)) {
      let content = await readFile(entryPath, 'utf8');
      for (const [remoteUrl, localPath] of replacements) {
        const relativePath = entryPath.endsWith('.html')
          ? path.relative(path.dirname(entryPath), path.join(frontendDir, localPath)).split(path.sep).join('/')
          : `/${localPath}`;
        const nextContent = content.split(remoteUrl).join(relativePath);
        if (nextContent !== content) replacementCount += content.split(remoteUrl).length - 1;
        content = nextContent;
      }
      await writeFile(entryPath, content);
    }
  }
  return replacementCount;
}

async function validateRemoteUrls(directory) {
  const unexpectedUrls = [];
  const urlPattern = /https?:\/\/[^\s"'`<>\])}]+/g;

  async function inspect(currentDirectory) {
    const entries = await readdir(currentDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'vendor') continue;
        await inspect(entryPath);
      } else if (/\.(?:html|js|css|mjs)$/i.test(entry.name)) {
        const content = await readFile(entryPath, 'utf8');
        for (const match of content.matchAll(urlPattern)) {
          // Template-literal URLs (e.g. user-configured S3 endpoints) have no static host to approve.
          if (match[0].includes('${')) continue;
          let hostname;
          try {
            hostname = new URL(match[0]).hostname;
          } catch {
            continue;
          }
          if (!allowedRemoteHosts.has(hostname)) {
            unexpectedUrls.push(`${path.relative(frontendDir, entryPath)}: ${match[0]}`);
          }
        }
      }
    }
  }

  await inspect(directory);
  if (unexpectedUrls.length > 0) {
    throw new Error(`Unapproved external URLs remain in the Tauri frontend:\n${unexpectedUrls.join('\n')}`);
  }
}

async function loadEnvFiles() {
  const possiblePaths = [
    path.join(rootDir, '.env'),
    path.join(scriptDir, '.env'),
    path.join(rootDir, 'build', '.env'),
  ];
  for (const envPath of possiblePaths) {
    try {
      const content = await readFile(envPath, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
        if (match) {
          const key = match[1];
          let val = match[2].trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    } catch {}
  }
}

// The desktop OAuth client (src/googleDesktopClient.js) is public by design and committed. GOOGLE_DESKTOP_CLIENT_ID
// and GOOGLE_DESKTOP_CLIENT_KEY replace its values for builds that use a different Google Cloud client.
async function applyDesktopClientOverrides() {
  const overrides = {
    DESKTOP_CLIENT_ID: (process.env.GOOGLE_DESKTOP_CLIENT_ID || '').trim(),
    DESKTOP_CLIENT_KEY: (process.env.GOOGLE_DESKTOP_CLIENT_KEY || '').trim(),
  };
  const file = path.join(frontendDir, 'googleDesktopClient.js');
  let source = await readFile(file, 'utf8');
  for (const [name, value] of Object.entries(overrides)) {
    if (!value) continue;
    const pattern = new RegExp(`(export const ${name} = )'[^']*'`);
    if (!pattern.test(source)) throw new Error(`googleDesktopClient.js has no ${name} to override.`);
    source = source.replace(pattern, (_, prefix) => `${prefix}${JSON.stringify(value)}`);
  }
  await writeFile(file, source);
}

async function writeBuildInfo() {
  const tauriConfig = JSON.parse(await readFile(path.join(scriptDir, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const info = {
    version: tauriConfig.version,
    channel: process.env.MAJESTICTAB_CHANNEL || 'dev',
    buildId: process.env.MAJESTICTAB_BUILD_ID || 'dev',
    arch: process.env.MAJESTICTAB_ARCH || null,
  };
  if (!process.env.MAJESTICTAB_CHANNEL) {
    // Local builds have no CI build id; record the commit so the updater can compare against releases.
    try {
      const git = (...args) => execFileSync('git', args, { cwd: scriptDir, encoding: 'utf8' }).trim();
      info.commit = git('rev-parse', '--short=7', 'HEAD');
      info.commitDate = git('show', '-s', '--format=%cI', 'HEAD');
    } catch {}
  }
  await writeFile(path.join(frontendDir, 'build-info.js'), `export default ${JSON.stringify(info)};\n`);
}

async function writeChannelConfig() {
  const id = process.env.MAJESTICTAB_STORE_CHANNEL || DEFAULT_CHANNEL;
  const channelConfig = resolveChannel(id);
  await writeFile(path.join(frontendDir, 'channel.json'), `${JSON.stringify(channelConfig, null, 2)}\n`);
  console.log(`Distribution channel: ${id}`);
}

// Channels without Google Drive get inert modules in place of the real ones, so no Drive code, OAuth client ID or
// key ships. Callers are gated on the googleDrive capability and never reach the stubs.
async function stubOutGoogleDrive() {
  const stubDir = path.join(scriptDir, 'stubs', 'no-drive');
  for (const name of await readdir(stubDir)) {
    await cp(path.join(stubDir, name), path.join(frontendDir, name));
  }
  await rm(path.join(frontendDir, 'googleDesktopClient.js'), { force: true });
  await rm(path.join(frontendDir, 'googleDrive.local.js'), { force: true });
  await rm(path.join(frontendDir, 'pickerKey.local.js'), { force: true });
  const stripped = await stripGoogleDriveBlocks(frontendDir);
  console.log(`Google Drive stubbed out and stripped from ${stripped} files: channel has no googleDrive capability.`);
}

// Call sites of the Drive modules sit between `// @googleDrive:begin` and `// @googleDrive:end` lines (`<!-- ... -->`
// inside HTML templates), and are cut out here so the Drive UI and its imports do not ship either.
const driveBlock = /[ \t]*(?:\/\/|<!--)[ \t]*@googleDrive:begin[ \t]*(?:-->)?[ \t]*\n[\s\S]*?[ \t]*(?:\/\/|<!--)[ \t]*@googleDrive:end[ \t]*(?:-->)?[ \t]*\n?/g;

async function stripGoogleDriveBlocks(directory) {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'vendor') count += await stripGoogleDriveBlocks(entryPath);
    } else if (/\.(?:html|js|mjs)$/i.test(entry.name)) {
      const source = await readFile(entryPath, 'utf8');
      const stripped = source.replace(driveBlock, '');
      if (stripped !== source) {
        await writeFile(entryPath, stripped);
        count++;
      }
    }
  }
  return count;
}

async function minifyAppScripts(directory) {
  let count = 0;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'vendor') continue;
      count += await minifyAppScripts(entryPath);
    } else if (/\.js$/i.test(entry.name)) {
      const source = await readFile(entryPath, 'utf8');
      // Properties are never mangled: AlphaTab's minified fields are accessed by name.
      const { code } = await transform(source, { minify: true, format: 'esm', target: 'es2022', legalComments: 'none' });
      await writeFile(entryPath, code);
      count++;
    }
  }
  return count;
}

try {
  await rm(frontendDir, { recursive: true, force: true });
  await cp(sourceDir, frontendDir, { recursive: true });
  await writeBuildInfo();
  await writeChannelConfig();
  const driveEnabled = resolveChannel(process.env.MAJESTICTAB_STORE_CHANNEL || DEFAULT_CHANNEL).googleDrive;
  if (!driveEnabled) {
    await stubOutGoogleDrive();
  }
  if (androidBuild || iosBuild) {
    // Phones sign in through the platform's own flow and never load the desktop client.
    await rm(path.join(frontendDir, 'googleDesktopClient.js'), { force: true });
  } else if (driveEnabled) {
    await loadEnvFiles();
    await applyDesktopClientOverrides();
  }
  const pickerApiKey = driveEnabled ? (process.env.GOOGLE_PICKER_API_KEY || '').trim() : '';
  if (pickerApiKey) {
    await writeFile(path.join(frontendDir, 'pickerKey.local.js'), `export const PICKER_API_KEY = '${pickerApiKey}';\n`);
  }
  for (const [source, destination] of assets) {
    await copyAsset(source, destination);
  }
  for (const [source, destination] of licenses) {
    await copyAsset(source, destination);
  }
  const replacementCount = await rewriteFiles(frontendDir);
  if (replacementCount === 0) {
    throw new Error('No CDN asset references were rewritten; check the asset mappings.');
  }
  await validateRemoteUrls(frontendDir);
  if (!skipMinify) {
    console.log(`Minified ${await minifyAppScripts(frontendDir)} app scripts.`);
  }
  console.log(`Prepared Tauri frontend with local assets (${replacementCount} CDN references rewritten).`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}