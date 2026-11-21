#!/usr/bin/env node
// Captures the landing page's pictures from the real app: docs/img/app/*.webp and the hero loop (webm, mp4, poster).
//
// Needs: a dev server that sends CORS headers serving the repo root, an Edge/Chrome started with --remote-debugging-port,
// Node 22+ and ffmpeg (hero loop only). See "Local Dev Server and Debug Edge" in AGENTS.md.
//   node support/tools/landing/capture.mjs [--port 9344] [--base http://localhost:8765] [--only reader,practice] [--no-video]
// The stills show only the repo's own fixture, `Duo No 2 In G Major.gp5`; the hero loop also shows tests/Prelude.mpak and tests/Equinox.mpak.
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '../../../docs/img/app');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const PORT = arg('port', '9344');
const BASE = arg('base', 'http://localhost:8765');
const ONLY = arg('only', '') ? arg('only').split(',') : null;
const FIXTURE = 'Duo No 2 In G Major.gp5';
const URL_ = `${BASE}/src/?test=${encodeURIComponent(FIXTURE)}`;
mkdirSync(out, { recursive: true });

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = targets.find(t => t.type === 'page' && t.url.includes(new URL(BASE).host));
if (!page) throw new Error('No page target; start Edge with --remote-debugging-port=' + PORT);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map(); const listeners = [];
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? {}); pending.delete(m.id); }
  else listeners.forEach(l => l(m));
});
const cdp = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => (await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// A window the OS considers hidden throttles the app's timers and loading stalls; keep the page in front and focused
await cdp('Page.bringToFront'); await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });

async function open({ w, h, theme, dsf = 2, mobile = false, url = URL_, lib = false }) {
  await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dsf, mobile });
  await cdp('Page.navigate', { url });
  await sleep(1500);
  await ev(`localStorage.setItem('majestictab_theme', ${JSON.stringify(theme)})`);
  await cdp('Page.navigate', { url });
  // wait until the score has finished loading and laying out (loading card gone, pages drawn)
  for (let i = 0; i < 240; i++) {
    if (lib) { if (await ev(`/Artists/.test(document.body.innerText)`)) break; await sleep(500); continue; }
    if (await ev(`!/Loading score|Laying out|Rendering|Parsing/i.test(document.body.innerText) && document.querySelectorAll('.at-surface svg').length > 10 && !!document.querySelector('#viewToggleBtn')?.offsetParent`)) break;
    await sleep(500);
  }
  await sleep(1500);
}
const click = (sel) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
async function shot(name) {
  // The browser-storage banner is for the web app only; the site's pictures show the app without it
  await ev(`document.getElementById('webCtaBanner')?.remove()`); await sleep(300);
  const r = await cdp('Page.captureScreenshot', { format: 'webp', quality: 86 });
  writeFileSync(join(out, name + '.webp'), Buffer.from(r.data, 'base64'));
  console.log('wrote', name + '.webp');
}
const want = n => !ONLY || ONLY.includes(n);

