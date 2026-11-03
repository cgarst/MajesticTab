// Generates Steam Big Picture and Steam Grid artwork assets
// Output files are prefixed with grid, hero, logo, or icon in docs/img/steam/
// (override with --out-dir <path>)
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..', '..');
const sourceSvg = path.join(rootDir, 'support', 'branding', 'icon_v3.svg');
const outDirArg = process.argv.indexOf('--out-dir');
const outDir = outDirArg > -1
  ? path.resolve(process.argv[outDirArg + 1])
  : path.join(rootDir, 'docs', 'img', 'steam');

const require = createRequire(path.join(rootDir, 'build', 'tauri', 'package.json'));
const { Resvg } = require('@resvg/resvg-js');
const { zipSync, strToU8 } = require('fflate');

const source = await readFile(sourceSvg, 'utf8');
const viewBox = /viewBox="([^"]+)"/.exec(source)?.[1];
const inner = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(source)?.[1];
if (!viewBox || inner === undefined) throw new Error(`Could not parse ${sourceSvg}`);

// Match font-family and weights from src/style.css (.brand-title)
const FONT_FAMILY = "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// Flat finish tokens (Mystic Dream): --ground and --accent-text. No gradients, glow or hairlines.

function composeGridVertical(w = 600, h = 900) {
  const scale = w / 600;
  const iconSize = 280 * scale;
  const iconX = (w - iconSize) / 2;
  const iconY = 190 * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <rect width="100%" height="100%" fill="#ffffff"/>
    <svg x="${iconX}" y="${iconY}" width="${iconSize}" height="${iconSize}" viewBox="${viewBox}">${inner}</svg>
    <text x="${w / 2}" y="${575 * scale}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="${48 * scale}" font-weight="700" letter-spacing="-0.01em" fill="#111724">Majestic<tspan fill="#2f4066">Tab</tspan></text>
  </svg>`;
}

function composeGridHorizontal(w = 920, h = 430) {
  const scale = w / 920;
  const iconSize = 220 * scale;
  const iconX = 75 * scale;
  const iconY = (h - iconSize) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <rect width="100%" height="100%" fill="#ffffff"/>
    <svg x="${iconX}" y="${iconY}" width="${iconSize}" height="${iconSize}" viewBox="${viewBox}">${inner}</svg>
    <text x="${340 * scale}" y="${230 * scale}" font-family="${FONT_FAMILY}" font-size="${64 * scale}" font-weight="700" letter-spacing="-0.01em" fill="#111724">Majestic<tspan fill="#2f4066">Tab</tspan></text>
  </svg>`;
}

