#!/usr/bin/env python3
"""The Sync screen end to end against a real HTTP WebDAV server (the fake one in tests/storage), in real browsers.

 1. A new location: no upgrade prompt, review shows what will be sent, Sync now fills the store.
 2. An old-layout location: the upgrade prompt shows, Upgrade writes the new layout (old files stay), and a second
    device with an empty library then receives the songs through the same screen.
Needs the dev server (`python3 -m http.server 8000` from the repo root), node, and playwright with its bundled Chromium.
"""
import json, os, re, subprocess, sys, urllib.request
from playwright.sync_api import sync_playwright

SRC = open('tests/pack_sync_two_devices.py').read()
SEED = re.search(r'SEED = r"""(.*?)"""', SRC, re.S).group(1)
SNAP = re.search(r'SNAP = r"""(.*?)"""', SRC, re.S).group(1)

FAILS = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else f'  {detail}'))
    if not ok: FAILS.append(name)

def start_dav():
    proc = subprocess.Popen(['node', 'tests/storage/serveFakeDav.mjs'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    return proc, proc.stdout.readline().strip()

def dav_paths(url):
    """Every file the server holds, by walking it with PROPFIND (depth 1). Paths are relative to the server's /dav root."""
    import urllib.parse
    origin = url.split('/dav')[0]
    out = []
    def walk(href):
        req = urllib.request.Request(origin + href, method='PROPFIND', headers={'Depth': '1'})
        body = urllib.request.urlopen(req).read().decode()
        for m in re.finditer(r'<d:response><d:href>(.*?)</d:href>(.*?)</d:response>', body, re.S):
            h = m.group(1)
            if h.rstrip('/') == href.rstrip('/'): continue
            if '<d:collection/>' in m.group(2): walk(h)
            else: out.append(urllib.parse.unquote(h).removeprefix('/dav/'))
    walk('/dav/')
    return out

def device(b, dav_url):
    ctx = b.new_context(viewport={'width': 1200, 'height': 900})
    pg = ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(f'pageerror: {e}'))
    pg.on('console', lambda m: errs.append(f'{m.type}: {m.text}') if m.type == 'error' and 'Failed to load resource' not in m.text else None)
    pg.goto('http://localhost:8000/src/', wait_until='load'); pg.wait_for_timeout(2500)
    pg.evaluate("""(url) => {
      localStorage.setItem('majestictab_webdav_config', JSON.stringify({ url, username: '', password: '', folder: 'music' }));
      localStorage.setItem('majestictab_sync_target', 'webdav');
    }""", dav_url)
    return pg, errs

def open_sync(pg):
    # the plain `python3 -m http.server` now and then drops a module request; the import is simply tried again
    for attempt in range(3):
        try: return pg.evaluate("import('/src/syncUi.js').then(m => { m.openSyncModal(); return true; })")
        except Exception as e:
            if 'dynamically imported module' not in str(e) or attempt == 2: raise
            pg.wait_for_timeout(500)

def text(pg):
    return pg.evaluate("document.getElementById('syncModal')?.innerText || ''")

def wait_for(pg, pattern, timeout=60000):
    pg.wait_for_function("(p) => new RegExp(p, 'i').test(document.getElementById('syncModal')?.innerText || '')", arg=pattern, timeout=timeout)

def shot(pg, name):
    if os.environ.get('SHOTS'): pg.locator('#syncModal').screenshot(path=os.path.join(os.environ['SHOTS'], name + '.png'))

def click(pg, action):
    pg.click(f'#syncModal [data-sync-action="{action}"]')

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    dav, url = start_dav()
    try:
        key = pg_key = None
        # ---- 1. a new location ----
        A, ea = device(b, url)
        ctx = A.evaluate(SEED)
        open_sync(A)
        wait_for(A, 'Sync now')
        shot(A, 'review')
        t = text(A)
        check('a new location shows no upgrade prompt', 'Upgrade this backup location' not in t, t[:200])
        check('the review says 2 to send', re.search(r'2\s*to send', t) is not None, t[:300])
        click(A, 'apply'); wait_for(A, 'Sync complete')
        files = dav_paths(url)
        check('the store holds store.json, library.json and two packs under MajesticTab Library',
              all(any(f.endswith(x) for f in files) for x in ('MajesticTab Library/store.json', 'MajesticTab Library/library.json', 'MajesticTab Library/profile.json')) and len({f.split('/packs/')[1].split('/')[0] for f in files if '/packs/' in f}) == 2, files[:12])
        status = A.evaluate("document.getElementById('syncStatusLine')?.textContent || ''")
        check('the status line says when it last synced', 'Last synced' in status, status)
        # a second open finds nothing to do, quietly
        open_sync(A); wait_for(A, 'Everything is in sync')
        check('syncing again settles without a review', True)
        check('no page errors on A', not ea, ea)

        # ---- 2. an old-layout location, upgraded ----
        proc2, url2 = start_dav()
        try:
            C, ec = device(b, url2)
            C.evaluate(SEED)
            C.evaluate("""async () => {
              const se = await import('/src/syncEngine.js'); const wb = await import('/src/webdavBackup.js');
              const backend = wb.createWebDavBackend();
              const plan = await se.planSync(backend); await se.applySync(backend, plan);
            }""")
            old = dav_paths(url2)
            check('the old layout is on the server (manifests and blobs)', any('MajesticTab Backup/manifests/' in f for f in old) and any('MajesticTab Backup/blobs/' in f for f in old), old[:8])
            open_sync(C); wait_for(C, 'Upgrade this backup location')
            shot(C, 'upgrade')
            check('the upgrade prompt names what happens to the old copy', 'not changed or removed' in text(C))
            click(C, 'upgrade'); wait_for(C, 'Everything is in sync|Sync complete|Sync stopped', 120000)
            t = text(C)
            check('the upgrade finishes', 'Sync stopped' not in t, t[:400])
            after = dav_paths(url2)
            check('the new layout is written beside the old one', any(f.endswith('MajesticTab Library/store.json') for f in after) and len([f for f in after if '/packs/' in f and f.endswith('manifest.json')]) == 2, after[:20])
            check('the old files are all still there', all(f in after for f in old))
            open_sync(C); wait_for(C, 'Everything is in sync')
            check('and a second sync on that device finds nothing to do', True)
            # a fresh device receives the songs through the screen
            D, ed = device(b, url2)
            open_sync(D); wait_for(D, 'Sync now')
            t = text(D)
            check('a new device sees no upgrade prompt and 2 to receive', 'Upgrade this backup' not in t and re.search(r'2\s*to receive', t) is not None, t[:300])
            click(D, 'apply'); wait_for(D, 'Sync complete')
            snapC = C.evaluate(SNAP, ctx); snapD = D.evaluate(SNAP, ctx)
            check('the new device matches the upgraded one', snapC == snapD, (snapC, snapD))
            check('no page errors on C and D', not ec and not ed, (ec, ed))
        finally:
            proc2.stdin.close(); proc2.wait(timeout=5)
    finally:
        b.close()
        dav.stdin.close(); dav.wait(timeout=5)

sys.exit(1 if FAILS else 0)
