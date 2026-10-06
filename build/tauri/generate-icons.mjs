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

function tauriIcon(input, output, extraArgs = []) {
  const result = spawnSync('npm', ['run', 'tauri', '--', 'icon', input, '--output', output, ...extraArgs], {
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

async function generate(name, svgSpec, manifest, extraArgs = []) {
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
  tauriIcon(input, outDir, extraArgs);
  return outDir;
}

// `tauri icon --png` skips every other format, so desktop targets only rasterize what they need.
function generatePngs(name, svgSpec, sizes) {
  return generate(name, svgSpec, undefined, ['--png', sizes.join(',')]);
}

const pngSize = (dir, size) => readFile(path.join(dir, `${size}x${size}.png`));

// ICO entries may embed PNG data directly (Vista+).
async function buildIco(dir, sizes) {
  const images = await Promise.all(sizes.map((size) => pngSize(dir, size)));
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, i) => {
    const entry = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(images[i].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += images[i].length;
  });
  return Buffer.concat([header, ...images]);
}

// Each ICNS chunk type maps to a PNG pixel size (the @2x types reuse the next size up).
const ICNS_TYPES = [
  ['icp4', 16], ['ic11', 32], ['icp5', 32], ['ic12', 64], ['ic07', 128],
  ['ic13', 256], ['ic08', 256], ['ic14', 512], ['ic09', 512], ['ic10', 1024],
];

async function buildIcns(dir) {
  const chunks = await Promise.all(ICNS_TYPES.map(async ([type, size]) => {
    const data = await pngSize(dir, size);
    const header = Buffer.alloc(8);
    header.write(type, 0, 'ascii');
    header.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([header, data]);
  }));
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

// Each generator writes only its own icons/<platform>/ directory.
const GENERATORS = {
  async windows() {
    const out = await generatePngs('windows', PLATFORMS.windows, ICO_SIZES);
    const target = path.join(iconsDir, 'windows');
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'icon.ico'), await buildIco(out, ICO_SIZES));
    console.log(`  ICO Creating icon.ico (${ICO_SIZES.join(', ')})`);
    for (const size of [32, 128, 256]) {
      await cp(path.join(out, `${size}x${size}.png`), path.join(target, `${size}x${size}.png`));
    }
  },
  async linux() {
    const out = await generatePngs('linux', PLATFORMS.linux, [32, 128, 256, 512]);
    await copyTopLevel(out, path.join(iconsDir, 'linux'), (file) => file.endsWith('.png'));
  },
  async macos() {
    const sizes = [...new Set(ICNS_TYPES.map(([, size]) => size))];
    const out = await generatePngs('macos', PLATFORMS.macos, sizes);
    const target = path.join(iconsDir, 'macos');
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'icon.icns'), await buildIcns(out));
    console.log('  ICNS Creating icon.icns');
  },
  // `tauri icon` always emits both mobile sets; keep only the one requested.
  async android() {
    const out = await generateMobile();
    await cp(path.join(out, 'android'), path.join(iconsDir, 'android'), { recursive: true });
  },
  async ios() {
    const out = await generateMobile();
    await cp(path.join(out, 'ios'), path.join(iconsDir, 'ios'), { recursive: true });
  },
};

function generateMobile() {
  return generate('mobile', PLATFORMS.ios, {
    default: 'icon.svg',
    bg_color: BACKGROUND,
    ios_color: BACKGROUND,
    android_fg: 'android-fg.svg',
    android_bg: 'android-bg.svg',
    android_fg_scale: 100,
  });
}

const HOST_PLATFORMS = { win32: 'windows', darwin: 'macos', linux: 'linux' };
const requested = process.argv.slice(2);
const platforms = requested.length > 0 ? requested : [HOST_PLATFORMS[process.platform]].filter(Boolean);
for (const name of platforms) {
  if (!GENERATORS[name]) {
    console.error(`Unknown icon platform "${name}". Use: ${Object.keys(GENERATORS).join(', ')}`);
    process.exit(2);
  }
}

for (const name of platforms) {
  await rm(workDir, { recursive: true, force: true });
  await rm(path.join(iconsDir, name), { recursive: true, force: true });
  await GENERATORS[name]();
}

await rm(workDir, { recursive: true, force: true });
console.log(`Icons for ${platforms.join(', ')} written to ${iconsDir}`);