function composeHero(w = 3840, h = 1240) {
  const scale = w / 1920;
  const iconSize = 460 * scale;
  const iconX = w - iconSize - 220 * scale;
  // No logo here: Steam overlays logo_1280x720.png on the hero; the glow stays where the mark used to sit.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <rect width="100%" height="100%" fill="#ffffff"/>
  </svg>`;
}

// Transparent overlay logo for Steam Hero view (16:9 canvas). The artwork is scaled so its
// bounding box fills the whole canvas, since Steam sizes and positions the logo from the image bounds.
function composeLogo(w = 1280, h = 720) {
  const scale = w / 1280;
  const iconSize = 240 * scale;
  const totalWidth = iconSize + 35 * scale + 620 * scale;
  const startX = (w - totalWidth) / 2;
  const iconY = (h - iconSize) / 2;
  const content = `<svg x="${startX}" y="${iconY}" width="${iconSize}" height="${iconSize}" viewBox="${viewBox}">${inner}</svg>
    <text x="${startX + iconSize + 35 * scale}" y="${h / 2 + 20 * scale}" font-family="${FONT_FAMILY}" font-size="${84 * scale}" font-weight="700" letter-spacing="-0.01em" fill="#111724">Majestic<tspan fill="#2f4066">Tab</tspan></text>
    <text x="${startX + iconSize + 38 * scale}" y="${h / 2 + 75 * scale}" font-family="${FONT_FAMILY}" font-size="${22 * scale}" font-weight="600" fill="rgba(255,255,255,0.6)" >Guitar tab viewer</text>`;
  const wrap = (transform) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <g${transform ? ` transform="${transform}"` : ''}>${content}</g>
  </svg>`;
  // Measure the painted pixels (glyph metrics from innerBBox are slightly loose).
  const probe = new Resvg(wrap('')).render();
  const { width: pw, height: ph, pixels } = probe;
  let x0 = pw, y0 = ph, x1 = -1, y1 = -1;
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      if (pixels[(y * pw + x) * 4 + 3] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) throw new Error('Could not measure logo bounds');
  const box = { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
  const fit = Math.min(w / box.width, h / box.height);
  const tx = (w - box.width * fit) / 2 - box.x * fit;
  const ty = (h - box.height * fit) / 2 - box.y * fit;
  return wrap(`translate(${tx} ${ty}) scale(${fit})`);
}

// Transparent square app icon for Steam Big Picture list / desktop shortcut
function composeIcon(size = 512) {
  const pad = size * 0.06;
  const innerSize = size - pad * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <svg x="${pad}" y="${pad}" width="${innerSize}" height="${innerSize}" viewBox="${viewBox}">${inner}</svg>
  </svg>`;
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const assets = [
  // 1. Grid (Capsules)
  ['grid_600x900.png', composeGridVertical(600, 900)],
  ['grid_920x430.png', composeGridHorizontal(920, 430)],

  // 2. Hero (Library Banner)
  ['hero_3840x1240.png', composeHero(3840, 1240)],

  // 3. Logo (Transparent Overlay)
  ['logo_1280x720.png', composeLogo(1280, 720)],

  // 4. Icon (Square App Icon)
  ['icon_512x512.png', composeIcon(512)],
];

const zipEntries = {};

for (const [file, svg] of assets) {
  const resvg = new Resvg(svg);
  const png = resvg.render().asPng();
  await writeFile(path.join(outDir, file), png);
  zipEntries[file] = png;
}

const readmeText = `MajesticTab - Steam Big Picture & Steam Deck Custom Artwork
===========================================================
Custom artwork assets for adding MajesticTab to Steam / Steam Deck Big Picture mode.

Files included:
- grid_600x900.png    -> Steam Capsule / Portrait Grid (Library view)
- grid_920x430.png    -> Steam Banner / Wide Grid (Recent games view)
- hero_3840x1240.png  -> Steam Hero Background (Game details header)
- logo_1280x720.png   -> Steam Logo Overlay (Transparent title art)
- icon_512x512.png    -> Steam shortcut icon

How to apply custom artwork in Steam Desktop / Steam Deck:
1. Open Steam and right-click MajesticTab in your Library (or click the Settings gear icon).
2. Choose "Properties" -> click the icon square to select "icon_512x512.png".
3. Right-click the game hero background -> "Set Custom Background" -> choose "hero_3840x1240.png".
4. Right-click the game logo area -> "Set Custom Logo" -> choose "logo_1280x720.png".
5. In your Library grid view, right-click the MajesticTab poster -> "Manage" -> "Set custom artwork" -> choose "grid_600x900.png" (and "grid_920x430.png" when prompted for wide grid).
`;

zipEntries['README.txt'] = strToU8(readmeText);

const zipBuffer = zipSync(zipEntries);
const zipFileName = 'steam_deck_artwork.zip';
await writeFile(path.join(outDir, zipFileName), zipBuffer);

console.log(`Steam Big Picture & Grid artwork successfully generated in ${outDir}:`);
console.log('  - Grid: grid_600x900.png (vertical), grid_920x430.png (horizontal)');
console.log('  - Hero: hero_3840x1240.png');
console.log('  - Logo: logo_1280x720.png');
console.log('  - Icon: icon_512x512.png');
console.log(`  - Zip:  ${zipFileName} (${zipBuffer.byteLength} bytes)`);
