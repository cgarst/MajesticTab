#!/usr/bin/env python3
"""Round trip: what one device holds, sent through a store and taken in by a fresh device, must come back the same.

Device A is seeded with songs in the shapes that have needed repairs (a plain Original, an alternate and a Backing, a stem set,
a stem set beside a full mix, a stem set with a video Original, two songs with one title). A syncs to a store, a fresh device B
syncs from it, and the script compares, song by song:

  1. what B holds with what A holds (recordings, slots, stem sets, videos, audio files, sync points), and
  2. the pack B would write with the pack A wrote, and whether B syncing again, then A, moves anything.

It is the real exporter, importer and local adapter (src/packSyncLocal.js) on real IndexedDB, so it finds what the node tests
with a fake local side cannot. Run it for both ways a device takes a pack in: `HYBRID=0` (audio comes with the pack, the default
here) and `HYBRID=1` (audio stays in the store until asked for). `SHOW=1` prints every difference in full.

Needs the dev server (`python3 -m http.server 8000` from the repo root) and `pip install playwright` with its bundled Chromium.
Exits 1 on any difference.
"""
import base64, json, os, sys
from playwright.sync_api import sync_playwright

HYBRID = os.environ.get('HYBRID', '0')
SHOW = os.environ.get('SHOW') == '1'
BASE = os.environ.get('BASE', 'http://localhost:8000/src/')

# --- a store outside both browsers, with the contract's semantics (versions, conditional writes) ---
FILES = {}
CTR = [0]
def b64(b): return base64.b64encode(b).decode()
def st_list(prefix):
    return json.dumps([{'path': p, 'size': len(f['bytes']), 'version': f['version'], 'modifiedTime': f['mtime']} for p, f in FILES.items() if p.startswith(prefix)])
def st_stat(path):
    f = FILES.get(path)
    return json.dumps(None if not f else {'path': path, 'size': len(f['bytes']), 'version': f['version'], 'modifiedTime': f['mtime']})
def st_read(path, start, end):
    f = FILES.get(path)
    if not f: return None
    b = f['bytes']
    if start is not None: b = b[start:end if end is not None else len(b)]
    return b64(b)
def st_write(path, data, mode, ifv):
    f = FILES.get(path)
    cur = f['version'] if f else None
    if mode == 'check' and cur != ifv: return json.dumps({'conflict': True, 'current': cur})
    CTR[0] += 1
    FILES[path] = {'bytes': base64.b64decode(data), 'version': f'v{CTR[0]}', 'mtime': '2026-01-01T00:00:00.000Z'}
    return json.dumps({'version': FILES[path]['version']})
def st_delete(path, mode, ifv):
    f = FILES.get(path)
    cur = f['version'] if f else None
    if mode == 'check' and cur != ifv: return json.dumps({'conflict': True, 'current': cur})
    return json.dumps(FILES.pop(path, None) is not None)

PROXY = r"""
async () => {
  const c = await import('/src/storage/contract.js');
  const unb64 = (s) => Uint8Array.from(atob(s), ch => ch.charCodeAt(0));
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
  window.__store = {
    label: 'external', location: 'external store',
    capabilities: { rangeRead: true, conditionalWrite: true, cheapList: true, realFolders: false },
    open: async () => true,
    list: async (prefix = '') => JSON.parse(await window.st_list(prefix)),
    stat: async (path) => JSON.parse(await window.st_stat(path)),
    async read(path, { range } = {}) {
      const r = await window.st_read(path, range ? range.start : null, range ? range.end : null);
      if (r === null) throw new c.NotFoundError('No such file: ' + path);
      return unb64(r);
    },
    async write(path, bytes, { ifVersion } = {}) {
      if (bytes instanceof Blob) bytes = new Uint8Array(await bytes.arrayBuffer());
      const r = JSON.parse(await window.st_write(path, b64(bytes), ifVersion === undefined ? 'none' : 'check', ifVersion === undefined ? null : ifVersion));
      if (r.conflict) throw new c.ConflictError('Version mismatch', r.current);
      return r;
    },
    async delete(path, { ifVersion } = {}) {
      const r = JSON.parse(await window.st_delete(path, ifVersion === undefined ? 'none' : 'check', ifVersion === undefined ? null : ifVersion));
      if (r && r.conflict) throw new c.ConflictError('Version mismatch', r.current);
      return r;
    },
  };
  return true;
}
"""