// The Guitar panel picture: the tab (D Standard) rewritten for 7-string standard with a capo
async function guitarFit() {
  const wait = async (js) => { for (let i = 0; i < 30 && !(await ev(js)); i++) await sleep(300); };
  await click('label[for="synthStringCount7"]'); await sleep(2500);
  if (!(await ev(`document.querySelector('#adaptEnableSwitch').checked`))) await click('#adaptEnableSwitch');
  await sleep(1200);
  await ev(`(() => { const s = document.querySelector('#adaptTuningSelect'); s.value = '7-String Standard'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(1500);
  await click('label[for="adaptMethodCapo"]'); await sleep(800);
  await ev(`(() => { const s = document.querySelector('#adaptCapoSelect'); s.value = '2'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await wait(`/Capo \\d/.test(document.querySelector('#adaptSummary')?.textContent || '')`);
  await sleep(1500);
}

// ---- stills: desktop 1440x900 and phone 390x844, Slate Blue (the site's own finish) and Snow White
const PANELS = { view: '#viewToggleBtn', practice: '#practiceToggleBtn', tracks: '#tracksToggleBtn', guitar: '#guitarToggleBtn', tools: '#toolsToggleBtn' };
for (const [suffix, size] of [['', { w: 1440, h: 900 }], ['-phone', { w: 390, h: 844, mobile: true }]]) {
  for (const theme of ['Slate Blue', 'Snow White']) {
    const tag = theme === 'Slate Blue' ? '' : '-snow';
    if (theme === 'Snow White' && !want('snow')) continue;
    await open({ ...size, theme });
    // every reader picture (the score alone and the five button panels) is shot with the fretboard compacted
    await click('#fretboardDockBtn, #fretboardCloseBtn'); await sleep(700);
    if (want('reader')) await shot(`reader${suffix}${tag}`);
    if (theme !== 'Slate Blue') continue;
    for (const [name, sel] of Object.entries(PANELS)) {
      if (!want(name)) continue;
      await click(sel); await sleep(900);
      if (name === 'guitar') await guitarFit();
      await shot(`${name}${suffix}`);
      await click(sel); await sleep(500); // close again
      await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`); await sleep(300);
    }
  }
}

// ---- library: a seeded demo library (invented artists from support/tools/demo_library.json), tunings view
// and the Recording panel (Original) on the fixture score. Seeding replaces whatever songs the debug profile has.
async function seedLibrary() {
  const demo = JSON.parse(readFileSync(join(here, '../demo_library.json'), 'utf8'));
  return ev(`(async () => {
    const m = await import('./libraryStore.js');
    for (const s of await m.getSongsByCollection()) await m.deleteSongFromLibrary(s.id);
    await m.clearRecents();
    const d = ${JSON.stringify(demo)}; let i = 0, k = 0;
    for (const [artist, albums] of Object.entries(d.library)) {
      let year = 2008;
      for (const [album, tracks] of Object.entries(albums)) {
        year += 2; let tn = 1;
        for (const title of tracks) {
          const tuning = d.tunings[i++ % d.tunings.length];
          const song = await m.saveSongToLibrary({ title, artist, album, year, trackNumber: tn++, tunings: [tuning], stringCount: /^7/.test(tuning) ? 7 : 6 });
          k++; if (k % 4 === 0) continue;
          const ft = ['gp', 'gp', 'pdf', 'gp', 'txt'][k % 5], ext = { gp: 'gp5', pdf: 'pdf', txt: 'txt' }[ft];
          await m.addTabOptionToSong(song.id, { name: title + '.' + ext, fileType: ft, tuning, stringCount: song.stringCount, isDefault: true, fileStoreId: 'demo_' + song.id });
        }
      }
    }
    return k; })()`);
}
if (want('library') || want('tunings')) {
  for (const [suffix, size] of [['', { w: 1440, h: 900 }], ['-phone', { w: 390, h: 844, mobile: true }]]) {
    await open({ ...size, theme: 'Slate Blue', url: BASE + '/src/', lib: true });
    if (suffix === '') { console.log('seeded', await seedLibrary(), 'songs'); await cdp('Page.navigate', { url: BASE + '/src/' }); await sleep(2500); }
    for (let i = 0; i < 40 && !(await ev(`/Artists/.test(document.body.innerText)`)); i++) await sleep(500);
    await sleep(1200);
    if (want('library')) await shot(`library${suffix}`);
    if (want('tunings')) {
      await ev(`(() => { const b = [...document.querySelectorAll('button,a')].find(e => /^\\s*Tunings\\s*$/.test(e.textContent) && e.offsetParent); b?.click(); })()`);
      await sleep(1200); await shot(`tunings${suffix}`);
    }
  }
}
if (want('original')) {
  for (const [suffix, size] of [['', { w: 1440, h: 900 }], ['-phone', { w: 390, h: 844, mobile: true }]]) {
    await open({ ...size, theme: 'Slate Blue' });
    await sleep(4000); // let the score finish laying out so the panel can count its bars
    await click('#ytToggleBtn'); await sleep(800);
    await click('#realAudioSourceLocal');
    // with a sheet open the top and the strip must be showing
    console.log('top away with sheet open:', await ev(`document.body.classList.contains('top-away') || document.body.classList.contains('reading-mode')`));
    for (let i = 0; i < 40 && !(await ev(`/of [1-9]\\d* bars synced/.test(document.body.innerText)`)); i++) await sleep(500);
    await sleep(800);
    await shot(`original${suffix}`);
  }
}

// ---- hero loop: tablet portrait, Slate Blue, three parts in turn: Guitar Pro (the fixture), a text tab (tests/Prelude.mpak)
// and a PDF chart with its YouTube recording (tests/Equinox.mpak). The parts are joined with a slide, and the page's Guitar Pro / Text / PDF row follows them through data-segments on the video (written below).
// The two packs are the repo's own test files; they are opened from BASE/tests/ and never copied anywhere.
if (want('hero') && !process.argv.includes('--no-video')) {
  // Rendered at 2x like a real tablet (YouTube's embedded player lays itself out wrongly at 1x: zoomed and cropped); the screencast scales the frames down to W x H
  const W = 820, H = 1100, FADE = 0.6;
  const dir = mkdtempSync(join(tmpdir(), 'mt-hero-'));
  const run = (...a) => { const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...a], { stdio: 'inherit' }); if (r.status) throw new Error('ffmpeg failed'); };
  const frames = [];
  listeners.push(m => {
    if (m.method !== 'Page.screencastFrame' || !frames.rec) return;
    const f = join(dir, `${frames.rec}-${String(frames.length).padStart(6, '0')}.jpg`);
    writeFileSync(f, Buffer.from(m.params.data, 'base64'));
    frames.push({ f, t: m.params.metadata.timestamp, part: frames.rec });
    cdp('Page.screencastFrameAck', { sessionId: m.params.sessionId });
  });
  const openPack = async (name) => {
    await open({ w: W, h: H, theme: 'Slate Blue', dsf: 2, url: BASE + '/src/', lib: true });
    await ev(`window.__r = 'pending'; (async () => { try {
      const b = await (await fetch(${JSON.stringify(`${BASE}/tests/${name}`)})).blob();
      const m = await import('/src/mpak.js');
      await m.openMpak(new File([b], ${JSON.stringify(name)}));
      window.__r = 'opened'; } catch (e) { window.__r = 'ERR ' + e.message } })(); 1`);
    for (let i = 0; i < 60 && (await ev('window.__r')) === 'pending'; i++) await sleep(500);
    if ((await ev('window.__r')) !== 'opened') throw new Error(`could not open ${name}: ${await ev('window.__r')}`);
    await sleep(3000);
    await ev(`document.getElementById('webCtaBanner')?.remove()`);
  };
  const record = async (part, seconds, during) => {
    frames.rec = part;
    await cdp('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
    await during();
    await sleep(seconds * 1000);
    await cdp('Page.stopScreencast');
    frames.rec = null;
    const mine = frames.filter(fr => fr.part === part);
    if (mine.length < 20) throw new Error(`${part}: screencast gave only ${mine.length} frames`);
    const list = mine.map((fr, i) => `file '${fr.f}'\nduration ${((mine[i + 1]?.t ?? fr.t + 0.04) - fr.t).toFixed(4)}`).join('\n');
    writeFileSync(join(dir, part + '.txt'), list + `\nfile '${mine.at(-1).f}'\n`);
    run('-f', 'concat', '-safe', '0', '-i', join(dir, part + '.txt'), '-vf', 'fps=30,format=yuv420p', '-an', '-c:v', 'libx264', '-crf', '16', join(dir, part + '-raw.mp4'));
  };
  const play = () => ev(`document.querySelector('#globalPlayPauseBtn')?.click()`);

  // 1. Guitar Pro: the fixture with the fretboard open, a few bars playing
  await open({ w: W, h: H, theme: 'Slate Blue', dsf: 2 });
  if (await ev(`document.querySelector('#fretboardDockBtn')?.getAttribute('aria-pressed') !== 'true'`)) await click('#fretboardDockBtn');
  await sleep(900);
  if (!(await ev(`document.querySelector('#fretboardDockBtn')?.getAttribute('aria-pressed') === 'true'`))) throw new Error('fretboard did not open');
  await shot('hero-poster');
  await record('gp', 6, async () => { await play(); setTimeout(play, 5800); });

  // 2. Text: Prelude, played so the page turns by itself
  await openPack('Prelude.mpak');
  // the file's own header credits the site and its author with links and an address; the picture starts at the tuning line
  await ev(`document.querySelectorAll('.text-line').forEach(l => { if (/classtab|wussu|MIDI:|video:/i.test(l.textContent)) l.style.display = 'none'; })`);
  await sleep(500);
  await record('txt', 6, async () => { await play(); setTimeout(play, 5800); });

  // 3. PDF: Equinox with its recording open in the video sheet
  await openPack('Equinox.mpak');
  await sleep(6000); // the video sheet opens by itself with Original selected; the embedded player needs the network
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`); await sleep(800);
  await record('pdf', 6, async () => { await play(); setTimeout(play, 5800); });

  // Frame each part in a thin tablet bezel on the page's ground colour, then join them: each device pushes the next in from the
  // right, so the bezel travels with the screen. The page shows the video with no frame of its own (docs/site.css .hero-video).
  const B = 12, M = 12, RO = 20, RI = 8;            // bezel, margin to the video edge, outer and screen corner radius
  const SW = W + 2 * (B + M), SH = H + 2 * (B + M);
  const round = (w, h, r) => `if(gt(min(X,${w - 1}-X),${r})+gt(min(Y,${h - 1}-Y),${r}),255,if(lte(hypot(${r}-min(X,${w - 1}-X),${r}-min(Y,${h - 1}-Y)),${r}),255,0))`;
  const parts = ['gp', 'txt', 'pdf'];
  const len = p => { const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(dir, p + '.mp4')]); return parseFloat(r.stdout); };
  for (const p of parts) {
    const raw = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(dir, p + '-raw.mp4')]);
    const dur = parseFloat(raw.stdout);
    run('-i', join(dir, p + '-raw.mp4'),
      '-f', 'lavfi', '-i', `color=c=0x05070c:s=${W + 2 * B}x${H + 2 * B}:r=30`,
      '-f', 'lavfi', '-i', `color=c=0x1e2636:s=${SW}x${SH}:r=30`,
      '-filter_complex', `[0:v]format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='${round(W, H, RI)}'[scr];` +
        `[1:v]format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='${round(W + 2 * B, H + 2 * B, RO)}'[bz];` +
        `[2:v][bz]overlay=${M}:${M}[x];[x][scr]overlay=${M + B}:${M + B},format=yuv420p[v]`,
      '-map', '[v]', '-t', String(dur), '-an', '-c:v', 'libx264', '-crf', '16', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', join(dir, p + '.mp4'));
  }
  const d = parts.map(len);
  const starts = [0, d[0] - FADE, d[0] + d[1] - 2 * FADE];
  const f1 = `[0][1]xfade=transition=slideleft:duration=${FADE}:offset=${starts[1]}[a];[a][2]xfade=transition=slideleft:duration=${FADE}:offset=${starts[2]}`;
  const joined = join(dir, 'hero-all.mp4');
  run(...parts.flatMap(p => ['-i', join(dir, p + '.mp4')]), '-filter_complex', f1, '-an', '-c:v', 'libx264', '-crf', '14', joined);
  const total = len('hero-all');
  run('-i', joined, '-an', '-c:v', 'libvpx-vp9', '-crf', '34', '-b:v', '0', '-row-mt', '1', join(out, 'hero.webm'));
  run('-i', joined, '-an', '-c:v', 'libx264', '-crf', '30', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(out, 'hero.mp4'));
  // the row under the loop switches in the middle of each push
  const seg = [0, starts[1] + FADE / 2, starts[2] + FADE / 2, total].map(n => +n.toFixed(2)).join(',');
  const idx = join(here, '../../../docs/index.html');
  writeFileSync(idx, readFileSync(idx, 'utf8').replace(/data-segments="[^"]*"/, `data-segments="${seg}"`));
  // the poster is the framed first frame (ffmpeg here has no webp encoder, so cwebp converts a png)
  run('-i', joined, '-frames:v', '1', join(dir, 'poster.png'));
  if (spawnSync('cwebp', ['-q', '86', '-quiet', join(dir, 'poster.png'), '-o', join(out, 'hero-poster.webp')]).status) throw new Error('cwebp failed');
  console.log(`video is ${SW}x${SH}`);
  rmSync(dir, { recursive: true, force: true });
  console.log('wrote hero.webm, hero.mp4 and data-segments', seg);
}
ws.close();
