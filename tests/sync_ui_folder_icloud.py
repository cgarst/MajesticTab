#!/usr/bin/env python3
"""The Sync screen end to end for Local folder and iCloud Drive (via Tauri fs/dialog/invoke shim).

For each backend:
 1. A new location (picked through the Sync UI): no upgrade prompt, review shows 2 to send, Sync now fills the store.
 2. An old-layout location: the upgrade prompt shows, Upgrade writes the new layout (old files stay, marker written),
    and a second device with an empty library then receives the songs through the same screen.
Needs the dev server (`python3 -m http.server 8000` from the repo root) and playwright with its bundled Chromium.
"""
import base64, re, sys
from playwright.sync_api import sync_playwright

SRC = open('tests/pack_sync_two_devices.py').read()
SEED = re.search(r'SEED = r"""(.*?)"""', SRC, re.S).group(1)
SNAP = re.search(r'SNAP = r"""(.*?)"""', SRC, re.S).group(1)

FAILS = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else f'  {detail}'))
    if not ok: FAILS.append(name)

def eval_retry(pg, expr):
    for attempt in range(6):
        try: return pg.evaluate(expr)
        except Exception as e:
            if 'dynamically imported module' not in str(e) or attempt == 5: raise
            pg.wait_for_timeout(500)

def open_sync(pg):
    return eval_retry(pg, "import('/src/syncUi.js').then(m => { m.openSyncModal(); return true; })")

def text(pg):
    return pg.evaluate("document.getElementById('syncModal')?.innerText || ''")

def wait_for(pg, pattern, timeout=30000, errs=None):
    try:
        pg.wait_for_function("(p) => new RegExp(p, 'i').test(document.getElementById('syncModal')?.innerText || '')", arg=pattern, timeout=timeout)
    except Exception:
        print(f'TIMEOUT waiting for {pattern!r}; errs={errs}; modal text was: {text(pg)!r}')
        raise

def click(pg, action):
    pg.click(f'#syncModal [data-sync-action="{action}"]')

def make_mem_fs(root_path):
    """In-memory Tauri fs + dialog + icloud_drive_root backend shared across pages for one test."""
    files = {}
    dirs = {'/', root_path.rsplit('/', 1)[0] or '/', root_path}
    clock = [1700000000.0]

    def norm(p):
        return '/' + '/'.join(x for x in p.split('/') if x)

    def parent(p):
        p = norm(p)
        return '/' if p == '/' else norm(p.rsplit('/', 1)[0] or '/')

    def add_parents(p):
        cur = ''
        for part in norm(p).split('/'):
            if not part: continue
            cur += '/' + part
            dirs.add(cur)

    mtimes = {}
    inodes = {}
    ino_seq = [1]

    def call(op, arg1='', arg2=''):
        p = norm(arg1) if arg1 else ''
        if op in ('icloud_drive_root', 'dialog_open'): return root_path
        if op == 'icloud_download': return None
        if op == 'exists': return p in files or p in dirs
        if op == 'mkdir':
            add_parents(p)
            return None
        if op == 'readDir':
            if p not in dirs: raise RuntimeError(f'No such file or directory: {p}')
            out = []
            seen = set()
            prefix = '' if p == '/' else p + '/'
            for d in dirs:
                if d.startswith(prefix) and d != p:
                    rest = d[len(prefix):]
                    if '/' not in rest and rest not in seen:
                        seen.add(rest)
                        out.append({'name': rest, 'isFile': False, 'isDirectory': True})
            for f in files:
                if f.startswith(prefix):
                    rest = f[len(prefix):]
                    if '/' not in rest and rest not in seen:
                        seen.add(rest)
                        out.append({'name': rest, 'isFile': True, 'isDirectory': False})
            return out
        if op == 'stat':
            if p in dirs:
                return {'size': 0, 'mtime': mtimes.get(p, clock[0]), 'ino': 0, 'isDirectory': True, 'isFile': False}
            if p in files:
                return {'size': len(files[p]), 'mtime': mtimes.get(p, clock[0]), 'ino': inodes.get(p, 1), 'isDirectory': False, 'isFile': True}
            raise RuntimeError(f'No such file or directory: {p}')
        if op == 'readFile':
            if p not in files: raise RuntimeError(f'No such file or directory: {p}')
            return base64.b64encode(files[p]).decode('ascii')
        if op == 'writeFile':
            add_parents(parent(p))
            files[p] = base64.b64decode(arg2)
            clock[0] += 0.001
            mtimes[p] = clock[0]
            inodes[p] = ino_seq[0]; ino_seq[0] += 1
            return None
        if op == 'rename':
            dst = norm(arg2)
            if p not in files: raise RuntimeError(f'No such file or directory: {p}')
            add_parents(parent(dst))
            files[dst] = files.pop(p)
            clock[0] += 0.001
            mtimes[dst] = clock[0]
            inodes[dst] = inodes.pop(p, ino_seq[0])
            return None
        if op == 'remove':
            files.pop(p, None)
            dirs.discard(p)
            prefix = p + '/'
            for k in [k for k in files if k.startswith(prefix)]: files.pop(k, None)
            for d in [d for d in dirs if d.startswith(prefix)]: dirs.discard(d)
            return None
        raise RuntimeError(f'Unknown op: {op}')

    return files, dirs, call