SEED = r"""
async () => {
  const lib = await import('/src/libraryStore.js');
  const afs = await import('/src/audioSync/audioFileStore.js');
  const ss = await import('/src/audioSync/syncStore.js');
  const anc = await import('/src/audioSync/anchors.js');
  const rm = await import('/src/audioSync/recordingMeta.js');
  const vh = await import('/src/audioSync/videoHistory.js');
  const sk = await import('/src/songKey.js');
  const enc = (s) => encodeURIComponent(String(s).toLowerCase());
  const sha = async (u8) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', u8)), b => b.toString(16).padStart(2,'0')).join('');
  const ls = (k, v) => localStorage.setItem(k, v);
  let n = 0;
  const bytes = (len) => { const u = new Uint8Array(len); for (let i = 0; i < len; i++) u[i] = (i * 31 + (++n) * 7 + (i >> 3)) & 255; return u; };

  const song = async (title, artist, album, tabText) => {
    const s = await lib.saveSongToLibrary({ title, artist, album, year: 2001 });
    const text = new TextEncoder().encode(tabText);
    await lib.mapOpenFileToSong(new File([text], `${title}.txt`, { type: 'text/plain' }), s.id, `${title} tab`, 'local', `${title}.txt`);
    return { s, key: sk.songKeyFor(s), tabSha: await sha(text) };
  };
  const audio = async (x, name, len) => afs.saveAudioFile({ name, type: 'audio/mpeg', data: bytes(len).buffer, songKey: x.key, durationMs: 30000 });
  const media = (m) => ({ kind: 'local', audioId: m.id, name: m.name, durationMs: 30000, fingerprint: m.fingerprint });
  const slot = (x, name, m, source = 'local') => {
    ls(`audio_file_${enc(x.key)}_${name}`, m.id);
    if (name === 'original') ls(`audio_file_last_${enc(x.key)}`, m.id);
    ls(`real_audio_source_${enc(x.key)}_${name}`, source);
  };
  const points = (x, m, extra = 0) => ss.saveRecord(anc.scoreSyncKey(x.key, x.tabSha), media(m), [{ timeMs: 1000, line: 0 }, { timeMs: 2500 + extra, line: 1 }], undefined, undefined, 'text');
  // The set the "Add stems" sheet makes: the lead carries the list, the others hang off it
  const stemSet = async (x, role, len) => {
    const parts = [['Guitar', 'guitar'], ['Bass', 'bass'], ['Drums', 'drums']];
    const saved = [];
    for (const [i, [label]] of parts.entries()) saved.push(await audio(x, `${label.toLowerCase()}.mp3`, len + i * 100));
    const stems = saved.map((m, i) => ({ audioId: m.id, label: parts[i][0], instrument: parts[i][1] }));
    rm.setRecordingMeta(x.key, media(saved[0]), { role, label: 'All stems', stems });
    saved.slice(1).forEach((m, i) => rm.setRecordingMeta(x.key, media(m), { role: 'stem', stemOf: `local_${saved[0].id}`, label: parts[i + 1][0], instrument: parts[i + 1][1] }));
    return saved;
  };

  // 1. a plain Original with sync points
  let x = await song('Plain', 'RT Artist', 'RT Album', 'e|---0---|\n');
  let o = await audio(x, 'plain.mp3', 30000); slot(x, 'original', o); points(x, o);

  // 2. an Original, a lossless copy kept as an alternate, and a Backing file
  x = await song('Alternates', 'RT Artist', 'RT Album', 'e|---1---|\n');
  o = await audio(x, 'alt.mp3', 31000); slot(x, 'original', o); points(x, o);
  const copy = await audio(x, 'alt.flac', 52000); rm.setRecordingMeta(x.key, media(copy), { role: 'alternate', label: 'Lossless' });
  const back = await audio(x, 'alt (backing).mp3', 29000); slot(x, 'backing', back); rm.setRecordingMeta(x.key, media(back), { role: 'backing', label: 'Backing' });

  // 3. a stem set that is the Original (both parts play it), sync points under the lead
  x = await song('Stems', 'RT Artist', 'RT Album', 'e|---2---|\n');
  let set = await stemSet(x, 'original', 20000); slot(x, 'original', set[0]); slot(x, 'backing', set[0]); points(x, set[0]);

  // 4. a stem set beside a full mix that is the Original
  x = await song('StemsAndMix', 'RT Artist', 'RT Album', 'e|---3---|\n');
  o = await audio(x, 'mix.mp3', 33000); slot(x, 'original', o); points(x, o);
  set = await stemSet(x, 'alternate', 21000);

  // 5. a stem set with a video Original and two more remembered videos
  x = await song('VideoAndStems', 'RT Artist', 'RT Album', 'e|---4---|\n');
  set = await stemSet(x, 'original', 22000); slot(x, 'backing', set[0]);
  ls(`real_audio_source_${enc(x.key)}_original`, 'youtube'); ls(`yt_track_${enc(x.key)}_original`, 'dQw4w9WgXcQ');
  vh.rememberVideo(x.key, 'original', 'dQw4w9WgXcQ'); vh.rememberVideo(x.key, 'original', 'aqz-KE-bpKQ'); vh.rememberVideo(x.key, 'original', '9bZkp7q19f0');
  ss.saveRecord(anc.scoreSyncKey(x.key, x.tabSha), { kind: 'youtube', videoId: 'dQw4w9WgXcQ' }, [{ timeMs: 900, line: 0 }, { timeMs: 2000, line: 1 }], undefined, undefined, 'text');

  // 6 and 7. two songs with one artist and title on two albums, each with its own audio (neither may take the other's)
  for (const album of ['Studio', 'Live']) {
    x = await song('Twin', 'RT Artist', album, `e|---${album}---|\n`);
    o = await audio(x, `twin ${album}.mp3`, album === 'Studio' ? 34000 : 36000); slot(x, 'original', o); points(x, o, album === 'Studio' ? 0 : 500);
  }
  return true;
}
"""

