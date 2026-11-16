#!/usr/bin/env python3
"""The Sync screen end to end against fake S3 and Google Drive HTTP servers in real browsers.

For each backend (S3 and Drive):
 1. A new location (picked through the Sync UI): no upgrade prompt, review shows 2 to send, Sync now fills the store.
 2. An old-layout location: the upgrade prompt shows, Upgrade writes the new layout (old files stay, marker written),
    and a second device with an empty library then receives the songs through the same screen.
Needs the dev server (`python3 -m http.server 8000` from the repo root), node, and playwright with its bundled Chromium.
"""
import json, re, subprocess, sys, urllib.parse, urllib.request
from playwright.sync_api import sync_playwright

SRC = open('tests/pack_sync_two_devices.py').read()
SEED = re.search(r'SEED = r"""(.*?)"""', SRC, re.S).group(1)
SNAP = re.search(r'SNAP = r"""(.*?)"""', SRC, re.S).group(1)

FAILS = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else f'  {detail}'))
    if not ok: FAILS.append(name)

def start_server(script):
    proc = subprocess.Popen(['node', script], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    return proc, proc.stdout.readline().strip()

def s3_keys(endpoint, bucket='bkt'):
    keys = []
    token = ''
    while True:
        qs = 'list-type=2&max-keys=100' + (f'&continuation-token={urllib.parse.quote(token)}' if token else '')
        req = urllib.request.Request(f'{endpoint}/{bucket}?{qs}', headers={'Authorization': 'AWS4-HMAC-SHA256 fake'})
        xml = urllib.request.urlopen(req).read().decode()
        keys.extend(re.findall(r'<Key>(.*?)</Key>', xml))
        m = re.search(r'<NextContinuationToken>(.*?)</NextContinuationToken>', xml)
        if not m: break
        token = m.group(1)
    return keys

def drive_files(base):
    out = []
    token = ''
    while True:
        qs = 'pageSize=100' + (f'&pageToken={urllib.parse.quote(token)}' if token else '')
        req = urllib.request.Request(f'{base}/drive/v3/files?{qs}', headers={'Authorization': 'Bearer fake'})
        data = json.loads(urllib.request.urlopen(req).read().decode())
        out.extend(data.get('files', []))
        token = data.get('nextPageToken', '')
        if not token: break
    return out

def new_page(b, drive_base=None):
    ctx = b.new_context(viewport={'width': 1200, 'height': 900})
    if drive_base:
        def forward_drive(route):
            req = route.request
            target = req.url.replace('https://www.googleapis.com', drive_base, 1)
            resp = route.fetch(url=target)
            route.fulfill(response=resp)
        ctx.route('https://www.googleapis.com/**', forward_drive)
    pg = ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(f'pageerror: {e}'))
    pg.on('console', lambda m: errs.append(f'{m.type}: {m.text}') if m.type == 'error' and 'Failed to load resource' not in m.text else None)
    pg.goto('http://localhost:8000/src/', wait_until='load')
    pg.wait_for_timeout(2000)
    return pg, errs

def eval_retry(pg, expr):
    for attempt in range(3):
        try: return pg.evaluate(expr)
        except Exception as e:
            if 'dynamically imported module' not in str(e) or attempt == 2: raise
            pg.wait_for_timeout(500)

def open_sync(pg):
    return eval_retry(pg, "import('/src/syncUi.js').then(m => { m.openSyncModal(); return true; })")

def text(pg):
    return pg.evaluate("document.getElementById('syncModal')?.innerText || ''")

def wait_for(pg, pattern, timeout=20000):
    try:
        pg.wait_for_function("(p) => new RegExp(p, 'i').test(document.getElementById('syncModal')?.innerText || '')", arg=pattern, timeout=timeout)
    except Exception:
        print(f'TIMEOUT waiting for {pattern!r}; modal text was: {text(pg)!r}')
        raise

def click(pg, action):
    pg.click(f'#syncModal [data-sync-action="{action}"]')

def seed_s3_config(pg, endpoint):
    pg.evaluate("""(endpoint) => {
      localStorage.setItem('majestictab_s3_config', JSON.stringify({
        endpoint, region: 'us-east-1', bucket: 'bkt',
        accessKeyId: 'testkey', secretAccessKey: 'testsecret', prefix: '', pathStyle: true
      }));
      localStorage.setItem('majestictab_sync_target', 's3');
    }""", endpoint)