TAURI_INIT = """(() => {
  try { Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel', configurable: true }); } catch (_) {}
  const b64ToU8 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const u8ToB64 = (u) => {
    const a = u instanceof Uint8Array ? u : new Uint8Array(u);
    let bin = '';
    for (let i = 0; i < a.length; i += 0x8000) bin += String.fromCharCode(...a.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  window.__TAURI__ = {
    core: { invoke: (cmd, args) => window.__tauriBridge(cmd, args?.path || '') },
    event: { listen: async () => () => {} },
    dialog: { open: () => window.__tauriBridge('dialog_open', '') },
    fs: {
      exists: (p) => window.__tauriBridge('exists', p),
      mkdir: (p) => window.__tauriBridge('mkdir', p),
      readDir: (p) => window.__tauriBridge('readDir', p),
      stat: (p) => window.__tauriBridge('stat', p),
      readFile: async (p) => b64ToU8(await window.__tauriBridge('readFile', p)),
      readTextFile: async (p) => new TextDecoder().decode(b64ToU8(await window.__tauriBridge('readFile', p))),
      writeFile: (p, bytes) => window.__tauriBridge('writeFile', p, u8ToB64(bytes)),
      writeTextFile: (p, text) => window.__tauriBridge('writeFile', p, u8ToB64(new TextEncoder().encode(text))),
      rename: (a, b) => window.__tauriBridge('rename', a, b),
      remove: (p) => window.__tauriBridge('remove', p),
    }
  };
})();"""

def new_tauri_page(b, bridge_fn):
    ctx = b.new_context(viewport={'width': 1200, 'height': 900})
    pg = ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(f'pageerror: {e}'))
    pg.on('console', lambda m: errs.append(f'{m.type}: {m.text}') if m.type == 'error' and 'Failed to load resource' not in m.text else None)
    pg.expose_function('__tauriBridge', bridge_fn)
    pg.add_init_script(TAURI_INIT)
    pg.goto('http://localhost:8000/src/', wait_until='load')
    pg.wait_for_timeout(2000)
    return pg, errs, ctx

