#!/usr/bin/env node
// Capture the Flathub listing screenshots from the real, installed Flatpak on a KDE Plasma (Wayland) machine.
//
// Flathub wants genuine window screenshots: native title bar, shadow and rounded corners, a non-maximized window of
// at most 1000x700 (2000x1400 on HiDPI), no editing. So nothing here is composed or emulated. For every scene the
// script launches the installed app with a throwaway profile and the Duo fixture, drives it over WebKit's remote
// inspector, sizes the window with a KWin script, and takes the shot with Spectacle's active-window capture.
//
// Needs: node 22+ (global WebSocket), the app installed (`node build/build-tauri.mjs linux`, then
// `flatpak install --user dist/*.flatpak`), Spectacle, busctl, and KWin 6 with a running Plasma session.
// The remote inspector must be reachable: it is on every build so far, but check a release build if shots fail.
//
// Usage (without node on the host: flatpak run --share=network --talk-name=org.freedesktop.Flatpak
//   --filesystem=<repo> --command=sh org.gnome.Sdk//51 -c "/usr/lib/sdk/node22/bin/node support/tools/flathub_screenshots.mjs"):
//   node support/tools/flathub_screenshots.mjs                    # every scene
//   node support/tools/flathub_screenshots.mjs --only gp_page     # some scenes
//   Options: --app <id> (default net.zathu.majestictab), --size 1000x700, --out <dir>, --port 9333
//
// Output: support/store/flathub/<NN>-<scene>.png, the files the Flatpak metainfo points at. The window is
// captured as your Plasma theme draws it (platform defaults, as Flathub asks), so re-run on a stock Breeze setup.
import { execFileSync as exec, spawn as spawnProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const appId = opt('app', 'net.zathu.majestictab');
const [width, height] = opt('size', '1000x700').split('x').map(Number);
const outDir = path.resolve(opt('out', path.join(root, 'support/store/flathub')));
const port = Number(opt('port', '9333'));
const fixture = path.join(root, 'tests', 'Duo No 2 In G Major.gp5');
const only = args.includes('--only') ? args.slice(args.indexOf('--only') + 1).filter((a) => !a.startsWith('--')) : null;

// Inside a Flatpak sandbox (e.g. node from the SDK extension on a host without node) run host tools through
// flatpak-spawn: start that sandbox with --share=network --talk-name=org.freedesktop.Flatpak and the repo filesystem.
const inSandbox = existsSync('/.flatpak-info');
const execFileSync = (cmd, a, o) => (inSandbox ? exec('flatpak-spawn', ['--host', cmd, ...a], o) : exec(cmd, a, o));
const spawn = (cmd, a, o) => (inSandbox ? spawnProcess('flatpak-spawn', ['--host', cmd, ...a], o) : spawnProcess(cmd, a, o));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Scene code runs inside the page (the Tauri frontend serves src/ from its root, so modules import as '/gpProcessor/...').
const click = (selector) => `document.querySelector(${JSON.stringify(selector)}).click()`;
const clickVisible = (selectors) => `[...document.querySelectorAll(${JSON.stringify(selectors)})].find((el) => el.offsetParent)?.click()`;
const demo = JSON.parse(readFileSync(path.join(root, 'support/tools/demo_library.json'), 'utf8'));
const slug = (artist, album) => `${artist}_${album}`.replace(/[^\p{L}\p{N}]/gu, '_').toLowerCase();

// The same fictional library as the other store shots (support/tools/demo_library.json), with the album sleeves
// store_screenshots.py cached in support/store/.cover-cache.
function demoLibrary() {
  const songs = [];
  const covers = {};
  let n = 0;
  for (const [artist, albums] of Object.entries(demo.library)) {
    for (const [album, tracks] of Object.entries(albums)) {
      const cacheFile = path.join(root, 'support/store/.cover-cache', `${slug(artist, album)}.jpg`);
      if (!existsSync(cacheFile)) throw new Error(`Missing ${cacheFile}; run store_screenshots.py once to create the sleeves`);
      const coverKey = slug(artist, album);
      covers[coverKey] = `data:image/jpeg;base64,${readFileSync(cacheFile).toString('base64')}`;
      tracks.forEach((title, i) => {
        songs.push({ title, artist, album, trackNumber: i + 1, year: 2018 + (album.length % 6), coverKey, tunings: [demo.tunings[n % demo.tunings.length]] });
        n += 1;
      });
    }
  }
  const custom = ['Duo No. 2 in G Major:Drop D', 'Morning Prelude in G:Standard', 'Odd-Meter Study No. 3:7-String Standard',
    'Fingerstyle Etude in D:DADGAD', 'Sweep Arpeggio Workout:Standard'].map((entry) => {
    const [title, tuning] = entry.split(':');
    return { title, isCustom: true, artist: 'Custom Music', album: '', tunings: [tuning] };
  });
  return { songs, covers, custom, books: ['Acoustic Songbook Vol. 1.pdf', 'Progressive Etudes.pdf'] };
}

// Fills the app's library, refusing to touch one that already has songs: the scene must run on the throwaway profile.
// (Cover art goes over in separate small messages first: one huge inspector message never got a reply.)
const seedLibrary = (library) => `(async () => {
  const lib = await import('/libraryStore.js');
  const existing = await lib.getSongsByCollection('default');
  if (existing.length) throw new Error('Library is not empty (' + existing.length + ' songs, e.g. ' + existing.slice(0, 3).map((x) => x.title).join(', ') + '); refusing to seed it');
  const covers = window.__covers || {};
  const { songs, custom, books } = ${JSON.stringify(library)};
  for (const { coverKey, ...song } of songs) await lib.saveSongToLibrary({ ...song, coverUrl: covers[coverKey] });
  for (const name of books) await lib.addTabOptionToAlbum('default', 'Custom Music', 'Custom Music', { name, fileType: 'pdf', isCustom: true });
  for (const song of custom) await lib.saveSongToLibrary(song);
  return 'seeded';
})()`;

async function seedPage(page) {
  const library = demoLibrary();
  await page.evaluate('(window.__covers = {}, 1)');
  for (const [key, url] of Object.entries(library.covers)) await page.evaluate(`(window.__covers[${JSON.stringify(key)}] = ${JSON.stringify(url)}, 1)`);
  const { covers, ...rest } = library;
  await page.evaluate(seedLibrary(rest));
}

const openLibrary = `(async () => {
  const modal = await import('/libraryModal.js');
  await modal.openLibraryModal('library');
  for (let i = 0; i < 60 && !document.querySelector('.artist-card'); i += 1) await new Promise((r) => setTimeout(r, 250));
  return 'open';
})()`;

// Fake jam players are real WebSocket clients of the app's own host, so the roster shows what a session looks like.
const JAM_PLAYERS = ["Dave's iPad", "Adrian's phone"];
async function joinJamPlayers(address) {
  const peers = [];
  for (const name of JAM_PLAYERS) {
    const ws = new WebSocket(`ws://${address}`);
    let seq = 0;
    const send = (type, payload = {}) => ws.send(JSON.stringify({ v: 1, type, seq: (seq += 1), ...payload }));
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'song.open' && msg.song?.id) {
        send('song.ready', { songId: msg.song.id });
        send('status', { rttMs: 8, driftMs: 3, state: 'synced' });
      }
    };
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('Could not reach the jam host')); });
    send('hello', { name, protocol: 1, pin: '' });
    peers.push(ws);
  }
  return peers;
}

