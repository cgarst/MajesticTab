// Generates Steam Big Picture and Steam Grid artwork assets
// Output files are prefixed with grid, hero, logo, or icon in img/steam/
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const sourceSvg = path.join(rootDir, 'icons', 'icon_v2_mystic.svg');
const outDir = path.join(rootDir, 'img', 'steam');

const require = createRequire(path.join(scriptDir, 'tauri', 'package.json'));
const { Resvg } = require('@resvg/resvg-js');
const { zipSync, strToU8 } = require('fflate');

const source = await readFile(sourceSvg, 'utf8');
const viewBox = /viewBox="([^"]+)"/.exec(source)?.[1];
const inner = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(source)?.[1];
if (!viewBox || inner === undefined) throw new Error(`Could not parse ${sourceSvg}`);

// Match font-family and weights from app/style.css (.brand-title)
const FONT_FAMILY = "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// Mystic Dream default theme accent gradient from app/style.css:
// --accent-gradient: linear-gradient(135deg, #9333ea 0%, #06b6d4 50%, #10b981 100%);
const GRADIENT_DEFS = `
  <linearGradient id="accentGrad" x1="0%" y1="0%" x2="100%" y2="100%">
    <stop offset="0%" stop-color="#9333ea"/>
    <stop offset="50%" stop-color="#06b6d4"/>
    <stop offset="100%" stop-color="#10b981"/>
  </linearGradient>
`;

function composeGridVertical(w = 600, h = 900) {
  const scale = w / 600;
  const iconSize = 280 * scale;
  const iconX = (w - iconSize) / 2;
  const iconY = 190 * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs>
      ${GRADIENT_DEFS}
      <linearGradient id="bgV_${w}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#130d24"/>
        <stop offset="50%" stop-color="#0a0614"/>
        <stop offset="100%" stop-color="#050409"/>
      </linearGradient>
      <radialGradient id="glowV_${w}" cx="50%" cy="42%" r="50%">
        <stop offset="0%" stop-color="#9333ea" stop-opacity="0.4"/>
        <stop offset="50%" stop-color="#06b6d4" stop-opacity="0.15"/>
        <stop offset="100%" stop-color="#050409" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#bgV_${w})"/>
    <circle cx="${w / 2}" cy="${iconY + iconSize / 2}" r="${260 * scale}" fill="url(#glowV_${w})"/>
    <g stroke="rgba(255,255,255,0.04)" stroke-width="${1.5 * scale}">
      <line x1="0" y1="${700 * scale}" x2="${w}" y2="${700 * scale}"/>
      <line x1="0" y1="${720 * scale}" x2="${w}" y2="${720 * scale}"/>
      <line x1="0" y1="${740 * scale}" x2="${w}" y2="${740 * scale}"/>
      <line x1="0" y1="${760 * scale}" x2="${w}" y2="${760 * scale}"/>
      <line x1="0" y1="${780 * scale}" x2="${w}" y2="${780 * scale}"/>
      <line x1="0" y1="${800 * scale}" x2="${w}" y2="${800 * scale}"/>
    </g>
    <svg x="${iconX}" y="${iconY}" width="${iconSize}" height="${iconSize}" viewBox="${viewBox}">${inner}</svg>
    <text x="${w / 2}" y="${575 * scale}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="${48 * scale}" font-weight="700" letter-spacing="-0.01em" fill="#ffffff">Majestic<tspan fill="url(#accentGrad)">Tab</tspan></text>
    <text x="${w / 2}" y="${620 * scale}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="${14 * scale}" font-weight="600" fill="rgba(255,255,255,0.5)" letter-spacing="${6 * scale}">GUITAR TAB VIEWER</text>
  </svg>`;
}

function composeGridHorizontal(w = 920, h = 430) {
  const scale = w / 920;
  const iconSize = 220 * scale;
  const iconX = 75 * scale;
  const iconY = (h - iconSize) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs>
      ${GRADIENT_DEFS}
      <linearGradient id="bgH_${w}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#150e26"/>
        <stop offset="50%" stop-color="#0a0614"/>
        <stop offset="100%" stop-color="#050409"/>
      </linearGradient>
      <radialGradient id="glowH_${w}" cx="25%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#9333ea" stop-opacity="0.4"/>
        <stop offset="50%" stop-color="#06b6d4" stop-opacity="0.15"/>
        <stop offset="100%" stop-color="#050409" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#bgH_${w})"/>
    <circle cx="${iconX + iconSize / 2}" cy="${h / 2}" r="${220 * scale}" fill="url(#glowH_${w})"/>
    <g stroke="rgba(255,255,255,0.035)" stroke-width="${1.5 * scale}">
      <line x1="0" y1="${320 * scale}" x2="${w}" y2="${320 * scale}"/>
      <line x1="0" y1="${340 * scale}" x2="${w}" y2="${340 * scale}"/>
      <line x1="0" y1="${360 * scale}" x2="${w}" y2="${360 * scale}"/>
      <line x1="0" y1="${380 * scale}" x2="${w}" y2="${380 * scale}"/>
      <line x1="0" y1="${400 * scale}" x2="${w}" y2="${400 * scale}"/>
    </g>
    <svg x="${iconX}" y="${iconY}" width="${iconSize}" height="${iconSize}" viewBox="${viewBox}">${inner}</svg>
    <text x="${340 * scale}" y="${230 * scale}" font-family="${FONT_FAMILY}" font-size="${64 * scale}" font-weight="700" letter-spacing="-0.01em" fill="#ffffff">Majestic<tspan fill="url(#accentGrad)">Tab</tspan></text>
    <text x="${345 * scale}" y="${278 * scale}" font-family="${FONT_FAMILY}" font-size="${18 * scale}" font-weight="600" fill="rgba(255,255,255,0.5)" letter-spacing="${5 * scale}">GUITAR TAB VIEWER</text>
  </svg>`;
}

