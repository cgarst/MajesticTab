// Generates Microsoft Store listing logos: 9:16-style poster art (720x1080) and 1:1 box art (1080x1080).
// Same brand look as generate-steam-artwork.mjs. Output: store-screenshots/msstore/logos/ (gitignored),
// override with --out-dir <path>. Upload them under "Store logos" in Partner Center.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const outDirArg = process.argv.indexOf('--out-dir');
const outDir = outDirArg > -1
  ? path.resolve(process.argv[outDirArg + 1])
  : path.join(rootDir, 'store-screenshots', 'msstore', 'logos');

const { Resvg } = createRequire(path.join(scriptDir, 'tauri', 'package.json'))('@resvg/resvg-js');

const source = await readFile(path.join(rootDir, 'icons', 'icon_v2_mystic.svg'), 'utf8');
const viewBox = /viewBox="([^"]+)"/.exec(source)?.[1];
const inner = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(source)?.[1];
if (!viewBox || inner === undefined) throw new Error('Could not parse icons/icon_v2_mystic.svg');

const FONT_FAMILY = "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// Mystic Dream accent gradient (app/style.css --accent-gradient) and Steam artwork background.
const DEFS = (id) => `
  <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="100%">
    <stop offset="0%" stop-color="#9333ea"/><stop offset="50%" stop-color="#06b6d4"/><stop offset="100%" stop-color="#10b981"/>
  </linearGradient>
  <linearGradient id="bg_${id}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#130d24"/><stop offset="50%" stop-color="#0a0614"/><stop offset="100%" stop-color="#050409"/>
  </linearGradient>
  <radialGradient id="glow_${id}" cx="50%" cy="45%" r="50%">
    <stop offset="0%" stop-color="#9333ea" stop-opacity="0.4"/>
    <stop offset="50%" stop-color="#06b6d4" stop-opacity="0.15"/>
    <stop offset="100%" stop-color="#050409" stop-opacity="0"/>
  </radialGradient>`;

const staff = (w, h, y0, gap, stroke) => [0, 1, 2, 3, 4].map((i) =>
  `<line x1="0" y1="${y0 + i * gap}" x2="${w}" y2="${y0 + i * gap}" stroke="rgba(255,255,255,0.04)" stroke-width="${stroke}"/>`).join('');

// One layout for both shapes: icon + wordmark + tagline centred over the glow. `iconY`, `iconSize`, text
// baselines are fractions of the canvas so the 2:3 and 1:1 versions keep the same proportions.
function compose({ id, w, h, iconSize, iconY, titleY, titleSize, tagY, tagSize, staffY }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs>${DEFS(id)}</defs>
    <rect width="100%" height="100%" fill="url(#bg_${id})"/>
    <circle cx="${w / 2}" cy="${iconY + iconSize / 2}" r="${iconSize * 0.95}" fill="url(#glow_${id})"/>
    ${staff(w, h, staffY, h * 0.022, w / 400)}
    <svg x="${(w - iconSize) / 2}" y="${iconY}" width="${iconSize}" height="${iconSize}" viewBox="${viewBox}">${inner}</svg>
    <text x="${w / 2}" y="${titleY}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="${titleSize}" font-weight="700" letter-spacing="-0.01em" fill="#ffffff">Majestic<tspan fill="url(#accent)">Tab</tspan></text>
    <text x="${w / 2}" y="${tagY}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="${tagSize}" font-weight="600" letter-spacing="${tagSize * 0.27}" fill="rgba(255,255,255,0.6)">GUITAR TAB VIEWER</text>
  </svg>`;
}

const assets = [
  ['poster-art-720x1080.png', compose({ id: 'poster', w: 720, h: 1080, iconSize: 336, iconY: 228, titleY: 690, titleSize: 58, tagY: 748, tagSize: 22, staffY: 840 })],
  ['box-art-1080x1080.png', compose({ id: 'box', w: 1080, h: 1080, iconSize: 480, iconY: 150, titleY: 770, titleSize: 96, tagY: 850, tagSize: 30, staffY: 900 })],
];

await mkdir(outDir, { recursive: true });
for (const [file, svg] of assets) {
  const png = new Resvg(svg).render();
  await writeFile(path.join(outDir, file), png.asPng());
  console.log(`  wrote ${path.join(outDir, file)} (${png.width}x${png.height})`);
}