def seed_drive_auth(pg):
    pg.evaluate("""() => {
      localStorage.setItem('gdrive_auth', JSON.stringify({
        v: 2, access_token: 'fake-token', expiry_date: Date.now() + 3600000
      }));
    }""")

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    try:
        # ==================== S3 ====================
        s3_1, ep1 = start_server('tests/storage/serveFakeS3.mjs')
        try:
            A, ea = new_page(b)
            ctx = A.evaluate(SEED)
            open_sync(A)
            wait_for(A, 'Choose where MajesticTab keeps your synced library')
            click(A, 'pick-s3')
            wait_for(A, 'Save and connect')
            A.fill('#s3Bucket', 'bkt')
            A.fill('#s3Endpoint', ep1)
            A.fill('#s3Region', 'us-east-1')
            A.fill('#s3AccessKey', 'testkey')
            A.fill('#s3Secret', 'testsecret')
            A.check('#s3PathStyle')
            click(A, 'save-s3')
            wait_for(A, 'Sync now')
            t = text(A)
            check('S3 new: no upgrade prompt', 'Upgrade this backup location' not in t, t[:200])
            check('S3 new: review says 2 to send', re.search(r'2\s*to send', t) is not None, t[:300])
            click(A, 'apply'); wait_for(A, 'Sync complete')
            keys = s3_keys(ep1)
            check('S3 new: store holds store.json, library.json, profile.json, 2 packs',
                  all(any(k.endswith(x) for k in keys) for x in ('MajesticTab Library/store.json', 'MajesticTab Library/library.json', 'MajesticTab Library/profile.json'))
                  and len({k.split('/packs/')[1].split('/')[0] for k in keys if '/packs/' in k}) == 2, keys[:12])
            open_sync(A); wait_for(A, 'Everything is in sync')
            check('S3 new: second sync settles without a review', True)
            check('S3 new: no page errors on A', not ea, ea)
        finally:
            s3_1.stdin.close(); s3_1.wait(timeout=5)

        s3_2, ep2 = start_server('tests/storage/serveFakeS3.mjs')
        try:
            C, ec = new_page(b)
            C.evaluate(SEED)
            seed_s3_config(C, ep2)
            eval_retry(C, """async () => {
              const se = await import('/src/syncEngine.js'); const sb = await import('/src/s3Backup.js');
              const backend = sb.createS3Backend();
              const plan = await se.planSync(backend); await se.applySync(backend, plan);
            }""")
            old = s3_keys(ep2)
            check('S3 upgrade: old layout is on the server', any('MajesticTab Backup/manifests/' in k for k in old) and any('MajesticTab Backup/blobs/' in k for k in old), old[:8])
            open_sync(C); wait_for(C, 'Upgrade this backup location')
            click(C, 'upgrade'); wait_for(C, 'Everything is in sync|Sync complete|Sync stopped', 120000)
            t = text(C)
            check('S3 upgrade: finishes without error', 'Sync stopped' not in t, t[:400])
            after = s3_keys(ep2)
            check('S3 upgrade: new layout written beside old', any(k.endswith('MajesticTab Library/store.json') for k in after) and len([k for k in after if '/packs/' in k and k.endswith('manifest.json')]) == 2, after[:20])
            check('S3 upgrade: old files all still there', all(k in after for k in old))
            check('S3 upgrade: marker written', any(k.endswith('MajesticTab Backup/manifests/manifest-UPGRADED.json') for k in after))
            refused = C.evaluate("""async () => {
              const se = await import('/src/syncEngine.js'); const sb = await import('/src/s3Backup.js');
              const ib = await import('/src/incrementalBackup.js');
              const backend = sb.createS3Backend();
              const snaps = await ib.listIncrementalBackups(backend);
              try { await se.planSync(backend); return { snaps: snaps.length, refused: false }; }
              catch (e) { return { snaps: snaps.length, refused: e.name === 'UpgradedLocationError', text: e.message }; }
            }""")
            check('S3 upgrade: old-layout sync refused & snapshots still listed', refused['refused'] and refused['snaps'] >= 1, refused)
            D, ed = new_page(b)
            seed_s3_config(D, ep2)
            open_sync(D); wait_for(D, 'Sync now')
            t = text(D)
            check('S3 upgrade: fresh device sees 2 to receive', 'Upgrade this backup' not in t and re.search(r'2\s*to receive', t) is not None, t[:300])
            click(D, 'apply'); wait_for(D, 'Sync complete')
            check('S3 upgrade: fresh device matches upgraded device', C.evaluate(SNAP, ctx) == D.evaluate(SNAP, ctx))
            check('S3 upgrade: no page errors on C and D', not ec and not ed, (ec, ed))
        finally:
            s3_2.stdin.close(); s3_2.wait(timeout=5)

        # ==================== Google Drive ====================
        gd_1, gd_url1 = start_server('tests/storage/serveFakeDrive.mjs')
        try:
            A, ea = new_page(b, gd_url1)
            ctx = A.evaluate(SEED)
            seed_drive_auth(A)
            open_sync(A)
            wait_for(A, 'Choose where MajesticTab keeps your synced library')
            click(A, 'pick-google-drive')
            wait_for(A, 'Sync now')
            t = text(A)
            check('Drive new: no upgrade prompt', 'Upgrade this backup location' not in t, t[:200])
            check('Drive new: review says 2 to send', re.search(r'2\s*to send', t) is not None, t[:300])
            click(A, 'apply'); wait_for(A, 'Sync complete')
            names = [f['name'] for f in drive_files(gd_url1)]
            check('Drive new: store holds store.json, library.json, profile.json, 2 manifest.json',
                  all(x in names for x in ('MajesticTab Library', 'store.json', 'library.json', 'profile.json'))
                  and names.count('manifest.json') == 2, names)
            open_sync(A); wait_for(A, 'Everything is in sync')
            check('Drive new: second sync settles without a review', True)
            check('Drive new: no page errors on A', not ea, ea)
        finally:
            gd_1.stdin.close(); gd_1.wait(timeout=5)

        gd_2, gd_url2 = start_server('tests/storage/serveFakeDrive.mjs')
        try:
            C, ec = new_page(b, gd_url2)
            C.evaluate(SEED)
            seed_drive_auth(C)
            C.evaluate("""() => localStorage.setItem('majestictab_sync_target', 'google-drive')""")
            eval_retry(C, """async () => {
              const se = await import('/src/syncEngine.js'); const db = await import('/src/driveBackup.js');
              const backend = db.createDriveBackend();
              const plan = await se.planSync(backend); await se.applySync(backend, plan);
            }""")
            old_names = [f['name'] for f in drive_files(gd_url2)]
            check('Drive upgrade: old layout is on the server', 'MajesticTab Backup' in old_names and 'manifests' in old_names and 'blobs' in old_names, old_names)
            open_sync(C); wait_for(C, 'Upgrade this backup location')
            click(C, 'upgrade'); wait_for(C, 'Everything is in sync|Sync complete|Sync stopped', 120000)
            t = text(C)
            check('Drive upgrade: finishes without error', 'Sync stopped' not in t, t[:400])
            after_names = [f['name'] for f in drive_files(gd_url2)]
            check('Drive upgrade: new layout written beside old', 'MajesticTab Library' in after_names and 'store.json' in after_names and after_names.count('manifest.json') == 2, after_names)
            check('Drive upgrade: marker written', 'manifest-UPGRADED.json' in after_names)
            refused = C.evaluate("""async () => {
              const se = await import('/src/syncEngine.js'); const db = await import('/src/driveBackup.js');
              const ib = await import('/src/incrementalBackup.js');
              const backend = db.createDriveBackend();
              const snaps = await ib.listIncrementalBackups(backend);
              try { await se.planSync(backend); return { snaps: snaps.length, refused: false }; }
              catch (e) { return { snaps: snaps.length, refused: e.name === 'UpgradedLocationError', text: e.message }; }
            }""")
            check('Drive upgrade: old-layout sync refused & snapshots still listed', refused['refused'] and refused['snaps'] >= 1, refused)
            D, ed = new_page(b, gd_url2)
            seed_drive_auth(D)
            D.evaluate("""() => localStorage.setItem('majestictab_sync_target', 'google-drive')""")
            open_sync(D); wait_for(D, 'Sync now')
            t = text(D)
            check('Drive upgrade: fresh device sees 2 to receive', 'Upgrade this backup' not in t and re.search(r'2\s*to receive', t) is not None, t[:300])
            click(D, 'apply'); wait_for(D, 'Sync complete')
            check('Drive upgrade: fresh device matches upgraded device', C.evaluate(SNAP, ctx) == D.evaluate(SNAP, ctx))
            check('Drive upgrade: no page errors on C and D', not ec and not ed, (ec, ed))
        finally:
            gd_2.stdin.close(); gd_2.wait(timeout=5)
    finally:
        b.close()

sys.exit(1 if FAILS else 0)