const SCENES = [
  { id: 'gp_scroll', file: '01-gp_scroll.png', run: (page) => page.evaluate(click('#continuousModeRadio')) },
  { id: 'gp_page', file: '02-gp_page.png', run: (page) => page.evaluate(click('#pageModeRadio')) },
  {
    id: 'library', file: '03-library.png', run: async (page) => {
      await seedPage(page);
      await page.evaluate(openLibrary);
      await sleep(4000); // album artwork
    },
  },
  {
    id: 'tunings', file: '04-tunings.png', run: async (page) => {
      await seedPage(page);
      await page.evaluate(openLibrary);
      await page.evaluate(clickVisible("[data-lib-tab='tunings']"));
      await sleep(3000);
    },
  },
  { id: 'synth_menu', file: '05-synth_menu.png', run: (page) => page.evaluate(clickVisible('#mobileSynthToggleBtn, #synthToggleBtn')) },
  {
    id: 'fretboard', file: '06-fretboard.png', run: (page) => page.evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      ${click('#toolsToggleBtn')}; await sleep(400);
      ${click('#fretboardToggleBtn')}; await sleep(800);
      const gp = await import('/gpProcessor/gpPlayer.js');
      const { fretboardController } = await import('/fretboard/fretboardController.js');
      const api = window.gpState.canvases[0].api;
      const beat = api.tracks[0].staves[0].bars[6].voices[0].beats[1];
      document.body.classList.add('synth-playback-started');
      const bounds = api.renderer.boundsLookup.findBeat(beat);
      document.getElementById('output').scrollTop = Math.max(0, bounds.realBounds.y - 80);
      api.tickPosition = gp.getPlaybackTickForBeat(beat, api);
      fretboardController.showBeatsAtCursor(beat);
    })()`),
  },
  { id: 'theme_palettes', file: '07-theme_palettes.png', run: (page) => page.evaluate(`import('/themeEngine.js').then((m) => m.openThemeModal())`) },
  {
    id: 'jam', file: '08-jam.png', cleanup: [], run: async (page, scene) => {
      await page.evaluate(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        ${click('#jamToggleBtn')}; await sleep(500);
        ${click('[data-jam-tab=host]')}; await sleep(300);
        ${click('#jamStartHostBtn')}; await sleep(2500);
      })()`);
      const text = await page.evaluate(`document.getElementById('jamModalBody').innerText`);
      const address = (text.match(/(\d+\.\d+\.\d+\.\d+):(\d+)/) || []);
      if (!address[2]) throw new Error(`No jam host address in the modal: ${text.slice(0, 200)}`);
      scene.cleanup.push(...await joinJamPlayers(`127.0.0.1:${address[2]}`));
      await sleep(2500);
      // Each player takes a guitar track and the host listens to everything, as in the other store shots.
      const result = await page.evaluate(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const ids = [...new Set([...document.querySelectorAll('[data-jam-assign]')].map((el) => el.dataset.jamAssign))];
        const tracks = document.querySelectorAll('.jam-matrix-col').length - 1;
        ids.forEach((id, n) => document.querySelectorAll('.jam-matrix-cell[data-jam-assign="' + id + '"][data-jam-track]')[n % tracks]?.click());
        await sleep(300);
        document.querySelector('.jam-matrix-cell[data-jam-listening="host"]')?.click(); await sleep(300);
        document.querySelector("[data-jam-rule='assignedAudioMode'][data-jam-value='backing']")?.click(); await sleep(300);
        document.querySelector("[data-jam-rule='assignedViewOnly'][data-jam-value='own']")?.click(); await sleep(300);
        document.getElementById('jamModalBody').scrollTop = 0;
        return JSON.stringify({ ids, tracks });
      })()`);
      console.log(`jam roster: ${result}`);
    },
  },
];

// --- WebKit remote inspector -------------------------------------------------------------------------------------

async function connectInspector() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      // Each target row is: name, url, then an Inspect button naming its websocket path.
      const rows = [...html.matchAll(/targeturl">([^<]*)<[\s\S]*?(\/socket\/[^']+)'/g)];
      const page = rows.find((row) => row[1].startsWith('tauri://') || row[1].includes('localhost'));
      if (page) return openSocket(page[2]);
    } catch { /* app not up yet */ }
    await sleep(500);
  }
  throw new Error('The app never exposed its remote inspector; is it running and is this build inspectable?');
}

function openSocket(socketPath) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${socketPath}`);
  let target = null;
  let next = 100;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.onerror = () => reject(new Error('Inspector websocket failed'));
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Target.targetCreated') {
        target = msg.params.targetInfo.targetId;
        resolve();
      } else if (msg.method === 'Target.dispatchMessageFromTarget') {
        const inner = JSON.parse(msg.params.message);
        pending.get(inner.id)?.(inner);
        pending.delete(inner.id);
      }
    };
  });
  const evaluateOnce = async (expression) => {
    const id = next++;
    const reply = Promise.race([new Promise((resolve) => pending.set(id, resolve)), new Promise((_, reject) => setTimeout(() => reject(new Error('Inspector gave no reply in 20s (is another inspector client connected?)')), 20000).unref())]);
    ws.send(JSON.stringify({
      id: id + 100000, method: 'Target.sendMessageToTarget',
      params: { targetId: target, message: JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }) },
    }));
    const inner = await reply;
    const result = inner.result?.result;
    if (inner.error || inner.result?.wasThrown) throw new Error(`Page script failed: ${JSON.stringify(inner.error ?? result)}`);
    return result?.value;
  };
  // WebKit's inspector does not await promises, so run the expression, park its outcome on window and poll for it.
  const evaluate = async (expression) => {
    await evaluateOnce(`window.__shot = undefined; Promise.resolve().then(() => (${expression})).then((v) => { window.__shot = { value: v === undefined ? null : v }; }, (e) => { window.__shot = { error: String((e && e.message) || e) }; }); 1`);
    for (let i = 0; i < 240; i += 1) {
      const outcome = await evaluateOnce('JSON.stringify(window.__shot ?? null)');
      const parsed = JSON.parse(outcome);
      if (parsed) {
        if (parsed.error) throw new Error(`Page script failed: ${parsed.error}`);
        return parsed.value;
      }
      await sleep(250);
    }
    throw new Error('Page script never finished');
  };
  return ready.then(() => ({ evaluate, close: () => ws.close() }));
}

