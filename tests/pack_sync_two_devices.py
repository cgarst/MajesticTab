#!/usr/bin/env python3
"""Two devices, one store, real IndexedDB: the pack sync engine with the app's own local adapter (src/packSyncLocal.js).

Each device is a separate browser context (its own IndexedDB and localStorage). The store is a Python dict behind the
storage contract (versions, conditional writes), reached from both pages through exposed functions. Needs the dev server
(`python3 -m http.server 8000` from the repo root) and `pip install playwright` with its bundled Chromium. Exits 1 on failure.
"""
import base64, json, sys
from playwright.sync_api import sync_playwright

# --- a store that lives outside both browsers, with the contract's semantics (versions, conditional writes) ---
FILES = {}   # path -> {bytes, version, mtime}
CTR = [0]
LOG = []
def b64(b): return base64.b64encode(b).decode()
def st_list(prefix):
    return json.dumps([{ 'path': p, 'size': len(f['bytes']), 'version': f['version'], 'modifiedTime': f['mtime'] } for p, f in FILES.items() if p.startswith(prefix)])
def st_stat(path):
    f = FILES.get(path)
    return json.dumps(None if not f else { 'path': path, 'size': len(f['bytes']), 'version': f['version'], 'modifiedTime': f['mtime'] })
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
    FILES[path] = { 'bytes': base64.b64decode(data), 'version': f'v{CTR[0]}', 'mtime': '2026-01-01T00:00:00.000Z' }
    LOG.append(('write', path))
    return json.dumps({'version': FILES[path]['version']})
def st_delete(path, mode, ifv):
    f = FILES.get(path)
    cur = f['version'] if f else None
    if mode == 'check' and cur != ifv: return json.dumps({'conflict': True, 'current': cur})
    LOG.append(('delete', path))
    return json.dumps(FILES.pop(path, None) is not None)

PROXY = r"""
async () => {
  const c = await import('/src/storage/contract.js');
  const unb64 = (s) => Uint8Array.from(atob(s), ch => ch.charCodeAt(0));
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
  const store = {
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
  window.__store = store;
  return true;
}
"""

SEED = r"""
async () => {
  const lib = await import('/src/libraryStore.js');
  const afs = await import('/src/audioSync/audioFileStore.js');
  const ss = await import('/src/audioSync/syncStore.js');
  const anc = await import('/src/audioSync/anchors.js');
  const sl = await import('/src/setlistStore.js');
  const enc = (s) => encodeURIComponent(String(s).toLowerCase());
  const sha = async (u8) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', u8)), b => b.toString(16).padStart(2,'0')).join('');
  const songKey = 'Test Artist - Roundtrip Song';
  const text = new TextEncoder().encode('e|---0---|\nB|---1---|\nG|---0---|\n');
  const tabSha = await sha(text);
  const s1 = await lib.saveSongToLibrary({ title: 'Roundtrip Song', artist: 'Test Artist', album: 'Test Album', year: 1999, pinned: true, mediumTitle: 'Disc two', mediumNumber: 2, hiddenTunings: ['D A D G B E'] });
  await lib.mapOpenFileToSong(new File([text], 'lead.txt', { type: 'text/plain' }), s1.id, 'My lead tab', 'local', 'lead.txt');
  const audio = crypto.getRandomValues(new Uint8Array(40000));
  const meta = await afs.saveAudioFile({ name: 'orig.mp3', type: 'audio/mpeg', data: audio.buffer, songKey, durationMs: 30000 });
  localStorage.setItem(`real_audio_source_${enc(songKey)}_original`, 'local');
  localStorage.setItem(`audio_file_${enc(songKey)}_original`, meta.id);
  ss.saveRecord(anc.scoreSyncKey(songKey, tabSha), { kind: 'local', audioId: meta.id, name: 'orig.mp3', durationMs: 30000 }, [{ timeMs: 1000, line: 0 }, { timeMs: 2500, line: 1 }], undefined, undefined, 'text');
  const s2 = await lib.saveSongToLibrary({ title: 'Second Song', artist: 'Other Artist', album: 'LP' });
  await lib.mapOpenFileToSong(new File([new TextEncoder().encode('e|---5---|\n')], 'two.txt', { type: 'text/plain' }), s2.id, 'two', 'local', 'two.txt');
  const g = await sl.createSetlist('Gig'); await sl.addToSetlist(g.id, s1.id, null);
  localStorage.setItem('majestictab_theme', 'dark');
  return { songKey, tabSha };
}
"""