function composeHero(w = 3840, h = 1240) {
  const scale = w / 1920;
  const iconSize = 460 * scale;
  const iconX = w - iconSize - 220 * scale;
  const iconY = (h - iconSize) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs>
      ${GRADIENT_DEFS}
      <linearGradient id="bgHero_${w}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#18102e"/>
        <stop offset="40%" stop-color="#0e081c"/>
        <stop offset="100%" stop-color="#050409"/>
      </linearGradient>
      <radialGradient id="glowRight_${w}" cx="80%" cy="50%" r="45%">
        <stop offset="0%" stop-color="#9333ea" stop-opacity="0.4"/>
        <stop offset="40%" stop-color="#06b6d4" stop-opacity="0.2"/>
        <stop offset="100%" stop-color="#050409" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="glowLeft_${w}" cx="15%" cy="50%" r="40%">
        <stop offset="0%" stop-color="#6366f1" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="#050409" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#bgHero_${w})"/>
    <rect width="100%" height="100%" fill="url(#glowLeft_${w})"/>
    <circle cx="${iconX + iconSize / 2}" cy="${h / 2}" r="${iconSize * 0.9}" fill="url(#glowRight_${w})"/>
    <g stroke="rgba(255,255,255,0.035)" stroke-width="${2 * scale}">
      <line x1="0" y1="${h - 220 * scale}" x2="${w}" y2="${h - 220 * scale}"/>
      <line x1="0" y1="${h - 180 * scale}" x2="${w}" y2="${h - 180 * scale}"/>
      <line x1="0" y1="${h - 140 * scale}" x2="${w}" y2="${h - 140 * scale}"/>
      <line x1="0" y1="${h - 100 * scale}" x2="${w}" y2="${h - 100 * scale}"/>
      <line x1="0" y1="${h - 60 * scale}" x2="${w}" y2="${h - 60 * scale}"/>
    </g>
    <svg x="${iconX}" y="${iconY}" width="${iconSize}" height="${iconSize}" viewBox="${viewBox}">${inner}</svg>
  </svg>`;
}

// Transparent overlay logo for Steam Hero view (16:9 canvas)
function composeLogo(w = 1280, h = 720) {
  const scale = w / 1280;
  const iconSize = 240 * scale;
  const totalWidth = iconSize + 35 * scale + 620 * scale;
  const startX = (w - totalWidth) / 2;
  const iconY = (h - iconSize) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs>
      ${GRADIENT_DEFS}
    </defs>
    <svg x="${startX}" y="${iconY}" width="${iconSize}" height="${iconSize}" viewBox="${viewBox}">${inner}</svg>
    <text x="${startX + iconSize + 35 * scale}" y="${h / 2 + 20 * scale}" font-family="${FONT_FAMILY}" font-size="${84 * scale}" font-weight="700" letter-spacing="-0.01em" fill="#ffffff">Majestic<tspan fill="url(#accentGrad)">Tab</tspan></text>
    <text x="${startX + iconSize + 38 * scale}" y="${h / 2 + 75 * scale}" font-family="${FONT_FAMILY}" font-size="${22 * scale}" font-weight="600" fill="rgba(255,255,255,0.6)" letter-spacing="${6 * scale}">GUITAR TAB VIEWER</text>
  </svg>`;
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
