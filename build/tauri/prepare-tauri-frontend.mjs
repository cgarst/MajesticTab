import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '../..');
const sourceDir = path.join(rootDir, 'app');
const frontendDir = path.join(scriptDir, 'frontend-dist');
const nodeModulesDir = path.join(scriptDir, 'node_modules');
const androidBuild = process.argv.includes('--android');

const assets = [
  ['bootstrap/dist/css/bootstrap.min.css', 'vendor/bootstrap/dist/css/bootstrap.min.css'],
  ['bootstrap/dist/js/bootstrap.bundle.min.js', 'vendor/bootstrap/dist/js/bootstrap.bundle.min.js'],
  ['bootstrap-icons/font', 'vendor/bootstrap-icons/font'],
  ['codemirror/lib/codemirror.css', 'vendor/codemirror/lib/codemirror.css'],
  ['codemirror/lib/codemirror.js', 'vendor/codemirror/lib/codemirror.js'],
  ['codemirror/mode/javascript/javascript.js', 'vendor/codemirror/mode/javascript/javascript.js'],
  ['codemirror/addon/display/placeholder.js', 'vendor/codemirror/addon/display/placeholder.js'],
  ['pdfjs-dist/build/pdf.min.js', 'vendor/pdfjs-dist/build/pdf.min.js'],
  ['pdfjs-dist/build/pdf.worker.min.js', 'vendor/pdfjs-dist/build/pdf.worker.min.js'],
  ['jspdf/dist/jspdf.umd.min.js', 'vendor/jspdf/dist/jspdf.umd.min.js'],
  ['fflate/umd/index.js', 'vendor/fflate/umd/index.js'],
  ['@coderline/alphatab/dist', 'vendor/alphatab/dist'],
  ['pdf-lib/dist/pdf-lib.min.js', 'vendor/pdf-lib/dist/pdf-lib.min.js'],
];

const licenses = [
  ['bootstrap/LICENSE', 'vendor/licenses/bootstrap.txt'],
  ['bootstrap-icons/LICENSE', 'vendor/licenses/bootstrap-icons.txt'],
  ['codemirror/LICENSE', 'vendor/licenses/codemirror.txt'],
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
  ['https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.css', 'vendor/codemirror/lib/codemirror.css'],
  ['https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', 'vendor/pdfjs-dist/build/pdf.min.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js', 'vendor/pdfjs-dist/build/pdf.worker.min.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/jspdf/3.0.2/jspdf.umd.min.js', 'vendor/jspdf/dist/jspdf.umd.min.js'],
  ['https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js', 'vendor/bootstrap/dist/js/bootstrap.bundle.min.js'],
  ['https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js', 'vendor/fflate/umd/index.js'],
  ['https://cdn.jsdelivr.net/npm/@coderline/alphatab@1.8.4/dist/alphaTab.min.js', 'vendor/alphatab/dist/alphaTab.min.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.js', 'vendor/codemirror/lib/codemirror.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/javascript/javascript.min.js', 'vendor/codemirror/mode/javascript/javascript.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/display/placeholder.min.js', 'vendor/codemirror/addon/display/placeholder.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js', 'vendor/pdf-lib/dist/pdf-lib.min.js'],
  ['https://cdn.jsdelivr.net/npm/@coderline/alphatab@1.8.4/dist/font/Bravura.woff2', 'vendor/alphatab/dist/font/Bravura.woff2'],
  ['https://cdn.jsdelivr.net/npm/@coderline/alphatab@1.8.4/dist/font/Bravura.woff', 'vendor/alphatab/dist/font/Bravura.woff'],
  ['https://cdn.jsdelivr.net/npm/@coderline/alphatab@1.8.4/dist/font/Bravura.otf', 'vendor/alphatab/dist/font/Bravura.otf'],
  ['https://cdn.jsdelivr.net/npm/@coderline/alphatab@1.8.4/dist/soundfont/sonivox.sf2', 'vendor/alphatab/dist/soundfont/sonivox.sf2'],
]);

const allowedRemoteHosts = new Set([
  '127.0.0.1',
  'accounts.google.com',
  'api.github.com',
  'developers.google.com',
  'github.com',
  'invidious.drgns.space',
  'invidious.f5.si',
  'invidious.private.coffee',
  'iv.ggtyler.dev',
  'inv.vern.cc',
  'pa.il.ax',
  'pipedapi.r4fo.com',
  'pipedapi.tokhmi.xyz',
  'policies.google.com',
  'oauth2.googleapis.com',
  'www.googleapis.com',
  'www.youtube-nocookie.com',
  'www.youtube.com',
  'yt.artemislena.eu',
  'youtu.be',
  'www.w3.org',
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

async function hasDesktopClientSecret() {
  let config;
  try {
    config = await readFile(path.join(sourceDir, 'googleDrive.local.js'), 'utf8');
  } catch {
    return false;
  }

  const secret = /export\s+const\s+TAURI_CLIENT_SECRET\s*=\s*(['"])(.*?)\1\s*;?/.exec(config)?.[2]?.trim();
  return Boolean(secret && secret !== 'REPLACE_WITH_DESKTOP_CLIENT_SECRET');
}

async function writeBuildInfo() {
  const tauriConfig = JSON.parse(await readFile(path.join(scriptDir, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const info = {
    version: tauriConfig.version,
    channel: process.env.MAJESTICTAB_CHANNEL || 'dev',
    buildId: process.env.MAJESTICTAB_BUILD_ID || 'dev',
    arch: process.env.MAJESTICTAB_ARCH || null,
  };
  await writeFile(path.join(frontendDir, 'build-info.js'), `export default ${JSON.stringify(info)};\n`);
}

async function hideUnavailableDriveOptions() {
  const indexPath = path.join(frontendDir, 'index.html');
  let indexHtml = await readFile(indexPath, 'utf8');
  const hiddenMarkers = [
    ['<label id="localFileSourceLabel"', '<label id="localFileSourceLabel" hidden'],
    ['<div id="drivePickerSection"', '<div id="drivePickerSection" hidden'],
  ];
  for (const [marker, hiddenMarker] of hiddenMarkers) {
    if (!indexHtml.includes(marker)) {
      throw new Error(`Could not find ${marker} in the Tauri frontend.`);
    }
    indexHtml = indexHtml.replace(marker, hiddenMarker);
  }
  await writeFile(indexPath, indexHtml);
}

try {
  await rm(frontendDir, { recursive: true, force: true });
  await cp(sourceDir, frontendDir, { recursive: true });
  await writeBuildInfo();
  if (!androidBuild && !(await hasDesktopClientSecret())) {
    await hideUnavailableDriveOptions();
    console.log('Google Drive hidden: no Desktop OAuth client secret configured.');
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
  console.log(`Prepared Tauri frontend with local assets (${replacementCount} CDN references rewritten).`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}