def run_suite(b, label, root_path, target, action, legacy_handle_expr):
    files1, _, call1 = make_mem_fs(root_path)
    A, ea, ctx1 = new_tauri_page(b, call1)
    ctx = eval_retry(A, SEED)
    open_sync(A)
    wait_for(A, 'Choose where MajesticTab keeps your synced library', errs=ea)
    click(A, action)
    wait_for(A, 'Sync now', errs=ea)
    t = text(A)
    check(f'{label} new: no upgrade prompt', 'Upgrade this backup location' not in t, t[:200])
    check(f'{label} new: review says 2 to send', re.search(r'2\s*to send', t) is not None, t[:300])
    click(A, 'apply'); wait_for(A, 'Sync complete', errs=ea)
    keys = sorted(files1.keys())
    check(f'{label} new: store holds store.json, library.json, profile.json, 2 packs',
          all(f'{root_path}/MajesticTab Library/{x}' in keys for x in ('store.json', 'library.json', 'profile.json'))
          and len([k for k in keys if '/MajesticTab Library/packs/' in k and k.endswith('/manifest.json')]) == 2, keys[:12])
    open_sync(A); wait_for(A, 'Everything is in sync', errs=ea)
    check(f'{label} new: second sync settles without a review', True)
    check(f'{label} new: no page errors on A', not ea, ea)
    ctx1.close()

    files2, _, call2 = make_mem_fs(root_path)
    C, ec, ctx2 = new_tauri_page(b, call2)
    eval_retry(C, SEED)
    eval_retry(C, f"""async () => {{
      const se = await import('/src/syncEngine.js'); const fb = await import('/src/folderBackup.js');
      const handle = {legacy_handle_expr};
      const backend = fb.createFolderBackend(handle);
      const plan = await se.planSync(backend); await se.applySync(backend, plan);
      localStorage.setItem('majestictab_sync_target', {target!r});
    }}""")
    open_sync(C); wait_for(C, 'Upgrade this backup location', errs=ec)
    click(C, 'upgrade'); wait_for(C, 'Everything is in sync|Sync complete|Sync stopped', timeout=120000, errs=ec)
    t = text(C)
    check(f'{label} upgrade: finishes without error', 'Sync stopped' not in t, t[:400])
    after = sorted(files2.keys())
    check(f'{label} upgrade: new layout written beside old', f'{root_path}/MajesticTab Library/store.json' in after and len([k for k in after if '/MajesticTab Library/packs/' in k and k.endswith('/manifest.json')]) == 2, after[:20])
    check(f'{label} upgrade: marker written', f'{root_path}/MajesticTab Backup/manifests/manifest-UPGRADED.json' in after)
    refused = eval_retry(C, f"""async () => {{
      const se = await import('/src/syncEngine.js'); const fb = await import('/src/folderBackup.js');
      const ib = await import('/src/incrementalBackup.js');
      const handle = {legacy_handle_expr};
      const backend = fb.createFolderBackend(handle);
      const snaps = await ib.listIncrementalBackups(backend);
      try {{ await se.planSync(backend); return {{ snaps: snaps.length, refused: false }}; }}
      catch (e) {{ return {{ snaps: snaps.length, refused: e.name === 'UpgradedLocationError', text: e.message }}; }}
    }}""")
    check(f'{label} upgrade: old-layout sync refused & snapshots still listed', refused['refused'] and refused['snaps'] >= 1, refused)
    snapC = C.evaluate(SNAP, ctx)
    ctx2.close()

    D, ed, ctx3 = new_tauri_page(b, call2)
    if target == 'folder':
        D.evaluate(f"localStorage.setItem('majestictab_backup_folder_path', {root_path!r});")
    D.evaluate(f"localStorage.setItem('majestictab_sync_target', {target!r});")
    open_sync(D); wait_for(D, 'Sync now', errs=ed)
    t = text(D)
    check(f'{label} upgrade: fresh device sees 2 to receive', 'Upgrade this backup' not in t and re.search(r'2\s*to receive', t) is not None, t[:300])
    click(D, 'apply'); wait_for(D, 'Sync complete', errs=ed)
    check(f'{label} upgrade: fresh device matches upgraded device', snapC == D.evaluate(SNAP, ctx))
    check(f'{label} upgrade: no page errors on C and D', not ec and not ed, (ec, ed))
    ctx3.close()

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    try:
        run_suite(b, 'Folder', '/local/MajesticTab', 'folder', 'pick-folder', 'await fb.pickBackupFolder()')
        run_suite(b, 'iCloud', '/icloud/MajesticTab', 'icloud', 'pick-icloud', 'await fb.getIcloudBackupFolder()')
    finally:
        b.close()

sys.exit(1 if FAILS else 0)