# What a device holds for each song, with device-specific ids replaced by what the file is
SNAP = r"""
async () => {
  const lib = await import('/src/libraryStore.js');
  const afs = await import('/src/audioSync/audioFileStore.js');
  const sk = await import('/src/songKey.js');
  const all = await lib.getAllLibraryData();
  const files = await afs.listAudioFiles();
  const label = new Map(files.map((f) => [f.id, `#${f.size}`]));
  const swap = (s) => String(s).replace(/[A-Za-z0-9_-]*(?:audio_|aud_)[A-Za-z0-9_-]+/g, (m) => label.get(m) || m);
  const ids = [...label.keys()].sort((a, b) => b.length - a.length);
  const norm = (v) => { let s = typeof v === 'string' ? v : JSON.stringify(v); for (const id of ids) s = s.split(id).join(label.get(id)); return s; };
  const out = {};
  for (const song of all.songs) {
    const key = sk.songKeyFor(song);
    const e = encodeURIComponent(key.toLowerCase());
    const mine = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k.includes(e)) continue;
      let v = localStorage.getItem(k);
      let name = k.split(e).join('<song>');
      for (const id of ids) name = name.split(id).join(label.get(id));
      v = norm(v);
      if (k.startsWith('rec_meta_')) { try { const o = JSON.parse(v); for (const [mk, m] of Object.entries(o)) { delete m.packIndex; if (m.role === 'original' && Object.keys(m).length === 1) delete o[mk]; } v = JSON.stringify(Object.fromEntries(Object.entries(o).sort())); if (v === '{}') continue; } catch (_) {} }
      if (k.startsWith('audio_sync_')) { try { const r = JSON.parse(v); v = JSON.stringify((r.points || r.p || []).map((p) => [p.timeMs ?? p.t, p.line ?? p.bar ?? p.b])); } catch (_) {} }
      if (k.startsWith('yt_videos_')) { try { v = JSON.stringify(JSON.parse(v).map((x) => x.videoId).sort()); } catch (_) {} }
      mine[name] = v;
    }
    const audio = files.filter((f) => (f.songKeys || []).includes(key)).map((f) => `${f.size}:${f.name}`).sort();
    const tabs = (song.tabOptions || []).map((t) => `${t.name}:${Boolean(t.fileStoreId)}`).sort();
    out[`${song.title} (${song.album})`] = { tabs, audio, keys: Object.fromEntries(Object.entries(mine).sort()) };
  }
  return out;
}
"""

