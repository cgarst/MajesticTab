#!/usr/bin/env node
// Captures the landing page's pictures from the real app: docs/img/app/*.webp and the hero loop (webm, mp4, poster).
//
// Needs: a dev server that sends CORS headers serving the repo root, an Edge/Chrome started with --remote-debugging-port,
// Node 22+ and ffmpeg (hero loop only). See "Local Dev Server and Debug Edge" in AGENTS.md.
//   node support/tools/landing/capture.mjs [--port 9344] [--base http://localhost:8765] [--only reader,practice] [--no-video]
// The only score ever shown is the repo's own fixture, `Duo No 2 In G Major.gp5` (see Repository Content Rules).
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

async function open({ w, h, theme, dsf = 2, mobile = false }) {
  await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dsf, mobile });
  await cdp('Page.navigate', { url: URL_ });
  await sleep(1500);
  await ev(`localStorage.setItem('majestictab_theme', ${JSON.stringify(theme)})`);
  await cdp('Page.navigate', { url: URL_ });
  // wait until the score has finished loading and laying out (loading card gone, pages drawn)
  for (let i = 0; i < 80; i++) {
    if (await ev(`!/Loading score|Laying out|Rendering|Parsing/i.test(document.body.innerText) && document.querySelectorAll('.at-surface svg').length > 10 && !!document.querySelector('#viewToggleBtn')?.offsetParent`)) break;
    await sleep(500);
  }
  await sleep(1500);
}
const click = (sel) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
async function shot(name) {
  const r = await cdp('Page.captureScreenshot', { format: 'webp', quality: 86 });
  writeFileSync(join(out, name + '.webp'), Buffer.from(r.data, 'base64'));
  console.log('wrote', name + '.webp');
}
const want = n => !ONLY || ONLY.includes(n);

// ---- stills: desktop 1440x900 and phone 390x844, Slate Blue (the site's own finish) and Snow White
const PANELS = { view: '#viewToggleBtn', practice: '#practiceToggleBtn', tracks: '#tracksToggleBtn', guitar: '#guitarToggleBtn', tools: '#toolsToggleBtn' };
for (const [suffix, size] of [['', { w: 1440, h: 900 }], ['-phone', { w: 390, h: 844, mobile: true }]]) {
  for (const theme of ['Slate Blue', 'Snow White']) {
    const tag = theme === 'Slate Blue' ? '' : '-snow';
    if (theme === 'Snow White' && !want('snow')) continue;
    await open({ ...size, theme });
    if (want('reader')) await shot(`reader${suffix}${tag}`);
    if (theme !== 'Slate Blue') continue;
    for (const [name, sel] of Object.entries(PANELS)) {
      if (!want(name)) continue;
      await click(sel); await sleep(900);
      await shot(`${name}${suffix}`);
      await click(sel); await sleep(500); // close again
      await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`); await sleep(300);
    }
  }
}

// ---- hero loop: tablet portrait, Slate Blue, a few bars playing
if (want('hero') && !process.argv.includes('--no-video')) {
  const W = 820, H = 1100;
  await open({ w: W, h: H, theme: 'Slate Blue', dsf: 1 });
  await shot('hero-poster');
  const dir = mkdtempSync(join(tmpdir(), 'mt-hero-'));
  const frames = [];
  listeners.push(m => {
    if (m.method !== 'Page.screencastFrame') return;
    const n = frames.length; const f = join(dir, `f${String(n).padStart(5, '0')}.jpg`);
    writeFileSync(f, Buffer.from(m.params.data, 'base64'));
    frames.push({ f, t: m.params.metadata.timestamp });
    cdp('Page.screencastFrameAck', { sessionId: m.params.sessionId });
  });
  await cdp('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  await ev(`document.querySelector('#globalPlayPauseBtn')?.click()`);
  await sleep(6500);
  await ev(`document.querySelector('#globalPlayPauseBtn')?.click()`);
  await cdp('Page.stopScreencast');
  if (frames.length < 20) throw new Error('screencast gave only ' + frames.length + ' frames');
  const list = frames.map((fr, i) => `file '${fr.f}'\nduration ${((frames[i + 1]?.t ?? fr.t + 0.04) - fr.t).toFixed(4)}`).join('\n');
  writeFileSync(join(dir, 'list.txt'), list + `\nfile '${frames.at(-1).f}'\n`);
  const run = (...a) => { const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...a], { stdio: 'inherit' }); if (r.status) throw new Error('ffmpeg failed'); };
  const base = ['-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'), '-vf', 'fps=30,format=yuv420p', '-an'];
  run(...base, '-c:v', 'libvpx-vp9', '-crf', '34', '-b:v', '0', '-row-mt', '1', join(out, 'hero.webm'));
  run(...base, '-c:v', 'libx264', '-crf', '26', '-preset', 'slow', '-movflags', '+faststart', join(out, 'hero.mp4'));
  rmSync(dir, { recursive: true, force: true });
  console.log('wrote hero.webm, hero.mp4 from', frames.length, 'frames');
}
ws.close();