SNAP = r"""
async ({ songKey, tabSha }) => {
  const lib = await import('/src/libraryStore.js');
  const afs = await import('/src/audioSync/audioFileStore.js');
  const ss = await import('/src/audioSync/syncStore.js');
  const anc = await import('/src/audioSync/anchors.js');
  const all = await lib.getAllLibraryData();
  return {
    songs: all.songs.map(s => ({ title: s.title, pinned: s.pinned, hidden: s.hiddenTunings, mediumTitle: s.mediumTitle, tabs: (s.tabOptions||[]).map(t => [t.name, !!t.fileStoreId]) })).sort((a,b)=>a.title.localeCompare(b.title)),
    setlists: all.setlists.map(s => [s.name, s.items.length]),
    audio: (await afs.listAudioFilesForSong(songKey)).map(a => a.size),
    syncPoints: ss.listRecords(anc.scoreSyncKey(songKey, tabSha)).map(r => r.points.length),
  };
}
"""

SYNC = r"""
async () => {
  const ps = await import('/src/storage/packSync.js');
  const loc = await import('/src/packSyncLocal.js');
  const info = await import('/src/storage/storeInfo.js');
  const store = window.__store;
  if (!(await store.stat('store.json'))) await info.writeStoreInfo(store, { appVersion: 'test' });
  const t0 = performance.now();
  const r = await ps.applyPackSync({ store, local: loc.createLocalAdapter(), baselines: loc.localBaselines, location: 'external store' });
  return { ...r, ms: Math.round(performance.now() - t0) };
}
"""

def device(b, name):
    ctx = b.new_context()
    for fn in (st_list, st_stat, st_read, st_write, st_delete): ctx.expose_function(fn.__name__, fn)
    pg = ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(f'pageerror: {e}'))
    pg.on('console', lambda m: errs.append(f'{m.type}: {m.text}') if m.type == 'error' and 'Failed to load resource' not in m.text else None)
    pg.goto('http://localhost:8000/src/', wait_until='load'); pg.wait_for_timeout(2500)
    pg.evaluate(PROXY)
    return pg, errs

def show(label, r):
    keys = ['uploaded','downloaded','merged','removedHere','removedThere','conflicts','failed','records','ms']
    print(f'{label}:', json.dumps({k: r[k] for k in keys}))

FAILS = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else f'  {detail}'))
    if not ok: FAILS.append(name)

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    try:
        A, ea = device(b, 'A'); B, eb = device(b, 'B')
        ctxA = A.evaluate(SEED)
        snapA = A.evaluate(SNAP, ctxA)
        r = A.evaluate(SYNC); check('A first sync uploads both songs', r['uploaded'] == 2 and not r['failed'], r)
        packs = {k.split('/')[1] for k in FILES if k.startswith('packs/')}
        check('the store holds two packs, the library and the profile', len(packs) == 2 and 'library.json' in FILES and 'profile.json' in FILES and 'store.json' in FILES, sorted(FILES))
        r = A.evaluate(SYNC); check('A syncing again moves nothing', all(r[k] == 0 for k in ('uploaded','downloaded','merged','removedHere','removedThere')) and not r['failed'], r)
        r = B.evaluate(SYNC); check('B first sync downloads both songs', r['downloaded'] == 2 and r['uploaded'] == 0 and not r['failed'], r)
        snapB = B.evaluate(SNAP, ctxA)
        check('B has what A has: songs, pins, tabs, setlist, audio, sync points', snapA == snapB, (snapA, snapB))
        r = B.evaluate(SYNC); check('B syncing again moves nothing', all(r[k] == 0 for k in ('uploaded','downloaded','merged','removedHere','removedThere')) and r['records']['pushed'] == 0, r)

        A.evaluate("""async ({songKey, tabSha}) => {
          const ss = await import('/src/audioSync/syncStore.js'); const anc = await import('/src/audioSync/anchors.js');
          const key = anc.scoreSyncKey(songKey, tabSha); const rec = ss.listRecords(key)[0];
          ss.saveRecord(key, rec.media, [...rec.points.map(p => ({ timeMs: p.timeMs, line: p.line ?? p.bar })), { timeMs: 4000, line: 2 }], undefined, undefined, 'text', { holdPrevious: true });
        }""", ctxA)
        r = A.evaluate(SYNC); check('a sync point added on A uploads only that song', r['uploaded'] == 1 and r['downloaded'] == 0, r)
        r = B.evaluate(SYNC); check('and B downloads it', r['downloaded'] == 1 and r['uploaded'] == 0, r)
        check('B now has three sync points', B.evaluate(SNAP, ctxA)['syncPoints'] == [3], B.evaluate(SNAP, ctxA)['syncPoints'])

        B.evaluate("async () => { const lib = await import('/src/libraryStore.js'); const s = (await lib.getAllSongs()).find(x => x.title === 'Second Song'); await lib.deleteSongFromLibrary(s.id); }")
        r = B.evaluate(SYNC); check('a song removed on B is removed from the store', r['removedThere'] == 1, r)
        r = A.evaluate(SYNC); check('and from A', r['removedHere'] == 1, r)
        check('A is left with one song', [s['title'] for s in A.evaluate(SNAP, ctxA)['songs']] == ['Roundtrip Song'])
        check('no page errors', not ea and not eb, (ea, eb))
    finally:
        b.close()

sys.exit(1 if FAILS else 0)
