import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Resvg } from '@resvg/resvg-js';

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

function composeSteamVerticalCapsule(w = 600, h = 900) {
  const iconSize = 280;
  const iconX = (w - iconSize) / 2;
  const iconY = 190;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs>
      <linearGradient id="steamBgV" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#130d24"/>
        <stop offset="50%" stop-color="#0a0614"/>
        <stop offset="100%" stop-color="#050409"/>
      </linearGradient>
      <radialGradient id="steamGlowV" cx="50%" cy="42%" r="50%">
        <stop offset="0%" stop-color="#9333ea" stop-opacity="0.4"/>
        <stop offset="50%" stop-color="#06b6d4" stop-opacity="0.15"/>
        <stop offset="100%" stop-color="#050409" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="steamTextAccentV" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#06b6d4"/>
        <stop offset="100%" stop-color="#10b981"/>
      </linearGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#steamBgV)"/>
    <circle cx="${w / 2}" cy="${iconY + iconSize / 2}" r="260" fill="url(#steamGlowV)"/>
    <g stroke="rgba(255,255,255,0.04)" stroke-width="1.5">
      <line x1="0" y1="700" x2="${w}" y2="700"/>
      <line x1="0" y1="720" x2="${w}" y2="720"/>
      <line x1="0" y1="740" x2="${w}" y2="740"/>
      <line x1="0" y1="760" x2="${w}" y2="760"/>
      <line x1="0" y1="780" x2="${w}" y2="780"/>
      <line x1="0" y1="800" x2="${w}" y2="800"/>
    </g>
    <svg x="${iconX}" y="${iconY}" width="${iconSize}" height="${iconSize}" viewBox="${viewBox}">${inner}</svg>
    <text x="${w / 2}" y="575" text-anchor="middle" font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="48" font-weight="800" fill="#ffffff" letter-spacing="1">Majestic<tspan fill="url(#steamTextAccentV)">Tab</tspan></text>
    <text x="${w / 2}" y="620" text-anchor="middle" font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="14" font-weight="600" fill="rgba(255,255,255,0.5)" letter-spacing="6">GUITAR PRO &amp; PDF VIEWER</text>
  </svg>`;
}

function composeSteamHorizontalCapsule(w = 920, h = 430) {
  const scale = w / 920;
  const iconSize = 220 * scale;
  const iconX = 75 * scale;
  const iconY = (h - iconSize) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs>
      <linearGradient id="steamBgH_${w}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#150e26"/>
        <stop offset="50%" stop-color="#0a0614"/>
        <stop offset="100%" stop-color="#050409"/>
      </linearGradient>
      <radialGradient id="steamGlowH_${w}" cx="25%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#9333ea" stop-opacity="0.4"/>
        <stop offset="50%" stop-color="#06b6d4" stop-opacity="0.15"/>
        <stop offset="100%" stop-color="#050409" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="steamTextAccentH_${w}" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#06b6d4"/>
        <stop offset="100%" stop-color="#10b981"/>
      </linearGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#steamBgH_${w})"/>
    <circle cx="${iconX + iconSize / 2}" cy="${h / 2}" r="${220 * scale}" fill="url(#steamGlowH_${w})"/>
    <g stroke="rgba(255,255,255,0.035)" stroke-width="${1.5 * scale}">
      <line x1="0" y1="${320 * scale}" x2="${w}" y2="${320 * scale}"/>
      <line x1="0" y1="${340 * scale}" x2="${w}" y2="${340 * scale}"/>
      <line x1="0" y1="${360 * scale}" x2="${w}" y2="${360 * scale}"/>
      <line x1="0" y1="${380 * scale}" x2="${w}" y2="${380 * scale}"/>
      <line x1="0" y1="${400 * scale}" x2="${w}" y2="${400 * scale}"/>
    </g>
    <svg x="${iconX}" y="${iconY}" width="${iconSize}" height="${iconSize}" viewBox="${viewBox}">${inner}</svg>
    <text x="${340 * scale}" y="${230 * scale}" font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="${64 * scale}" font-weight="800" fill="#ffffff" letter-spacing="${1 * scale}">Majestic<tspan fill="url(#steamTextAccentH_${w})">Tab</tspan></text>
    <text x="${345 * scale}" y="${278 * scale}" font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="${18 * scale}" font-weight="600" fill="rgba(255,255,255,0.5)" letter-spacing="${5 * scale}">GUITAR PRO &amp; PDF VIEWER</text>
  </svg>`;
}

