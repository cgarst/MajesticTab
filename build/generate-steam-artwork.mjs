// Generates Steam Big Picture artwork (capsules and hero banners)
// Output is written to img/steam/
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const sourceSvg = path.join(rootDir, 'icons', 'icon_v2_mystic.svg');
const outDir = path.join(rootDir, 'img', 'steam');

const require = createRequire(path.join(scriptDir, 'tauri', 'package.json'));
const { Resvg } = require('@resvg/resvg-js');

const source = await readFile(sourceSvg, 'utf8');
const viewBox = /viewBox="([^"]+)"/.exec(source)?.[1];
const inner = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(source)?.[1];
if (!viewBox || inner === undefined) throw new Error(`Could not parse ${sourceSvg}`);

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
    <text x="${w / 2}" y="620" text-anchor="middle" font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="14" font-weight="600" fill="rgba(255,255,255,0.5)" letter-spacing="6">GUITAR TAB VIEWER</text>
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
    <text x="${345 * scale}" y="${278 * scale}" font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="${18 * scale}" font-weight="600" fill="rgba(255,255,255,0.5)" letter-spacing="${5 * scale}">GUITAR TAB VIEWER</text>
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
    <text x="${185 * scale}" y="${h / 2 + 105 * scale}" font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="${28 * scale}" font-weight="600" fill="rgba(255,255,255,0.55)" letter-spacing="${8 * scale}">GUITAR TAB VIEWER</text>
  </svg>`;
}

await mkdir(outDir, { recursive: true });

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
  await writeFile(path.join(outDir, file), png);
}

console.log(`Steam Big Picture artwork successfully generated in ${outDir}:`);
console.log('  - Capsules: 460x215 (header), 920x430 (main), 600x900 (library portrait)');
console.log('  - Hero Images: 1920x620 (hero), 3840x1240 (hero 2x/4K)');
