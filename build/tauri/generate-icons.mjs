// Builds per-platform app icons from icons/icon_v2_mystic.svg via `tauri icon`.
// Output goes to src-tauri/icons/<platform>/ (generated, gitignored).
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const sourceSvg = path.resolve(scriptDir, '..', '..', 'icons', 'icon_v2_mystic.svg');
const iconsDir = path.join(scriptDir, 'src-tauri', 'icons');
const workDir = path.join(scriptDir, 'target', 'icon-build');

const CANVAS = 1024;
const BACKGROUND_TOP = '#ffffff';
const BACKGROUND_BOTTOM = '#ddd3f7';
// Solid midpoint for the places that only accept a flat color.
const BACKGROUND = '#eee9fb';
const TILE_GRADIENT = '<defs><linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">'
  + `<stop offset="0" stop-color="${BACKGROUND_TOP}"/><stop offset="1" stop-color="${BACKGROUND_BOTTOM}"/></linearGradient></defs>`;

// Art box = longest side of the artwork, in 1024-unit canvas coordinates.
const PLATFORMS = {
  // Windows: transparent, art nearly fills the canvas.
  windows: { box: 940 },
  // Linux/freedesktop: transparent, slight padding so it sits well beside other hicolor icons.
  linux: { box: 900 },
  // macOS (Big Sur+ template): 824px rounded square centered in 1024 with a fixed background; art ~60% of it.
  macos: { box: 500, tile: { inset: 100, radius: 185 } },
  // iOS: opaque full-bleed square (the OS applies the mask); art kept inside the grid.
  ios: { box: 640, tile: { inset: 0, radius: 0 } },
  // Android adaptive foreground: art stays inside the 66/108 safe zone; the background layer is a solid color.
  androidFg: { box: 590 },
};

const source = await readFile(sourceSvg, 'utf8');
const viewBox = /viewBox="([^"]+)"/.exec(source)?.[1];
const inner = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(source)?.[1];
if (!viewBox || inner === undefined) throw new Error(`Could not parse ${sourceSvg}`);

function composeSvg({ box, tile }, backgroundOnly = false) {
  const offset = (CANVAS - box) / 2;
  const size = tile ? CANVAS - tile.inset * 2 : 0;
  const background = tile
    ? `${TILE_GRADIENT}<rect x="${tile.inset}" y="${tile.inset}" width="${size}" height="${size}" rx="${tile.radius}" fill="url(#tile)"/>`
    : '';
  const art = backgroundOnly
    ? ''
    : `<svg x="${offset}" y="${offset}" width="${box}" height="${box}" viewBox="${viewBox}">${inner}</svg>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">`
    + `${background}${art}</svg>`;
}

function tauriIcon(input, output) {
  const result = spawnSync('npm', ['run', 'tauri', '--', 'icon', input, '--output', output], {
    cwd: scriptDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function copyTopLevel(from, to, accept) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isFile() && accept(entry.name)) {
      await cp(path.join(from, entry.name), path.join(to, entry.name));
    }
  }
}

async function generate(name, svgSpec, manifest) {
  const sourceDir = path.join(workDir, `${name}-src`);
  const outDir = path.join(workDir, name);
  await mkdir(sourceDir, { recursive: true });
  const svgPath = path.join(sourceDir, 'icon.svg');
  await writeFile(svgPath, composeSvg(svgSpec));
  let input = svgPath;
  if (manifest) {
    await writeFile(path.join(sourceDir, 'android-fg.svg'), composeSvg(PLATFORMS.androidFg));
    await writeFile(path.join(sourceDir, 'android-bg.svg'), composeSvg(PLATFORMS.ios, true));
    input = path.join(sourceDir, 'manifest.json');
    await writeFile(input, JSON.stringify(manifest, null, 2));
  }
  tauriIcon(input, outDir);
  return outDir;
}

await rm(workDir, { recursive: true, force: true });
await rm(iconsDir, { recursive: true, force: true });

const windowsOut = await generate('windows', PLATFORMS.windows);
await copyTopLevel(windowsOut, path.join(iconsDir, 'windows'), (file) => !file.endsWith('.icns'));

const linuxOut = await generate('linux', PLATFORMS.linux);
await copyTopLevel(linuxOut, path.join(iconsDir, 'linux'), (file) => file.endsWith('.png'));

const macosOut = await generate('macos', PLATFORMS.macos);
await copyTopLevel(macosOut, path.join(iconsDir, 'macos'), (file) => file === 'icon.icns');

const mobileOut = await generate('mobile', PLATFORMS.ios, {
  default: 'icon.svg',
  bg_color: BACKGROUND,
  ios_color: BACKGROUND,
  android_fg: 'android-fg.svg',
  android_bg: 'android-bg.svg',
  android_fg_scale: 100,
});
await cp(path.join(mobileOut, 'android'), path.join(iconsDir, 'android'), { recursive: true });
await cp(path.join(mobileOut, 'ios'), path.join(iconsDir, 'ios'), { recursive: true });

await rm(workDir, { recursive: true, force: true });
console.log(`Icons written to ${iconsDir}`);

await rm(workDir, { recursive: true, force: true });
console.log(`Icons for ${platforms.join(', ')} written to ${iconsDir}`);