// --- Window handling (KWin scripting) ----------------------------------------------------------------------------

function kwin(source) {
  const dir = mkdtempSync(path.join(root, '.mt-kwin-')) // Under the repo: a sandboxed node's /tmp is invisible to KWin;
  const file = path.join(dir, 'script.js');
  writeFileSync(file, source);
  const name = `majestictab-shots-${process.pid}`;
  const bus = (...a) => execFileSync('busctl', ['--user', ...a], { encoding: 'utf8' });
  try {
    const id = bus('call', 'org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting', 'loadScript', 'ss', file, name).trim().split(' ')[1];
    bus('call', 'org.kde.KWin', `/Scripting/Script${id}`, 'org.kde.kwin.Script', 'run');
  } finally {
    try { bus('call', 'org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting', 'unloadScript', 's', name); } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

const placeWindow = () => kwin(`
  const w = workspace.windowList().find((win) => (win.resourceClass || '').toLowerCase().includes('majestictab') || win.caption === 'MajesticTab');
  if (w) {
    w.fullScreen = false;
    w.setMaximize(false, false);
    w.frameGeometry = { x: 120, y: 80, width: ${width}, height: ${height} };
    workspace.activeWindow = w;
  }
`);

// --- Driver ------------------------------------------------------------------------------------------------------

// Flatpak forces the app's XDG_* directories, so a throwaway profile needs a different HOME: flatpak then keeps the
// app's data under $HOME/.var/app/<id> there, while FLATPAK_USER_DIR still finds the user installation.
const profileHome = path.join(process.env.HOST_HOME || '/home/' + (process.env.USER || 'deck'), '.cache', 'mt-shots-home');
const userInstall = path.join(process.env.HOST_HOME || '/home/' + (process.env.USER || 'deck'), '.local/share/flatpak');

function launch() {
  // Never the real profile: the library and theme of whoever runs this must not leak into the shots (or be touched).
  execFileSync('rm', ['-rf', profileHome]);
  execFileSync('mkdir', ['-p', profileHome]);
  const env = [`HOME=${profileHome}`, `FLATPAK_USER_DIR=${userInstall}`];
  const run = ['run', `--filesystem=${path.dirname(fixture)}:ro`, `--env=WEBKIT_INSPECTOR_HTTP_SERVER=127.0.0.1:${port}`, appId, fixture];
  return inSandbox
    ? spawnProcess('flatpak-spawn', ['--host', ...env.map((e) => `--env=${e}`), 'flatpak', ...run], { stdio: 'ignore' })
    : spawnProcess('flatpak', run, { stdio: 'ignore', env: { ...process.env, HOME: profileHome, FLATPAK_USER_DIR: userInstall } });
}

async function capture(scene) {
  const app = launch();
  let page;
  try {
    page = await connectInspector();
    await page.evaluate(`(() => { try { localStorage.setItem('hasSeenControllerGuide', 'true'); } catch {} })()`);
    for (let i = 0; i < 120; i += 1) {
      if (await page.evaluate(`!!(window.gpState?.canvases?.[0]?.api && document.querySelector('#output canvas, #output svg'))`)) break;
      await sleep(500);
    }
    // Light sheets, as in the other store shots (a fresh profile follows the desktop's dark mode).
    await page.evaluate(`import('/themeEngine.js').then((m) => m.setSheetMode('light')).then(() => 'ok')`);
    await sleep(2500);
    placeWindow();
    await sleep(1500);
    await scene.run(page, scene);
    await sleep(3000);
    placeWindow(); // Re-activate: a menu or the shell may have taken focus.
    await sleep(800);
    const file = path.join(outDir, scene.file);
    execFileSync('spectacle', ['-a', '-b', '-n', '-d', '500', '-o', file], { stdio: 'inherit' });
    if (statSync(file).size === 0) throw new Error(`Spectacle wrote an empty ${scene.file}`);
    console.log(`captured ${path.relative(root, file)}`);
  } finally {
    scene.cleanup?.forEach((ws) => ws.close());
    page?.close();
    try { execFileSync('flatpak', ['kill', appId]); } catch { /* not running */ }
    app.kill();
    await sleep(1500);
    try { execFileSync('rm', ['-rf', profileHome]); } catch { /* best effort */ }
  }
}

mkdirSync(outDir, { recursive: true });
for (const scene of SCENES) {
  if (only && !only.includes(scene.id)) continue;
  await capture(scene);
}