# The pack this device would write for each song: manifest and file list, normalised
PACKS = r"""
async () => {
  const loc = await import('/src/packSyncLocal.js');
  const a = loc.createLocalAdapter();
  const items = await a.items();
  const out = {};
  for (const [key, it] of items) {
    if (it.kind !== 'pack' || it.remoteOnly) continue;
    const { files } = await a.readItem(key);
    const manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json')));
    const strip = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'created' || k === 'createdAt' || k === 'modified' || k === 'generator' || k === 'savedAt' ? undefined : x)));
    for (const [n, e] of Object.entries(manifest.entries || {})) if (n.startsWith('sync/')) delete e.sha256;
    out[it.name + ' / ' + (manifest.song?.album || '')] = { manifest: strip(manifest), files: [...files.entries()].map(([n, v]) => `${n}:${v.size ?? v.length}`).sort() };
  }
  return out;
}
"""

SYNC = r"""
async (hybrid) => {
  const ps = await import('/src/storage/packSync.js');
  const loc = await import('/src/packSyncLocal.js');
  const info = await import('/src/storage/storeInfo.js');
  loc.setHybridSyncEnabled(hybrid === '1');
  const store = window.__store;
  if (!(await store.stat('store.json'))) await info.writeStoreInfo(store, { appVersion: 'test' });
  return await ps.applyPackSync({ store, local: loc.createLocalAdapter(), baselines: loc.localBaselines, location: 'external store' });
}
"""

def device(b):
    ctx = b.new_context()
    for fn in (st_list, st_stat, st_read, st_write, st_delete): ctx.expose_function(fn.__name__, fn)
    pg = ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(f'pageerror: {e}'))
    pg.goto(BASE, wait_until='load'); pg.wait_for_timeout(2500)
    pg.evaluate(PROXY)
    return pg, errs

FAILS = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name)
    if not ok:
        FAILS.append(name)
        if detail: print(detail)

def diff(a, b, path=''):
    """Every place two JSON values differ, as short lines."""
    if isinstance(a, dict) and isinstance(b, dict):
        out = []
        for k in sorted(set(a) | set(b)):
            if k not in a: out.append(f'  + {path}/{k} = {json.dumps(b[k])[:200]}')
            elif k not in b: out.append(f'  - {path}/{k} = {json.dumps(a[k])[:200]}')
            else: out += diff(a[k], b[k], f'{path}/{k}')
        return out
    return [] if a == b else [f'  ~ {path}: {json.dumps(a)[:200]}  ->  {json.dumps(b)[:200]}']

def compare(label, a, b):
    lines = []
    for song in sorted(set(a) | set(b)):
        d = diff(a.get(song), b.get(song), song) if song in a and song in b else [f'  {"missing on the second" if song not in b else "missing on the first"}: {song}']
        lines += d
    check(label, not lines, '\n'.join(lines if SHOW else lines[:12]) + ('' if SHOW or len(lines) <= 12 else f'\n  ... {len(lines) - 12} more (SHOW=1 for all)'))

with sync_playwright() as p:
    br = p.chromium.launch(headless=True)
    try:
        A, ea = device(br); B, eb = device(br)
        A.evaluate(SEED)
        snapA = A.evaluate(SNAP); packA = A.evaluate(PACKS)
        r = A.evaluate(SYNC, '0')
        check('A sends all seven songs', r['uploaded'] == 7 and not r['failed'], r)
        r = B.evaluate(SYNC, HYBRID)
        check(f'B (hybrid={HYBRID}) takes all seven in', r['downloaded'] == 7 and not r['failed'], r)
        snapB = B.evaluate(SNAP)
        if HYBRID == '1':
            # Audio stays in the store; compare what B knows about each song without its audio files
            for s in snapA.values(): s['audio'] = []
            for s in snapB.values(): s['audio'] = []
        compare('what B holds is what A holds, song by song', snapA, snapB)
        compare('the pack B would write is the pack A wrote', packA, B.evaluate(PACKS))
        r = B.evaluate(SYNC, HYBRID)
        check('B syncing again sends nothing', all(r[k] == 0 for k in ('uploaded', 'downloaded', 'merged', 'removedHere', 'removedThere')) and not r['failed'], r)
        r = A.evaluate(SYNC, '0')
        check('then A syncing moves nothing', all(r[k] == 0 for k in ('uploaded', 'downloaded', 'merged', 'removedHere', 'removedThere')) and not r['failed'], r)
        check('no page errors', not ea and not eb, (ea, eb))
    finally:
        br.close()

sys.exit(1 if FAILS else 0)