function composeSteamHero(w = 3840, h = 1240) {
  const scale = w / 1920;
  const iconSize = 460 * scale;
  const iconX = w - iconSize - 220 * scale;
  const iconY = (h - iconSize) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs>
      <linearGradient id="steamBgHero_${w}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#18102e"/>
        <stop offset="40%" stop-color="#0e081c"/>
        <stop offset="100%" stop-color="#050409"/>
      </linearGradient>
      <radialGradient id="steamGlowRight_${w}" cx="80%" cy="50%" r="45%">
        <stop offset="0%" stop-color="#9333ea" stop-opacity="0.4"/>
        <stop offset="40%" stop-color="#06b6d4" stop-opacity="0.2"/>
        <stop offset="100%" stop-color="#050409" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="steamGlowLeft_${w}" cx="15%" cy="50%" r="40%">
        <stop offset="0%" stop-color="#6366f1" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="#050409" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="steamTextAccentHero_${w}" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#06b6d4"/>
        <stop offset="100%" stop-color="#10b981"/>
      </linearGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#steamBgHero_${w})"/>
    <rect width="100%" height="100%" fill="url(#steamGlowLeft_${w})"/>
    <circle cx="${iconX + iconSize / 2}" cy="${h / 2}" r="${iconSize * 0.9}" fill="url(#steamGlowRight_${w})"/>
    <g stroke="rgba(255,255,255,0.035)" stroke-width="${2 * scale}">
      <line x1="0" y1="${h - 220 * scale}" x2="${w}" y2="${h - 220 * scale}"/>
      <line x1="0" y1="${h - 180 * scale}" x2="${w}" y2="${h - 180 * scale}"/>
      <line x1="0" y1="${h - 140 * scale}" x2="${w}" y2="${h - 140 * scale}"/>
      <line x1="0" y1="${h - 100 * scale}" x2="${w}" y2="${h - 100 * scale}"/>
      <line x1="0" y1="${h - 60 * scale}" x2="${w}" y2="${h - 60 * scale}"/>
    </g>
    <svg x="${iconX}" y="${iconY}" width="${iconSize}" height="${iconSize}" viewBox="${viewBox}">${inner}</svg>
    <text x="${180 * scale}" y="${h / 2 + 25 * scale}" font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="${110 * scale}" font-weight="800" fill="#ffffff" letter-spacing="${2 * scale}">Majestic<tspan fill="url(#steamTextAccentHero_${w})">Tab</tspan></text>
    <text x="${185 * scale}" y="${h / 2 + 105 * scale}" font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="${28 * scale}" font-weight="600" fill="rgba(255,255,255,0.55)" letter-spacing="${8 * scale}">GUITAR PRO &amp; PDF TABLATURE VIEWER</text>
  </svg>`;
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
    const out = await generatePngs('linux', PLATFORMS.linux, [16, 24, 32, 48, 64, 128, 256, 512]);
    const target = path.join(iconsDir, 'linux');
    await copyTopLevel(out, target, (file) => file.endsWith('.png'));
    await writeFile(path.join(target, 'net.zathu.majestictab.svg'), composeSvg(PLATFORMS.linux));
    await GENERATORS.steam();
  },
  async steam() {
    const target = path.join(iconsDir, 'steam');
    await mkdir(target, { recursive: true });
    const artworks = [
      ['capsule_460x215.png', composeSteamHorizontalCapsule(460, 215)],
      ['header.png', composeSteamHorizontalCapsule(460, 215)],
      ['capsule_920x430.png', composeSteamHorizontalCapsule(920, 430)],
      ['header_2x.png', composeSteamHorizontalCapsule(920, 430)],
      ['capsule_main.png', composeSteamHorizontalCapsule(920, 430)],
      ['capsule_600x900.png', composeSteamVerticalCapsule(600, 900)],
      ['library_600x900.png', composeSteamVerticalCapsule(600, 900)],
      ['poster.png', composeSteamVerticalCapsule(600, 900)],
      ['hero_1920x620.png', composeSteamHero(1920, 620)],
      ['library_hero.png', composeSteamHero(1920, 620)],
      ['hero_3840x1240.png', composeSteamHero(3840, 1240)],
      ['library_hero_2x.png', composeSteamHero(3840, 1240)],
    ];
    for (const [file, svg] of artworks) {
      const resvg = new Resvg(svg);
      const png = resvg.render().asPng();
      await writeFile(path.join(target, file), png);
    }
    console.log('  Steam Big Picture artwork created:');
    console.log('    - Capsules: 460x215, 920x430, 600x900');
    console.log('    - Hero Images: 1920x620, 3840x1240');
  },
  async macos() {
    const sizes = [...new Set(ICNS_TYPES.map(([, size]) => size))];
    const out = await generatePngs('macos', PLATFORMS.macos, sizes);
    const target = path.join(iconsDir, 'macos');
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'icon.icns'), await buildIcns(out));
    console.log('  ICNS Creating icon.icns');
    await cp(path.join(out, '512x512.png'), path.join(target, '512x512.png'));
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
