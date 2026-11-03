// Generates Microsoft Store listing logos: 9:16-style poster art (720x1080) and 1:1 box art (1080x1080).
// Same brand look as generate-steam-artwork.mjs. Output: support/store/msstore/logos/ (gitignored),
// override with --out-dir <path>. Upload them under "Store logos" in Partner Center.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..', '..');
const outDirArg = process.argv.indexOf('--out-dir');
const outDir = outDirArg > -1
  ? path.resolve(process.argv[outDirArg + 1])
  : path.join(rootDir, 'support', 'store', 'msstore', 'logos');

const { Resvg } = createRequire(path.join(rootDir, 'build', 'tauri', 'package.json'))('@resvg/resvg-js');

const source = await readFile(path.join(rootDir, 'support', 'branding', 'icon_v3.svg'), 'utf8');
const viewBox = /viewBox="([^"]+)"/.exec(source)?.[1];
const inner = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(source)?.[1];
if (!viewBox || inner === undefined) throw new Error('Could not parse support/branding/icon_v3.svg');

const FONT_FAMILY = "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// Flat finish tokens (Mystic Dream): --ground and --accent-text. No gradients, glow or hairlines.
const DEFS = () => '';

// One layout for both shapes: icon + wordmark + tagline centred over the glow. `iconY`, `iconSize`, text
// baselines are fractions of the canvas so the 2:3 and 1:1 versions keep the same proportions.
function compose({ id, w, h, iconSize, iconY, titleY, titleSize, tagY, tagSize, staffY }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    
    <rect width="100%" height="100%" fill="#ffffff"/>
    <svg x="${(w - iconSize) / 2}" y="${iconY}" width="${iconSize}" height="${iconSize}" viewBox="${viewBox}">${inner}</svg>
    <text x="${w / 2}" y="${titleY}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="${titleSize}" font-weight="700" letter-spacing="-0.01em" fill="#111724">Majestic<tspan fill="#2f4066">Tab</tspan></text>
    <text x="${w / 2}" y="${tagY}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="${tagSize}" font-weight="600" fill="#4a5568">Guitar tab reader</text>
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
