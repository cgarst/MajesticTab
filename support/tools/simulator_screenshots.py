#!/usr/bin/env python3
"""App Store screenshots captured from the real thing: the iOS 27 Simulator (iPhone, iPad, iPhone Duo) and the real Mac window.

Nothing is emulated. The native shell draws its own system chrome (the Liquid Glass tab bar and search field from
build/tauri/plugins/apple-nav, the status bar, the Dynamic Island), and a browser capture can never show that. So the app is
built for the simulator with the `debug-tools` feature (its debug bridge, port 9560 here, is how this script seeds the library and
presses the same buttons the browser tool presses), the status bar is set to 9:41 with full signal, and `simctl io screenshot`
takes the picture at the device's native pixel size. The marketing frame is the same flat one as the other stores: a headline above the capture, which sits in a flat device
(rim, glass, Dynamic Island and keys, drawn by store_screenshots.device_html because the simulator never draws hardware; the iPhone
Duo gets a thin bezel with no camera).

Usage (macOS, Xcode 27 with the iOS 27.2 runtimes; pip install playwright pillow && playwright install chromium):
    python3 support/tools/simulator_screenshots.py iphone                 # iPhone 18 Pro Max, 1320x2868 (the 6.9" slot)
    python3 support/tools/simulator_screenshots.py ipad                   # iPad Pro 13" (M5), 2064x2752 (the 13" slot; --landscape for 2752x2064)
    python3 support/tools/simulator_screenshots.py duo                    # iPhone Duo: flat, tabletop and book (folded with agent-device)
    python3 support/tools/simulator_screenshots.py mac                    # the real Mac window, composed on 2880x1800
    python3 support/tools/simulator_screenshots.py iphone --only reader library
    python3 support/tools/simulator_screenshots.py iphone --no-build      # reuse the simulator app already built
    python3 support/tools/simulator_screenshots.py all                    # builds once, then iphone, ipad, duo and mac, then the header and search art (apple_marketing_art.py)

Output: support/store/appstore-<device>/NN-<shot>.png (framed), raw/ beside it with the untouched captures (--raw keeps them).
Apple takes the raw captures as they are (they are exactly the required size), so either set can be uploaded.
Why not Playwright: see store_screenshots.py, which still makes the Android, Windows and website shots.
"""
import argparse
import base64
import http.server
import json
import re
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import store_screenshots as ss  # noqa: E402  (shot list, setups, frame CSS)

ROOT = ss.ROOT
TAURI = ss.TAURI_DIR
BUNDLE_ID = "net.zathu.majestictab"
BRIDGE_PORT = 9560  # not the default 9555, which another session on this Mac may own
BRIDGE = f"http://127.0.0.1:{BRIDGE_PORT}/eval"
FIXTURE_PORT = 8765  # fixtures and album sleeves, served with CORS (a tauri:// page fetches them); loopback only
SIM_APP = TAURI / "src-tauri" / "gen" / "apple" / "build" / "arm64-sim" / "MajesticTab.app"

DEVICES = {
    "iphone": dict(kind="sim", model="iPhone 18 Pro Max", channel="appstore-ios", out="appstore-ios", final=(1320, 2868), bezel="iphone"),
    "ipad": dict(kind="sim", model="iPad Pro 13-inch (M5)", channel="appstore-ios", out="appstore-ipad", final=None, bezel="ipad"),
    "duo": dict(kind="sim", model="iPhone Duo", channel="appstore-ios", out="appstore-duo", final=None, bezel="foldable"),
    "mac": dict(kind="mac", channel="appstore-mac", out="appstore-mac", final=(2880, 1800), bezel="laptop"),
}

DUO_SHOTS = [  # (pose to fold the device to, shot id, headline, subtitle). The first two decide the click, so the tabletop reader leads.
    ("tabletop", "reader", "Tab on top, controls below", "Fold your iPhone Duo and the score fills the top half."),
    ("tabletop", "practice", "Practice at your pace", "Speed, loops, count-in and metronome, under your thumb."),
    ("book", "reader", "Two pages, one crease", "Book mode shows a page on each half, like a real book."),
    ("flat", "library", "A library, not a folder", "Artists, albums and tracklists for every song you play."),
    ("flat", "original", "Play along with the record", "Tap to sync, and the cursor follows the original."),
    ("flat", "guitar", "Fit it to your guitar", "7 and 8 strings, tunings and capo, every pitch kept."),
    ("closed", "tunings", "Browse by tuning", "Build a set that needs no retuning."),
    ("flat", "jam", "Jam in the same room", "Everyone on the same bar, from their own device."),
]


def run(cmd, **kw):
    return subprocess.run(cmd, check=True, text=True, capture_output=True, **kw).stdout


# --- Fixture server --------------------------------------------------------------------------------
class _Cors(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_message(self, *a):
        pass


def start_fixture_server():
    handler = lambda *a, **k: _Cors(*a, directory=str(ROOT), **k)  # noqa: E731
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", FIXTURE_PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


# --- The app, through the debug bridge --------------------------------------------------------------
_FN = re.compile(r"^\s*(async\s+)?(\([^()]*\)|\w+)\s*=>")


class App:
    """Just enough of Playwright's Page for store_screenshots.setup_shot, on top of the app's own debug bridge."""

    def evaluate(self, src, arg=None):
        src = src.replace("'/src/", "'/")  # the native shell serves the frontend at /, the browser tool at /src/
        expr = f"({src})({json.dumps(arg)})" if (_FN.match(src) or src.lstrip().startswith(("function", "async function"))) else src
        req = urllib.request.Request(BRIDGE, data=expr.encode(), method="POST")
        with urllib.request.urlopen(req, timeout=60) as r:
            out = json.load(r)
        if not out.get("ok"):
            raise RuntimeError(f"bridge: {out}")
        return out.get("value")

    def wait_for_timeout(self, ms):
        time.sleep(ms / 1000)

    def wait_for_function(self, expr, timeout=30000):
        end = time.time() + timeout / 1000
        while time.time() < end:
            try:
                if self.evaluate(expr):
                    return
            except Exception:
                pass
            time.sleep(0.4)
        raise TimeoutError(expr[:80])

    def wait_for_selector(self, sel, state=None, timeout=10000):
        self.wait_for_function(f"!!document.querySelector({json.dumps(sel)})", timeout)

    def goto(self, url, **_):
        """Navigate the app. `.../src/?x` from the browser tool maps to the app root."""
        rest = re.sub(r"^https?://[^/]+/src/?", "", url)
        if "test=" in rest:
            rest += "&test_base=" + urllib.parse.quote(f"http://localhost:{FIXTURE_PORT}/tests/", safe="")
        self.evaluate(f"(() => {{ setTimeout(() => {{ location.href = location.origin + '/' + {json.dumps(rest)}; }}, 50); return 1; }})()")
        time.sleep(1.5)
        self.wait_for_function("document.readyState === 'complete'", 60000)


def wait_bridge(app, seconds=60):
    end = time.time() + seconds
    while time.time() < end:
        try:
            app.evaluate("1")
            return
        except Exception:
            time.sleep(1)
    raise SystemExit(f"The debug bridge never answered on port {BRIDGE_PORT}. Is the app a debug-tools build, and is no other copy running?")


def seed_native(app, kind):
    """Seed the library (artists, albums, sleeves fetched from the fixture server) like ss.seed_library, inside the app."""
    app.goto("http://x/src/")
    app.evaluate("""async ([d, base]) => {
        const m = await import('/libraryStore.js');
        const toData = async (u) => { const b = await (await fetch(u)).blob(); return await new Promise((r) => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); }); };
        for (const s of await m.getSongsByCollection()) await m.deleteSongFromLibrary(s.id);
        await m.clearRecents();
        let i = 0, k = 0;
        for (const [artist, albums] of Object.entries(d.library)) {
            let year = 2008;
            for (const [album, tracks] of Object.entries(albums)) {
                year += 2; let tn = 1;
                const slug = (artist + '_' + album).replace(/[^\\w]/g, '_').toLowerCase();
                const cover = await toData(base + '/support/store/.cover-cache/' + slug + '.jpg');
                for (const title of tracks) {
                    const tuning = d.tunings[i++ % d.tunings.length];
                    const song = await m.saveSongToLibrary({ title, artist, album, year, trackNumber: tn++, coverUrl: cover, tunings: [tuning], stringCount: /^7/.test(tuning) ? 7 : 6 });
                    k++; if (k % 4 === 0) continue;
                    const ft = ['gp', 'gp', 'pdf', 'gp', 'txt'][k % 5], ext = { gp: 'gp5', pdf: 'pdf', txt: 'txt' }[ft];
                    await m.addTabOptionToSong(song.id, { name: title + '.' + ext, fileType: ft, tuning, stringCount: song.stringCount, isDefault: true, fileStoreId: 'demo_' + song.id });
                }
            }
        }
    }""", [ss._demo, f"http://localhost:{FIXTURE_PORT}"])


def setup_jam_native(app):
    """The Jam shot: host a Jam with two players who have the song and are in sync, each on their own track. Jam needs other devices on
    the network, so the transport is the test mock (tests/jam/mockTauri.js) put in front of the real native bridge: only the jam_*
    commands and jam-* events go to the mock, everything else (the glass tab bar, the status bar, the shell) stays real."""
    ss.open_reader(app, "http://x")
    mock = ss.JAM_MOCK.read_text()
    # The app subscribed to the jam-* events at load, before the mock existed, so the mock's events must also go out through the real event
    # channel, which those listeners hear.
    emit_line = "const emit = (ev, payload) => (listeners[ev] || []).forEach((cb) => cb({ payload }));"
    assert emit_line in mock, "tests/jam/mockTauri.js changed: update setup_jam_native"
    mock = mock.replace(emit_line, "const emit = (ev, payload) => { (listeners[ev] || []).forEach((cb) => cb({ payload })); try { window.__realEmit(ev, payload); } catch (e) {} };")
    app.evaluate("(() => { const real = window.__TAURI__; window.__realEmit = (ev, payload) => real.event.emit(ev, payload); window.__jamMockRole = 'host';\n" + mock + """
        const fake = window.__TAURI__;
        const wrapped = Object.assign({}, real, {
          core: Object.assign({}, real.core, { invoke: (cmd, args, ...rest) => (String(cmd).startsWith('jam_') ? fake.core.invoke(cmd, args) : real.core.invoke(cmd, args, ...rest)) }),
          event: Object.assign({}, real.event, { listen: (ev, cb, ...rest) => (String(ev).startsWith('jam-') ? fake.event.listen(ev, cb) : real.event.listen(ev, cb, ...rest)) }),
        });
        window.__TAURI__ = wrapped;
        return window.__TAURI__ === wrapped; })()""")
    ss.click(app, "#toolsToggleBtn")
    app.wait_for_timeout(600)
    ss.click(app, "#jamToggleBtn")
    app.wait_for_timeout(700)
    app.evaluate("(() => { document.querySelector('[data-jam-tab=host]')?.click(); return 1; })()")
    app.wait_for_timeout(300)
    app.evaluate("(() => { document.getElementById('jamStartHostBtn')?.click(); return 1; })()")
    app.wait_for_timeout(1800)
    for pid, name in ss.JAM_PLAYERS:
        app.evaluate("([id, name]) => window.__jamMock.join(id, name)", [pid, name])
    app.wait_for_timeout(500)
    for pid, _ in ss.JAM_PLAYERS:
        app.evaluate("(id) => window.__jamMock.sync(id)", pid)
    app.wait_for_selector(".jam-matrix-cell", timeout=10000)
    tracks = app.evaluate("document.querySelectorAll('.jam-matrix-col').length - 1")
    pick = "([sel, n]) => { const e = document.querySelectorAll(sel)[n]; if (e) e.click(); return !!e; }"
    for n, (pid, _) in enumerate(ss.JAM_PLAYERS):
        app.evaluate(pick, [f".jam-matrix-cell[data-jam-assign='{pid}'][data-jam-track]", n % max(tracks, 1)])
        app.wait_for_timeout(250)
    app.evaluate(pick, [".jam-matrix-cell[data-jam-listening='host']", 0])
    app.wait_for_timeout(250)
    app.evaluate(pick, ["[data-jam-rule='assignedAudioMode'][data-jam-value='backing']", 0])
    app.wait_for_timeout(250)
    app.evaluate(pick, ["[data-jam-rule='assignedViewOnly'][data-jam-value='own']", 0])
    app.wait_for_timeout(250)
    app.evaluate("(() => { const b = document.getElementById('jamModalBody'); if (b) b.scrollTop = 0; return 1; })()")


def prepare_shot(app, shot, store_zoom=None):
    """Theme, sheet zoom and density live in localStorage; set them, then run the browser tool's own setup for the shot."""
    zoom = store_zoom
    if shot.get("zoom_factor"):
        zoom = round((zoom or 100) * shot["zoom_factor"])
    app.evaluate("""(a) => { try { localStorage.setItem('majestictab_theme', a.theme);
        if (a.zoom) localStorage.setItem('gpSheetScale', String(a.zoom)); else localStorage.removeItem('gpSheetScale');
        if (a.density) localStorage.setItem('gpNoteDensity', a.density); else localStorage.removeItem('gpNoteDensity');
        localStorage.setItem('hasSeenControllerGuide', 'true'); } catch (e) {} return 1; }""",
                 dict(theme=shot.get("theme", "Slate Blue"), zoom=zoom, density=shot.get("density")))
    kind = shot["setup"]
    if kind == "jam":
        setup_jam_native(app)
        app.wait_for_timeout(800)
        return
    if kind in ("library", "tunings"):
        seed_native(app, kind)
        app.goto("http://x/src/")
        app.wait_for_function("/Artists/.test(document.body.innerText)", 30000)
        app.wait_for_timeout(1200)
        if kind == "tunings":
            app.evaluate("(() => { const b = [...document.querySelectorAll('button,a')].find(e => /^\\s*Tunings\\s*$/.test(e.textContent) && e.offsetParent); b && b.click(); return 1; })()")
            app.wait_for_timeout(1200)
        return
    ss.setup_shot(app, "http://x", kind)
    app.evaluate("document.activeElement && document.activeElement.blur()")


# --- Simulator -------------------------------------------------------------------------------------
def find_udids(model):
    devs = json.loads(run(["xcrun", "simctl", "list", "devices", "available", "-j"]))["devices"]
    found = []
    for runtime, lst in devs.items():
        m = re.search(r"iOS-(\d+)-(\d+)", runtime)
        for d in lst:
            if d["name"] == model and m:
                found.append(((int(m[1]), int(m[2])), d["udid"]))
    if not found:
        raise SystemExit(f"No simulator named {model!r}. Install the runtime in Xcode (Settings > Components).")
    return [u for _, u in sorted(found, reverse=True)]


def build_sim_app(channel):
    print(f"[sim] building the {channel} app for the simulator (debug-tools)...", flush=True)
    env = {**__import__("os").environ, "MAJESTICTAB_STORE_CHANNEL": channel}
    subprocess.run(["npm", "run", "prepare:frontend"], cwd=TAURI, env=env, check=True, stdout=subprocess.DEVNULL)
    subprocess.run(["npx", "tauri", "ios", "build", "--target", "aarch64-sim", "--debug", "--no-sign", "--features", "debug-tools"],
                   cwd=TAURI, env=env, check=True, stdout=subprocess.DEVNULL)


_BOOTED = []  # simulators this run started; shut down at the end, also after a failure (a leftover copy holds the bridge port)


def boot(udid, appearance="dark"):
    _BOOTED.append(udid)
    # Only this device is restarted; other simulators may belong to someone else's session and are left alone.
    subprocess.run(["xcrun", "simctl", "shutdown", udid], capture_output=True)
    time.sleep(3)
    subprocess.run(["xcrun", "simctl", "boot", udid], capture_output=True)
    run(["xcrun", "simctl", "bootstatus", udid, "-b"])
    run(["xcrun", "simctl", "ui", udid, "appearance", appearance])
    run(["xcrun", "simctl", "status_bar", udid, "override", "--time", "9:41", "--dataNetwork", "wifi", "--wifiMode", "active", "--wifiBars", "3",
         "--cellularMode", "active", "--cellularBars", "4", "--batteryState", "discharging", "--batteryLevel", "100", "--operatorName", ""])
    subprocess.run(["xcrun", "simctl", "uninstall", udid, BUNDLE_ID], capture_output=True)  # a clean data container
    run(["xcrun", "simctl", "install", udid, str(SIM_APP)])
    launch(udid)


def launch(udid):
    """Launch with the debug bridge on our own port (SIMCTL_CHILD_ variables reach the app)."""
    for attempt in range(4):  # a freshly installed app is sometimes not launchable for a few seconds
        try:
            run(["xcrun", "simctl", "launch", udid, BUNDLE_ID], env={**__import__("os").environ, "SIMCTL_CHILD_MAJESTICTAB_DEBUG_BRIDGE_PORT": str(BRIDGE_PORT)})
            return
        except subprocess.CalledProcessError:
            if attempt == 3:
                raise
            time.sleep(6)


def fresh_app(udid, app):
    """Start every shot from a freshly launched app. The iOS audio session outlives a page reload, and the system shows it in the
    Dynamic Island (a speaker pill beside the island) after an earlier shot touched audio; a new process has none."""
    subprocess.run(["xcrun", "simctl", "terminate", udid, BUNDLE_ID], capture_output=True)
    time.sleep(1)
    launch(udid)
    wait_bridge(app)
    time.sleep(1.5)


SILENCE_JS = """(async () => {
    try { const c = window.gpState && window.gpState.canvases && window.gpState.canvases[0]; if (c && c.api) { c.api.pause && c.api.pause(); } } catch (e) {}
    document.querySelectorAll('audio,video').forEach((m) => { try { m.pause(); } catch (e) {} });
    return 1; })()"""


def sim_shot(udid, path, display=None):
    r = subprocess.run(["xcrun", "simctl", "io", udid, "screenshot", "--type=png", str(path)], text=True, capture_output=True)
    if r.returncode:
        # The iPhone Duo has two displays. Flat, tabletop and book all use the inner one (the larger, "LCD-1"); the outer one is lit only when closed.
        target = display or "LCD-1"
        m = re.search(rf"--display=(\d+)\s+{re.escape(target)}\s+\(", r.stdout + r.stderr)
        if not m:
            raise SystemExit(f"simctl screenshot failed: {r.stdout}{r.stderr}")
        run(["xcrun", "simctl", "io", udid, "screenshot", f"--display={m[1]}", "--type=png", str(path)])


SESSION = "mtshots"


def ad(*cmd, check=True):
    """agent-device (npm i -g agent-device) drives what simctl cannot: rotation, the iPad windowing mode and the Duo hinge."""
    for attempt in range(4):  # the XCTest runner can need a few tries on a freshly booted simulator
        r = subprocess.run(["agent-device", *cmd, "--session", SESSION], text=True, capture_output=True)
        if not r.returncode or "Runner did not accept" not in r.stdout + r.stderr:
            break
        time.sleep(8)
    if check and r.returncode:
        raise SystemExit(f"agent-device {' '.join(cmd)} failed: {r.stdout}{r.stderr}")
    return r.stdout


def ad_session(udid):
    ad("close", check=False)  # a session left over from an earlier run points at the old boot
    subprocess.run(["agent-device", "close", "--session", "duo"], capture_output=True)
    ad("open", BUNDLE_ID, "--platform", "ios", "--udid", udid)


def ipad_full_screen():
    """iPadOS 26+ opens apps in a small floating window. Settings > Multitasking & Gestures > Full Screen Apps makes them fill the
    screen like the iPhone shots do. The choice stays in the simulator's data, so this is best effort: if the Settings app is slow
    to answer, the saved choice is still there."""
    ad("open", "com.apple.Preferences", check=False)
    ad("find", "Multitasking", check=False)
    ad("press", 'id="com.apple.settings.multitaskingAndGestures.fullScreenApps"', check=False)
    ad("close", check=False)


# The inner display is a landscape panel, so agent-device's names are the panel's: "portrait" gives the 951x669 pt window and
# "landscape-left" the upright 669x951 pt one. Tabletop is the half-open fold with the upright window, book the half-open fold on its side.
# Closed folds the hinge shut, lighting the outer 466x678 pt display.
DUO_POSE = {
    "flat": ("open", "landscape-left"),
    "tabletop": ("half-open", "landscape-left"),
    "book": ("half-open", "portrait"),
    "closed": ("closed", "portrait"),
}


def duo_set_pose(app, pose):
    """Fold the simulator's hinge and rotate it (tabletop is the half-open pose upright, book the half-open pose on its side), then
    wait for the app's own foldState.js to report the same pose (html[data-fold-pose], about 300 ms after the fold stops)."""
    fold, orient = DUO_POSE[pose]
    ad("fold", fold, check=False)  # on some runtimes it cannot read the hinge back to confirm; the app's own report below is the check
    ad("orientation", orient, check=False)
    end = time.time() + 40
    while time.time() < end:
        try:
            if pose == "closed":
                if app.evaluate("window.innerWidth < 500"):
                    time.sleep(1.5)
                    return
            elif app.evaluate("document.documentElement.dataset.foldPose || 'flat'") == pose:
                if pose == "flat" and not app.evaluate("window.innerWidth > 500"):
                    pass
                else:
                    time.sleep(1.5)
                    return
        except Exception:
            pass
        time.sleep(1)
    raise SystemExit(f"The Duo never reported the {pose!r} pose")


# --- Mac -------------------------------------------------------------------------------------------
MAC_BIN = TAURI / "target" / "debug" / "majestictab"


def build_mac_app(channel):
    """The unbundled debug binary, so its data lives in ~/Library/WebKit/majestictab and never touches an installed MajesticTab."""
    print(f"[mac] building the {channel} app (debug-tools)...", flush=True)
    env = {**__import__("os").environ, "MAJESTICTAB_STORE_CHANNEL": channel}
    subprocess.run(["npm", "run", "prepare:frontend"], cwd=TAURI, env=env, check=True, stdout=subprocess.DEVNULL)
    subprocess.run(["npx", "tauri", "build", "--debug", "--no-bundle", "--features", "debug-tools"], cwd=TAURI, env=env, check=True, stdout=subprocess.DEVNULL)


def mac_window_id(pid):
    js = f"""ObjC.import('CoreGraphics'); ObjC.import('Foundation');
    const l = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0)));
    const w = l.filter(x => x.kCGWindowOwnerPID === {pid} && x.kCGWindowLayer === 0).sort((a, b) => b.kCGWindowBounds.Width - a.kCGWindowBounds.Width)[0];
    w ? String(w.kCGWindowNumber) : '';"""
    return run(["osascript", "-l", "JavaScript", "-e", js]).strip()


def trim_window_corners(path):
    """A window capture has transparent rounded corners, which turn black when flattened. Fill each transparent corner pixel with the
    colour of the first opaque pixel in its row (the title bar and the transport bar are one flat colour along a row), so the result is
    a clean rectangle and no content is lost."""
    from PIL import Image
    im = Image.open(path).convert("RGBA")
    px = im.load()
    w, h = im.size
    r = 0
    while r < min(w, h) // 4 and px[r, r][3] < 255:  # the diagonal leaves the corner at about r * 0.29
        r += 1
    reach = int(r / 0.2929) + 3 if r else 0
    for y in list(range(reach)) + list(range(h - reach, h)):
        for xs, step in ((range(0, reach), 1), (range(w - 1, w - 1 - reach, -1), -1)):
            first = next((x for x in xs if px[x, y][3] == 255), None)
            if first is None:
                continue
            for x in (range(0, first) if step == 1 else range(w - 1, first, -1)):
                px[x, y] = px[first, y]
    im.convert("RGB").save(path)


def mac_shot(pid, path):
    wid = mac_window_id(pid)
    if not wid:
        raise SystemExit("Could not find the app window on screen (is the Mac awake and the desktop unlocked?)")
    # The real pointer hovers menus open: park it at the right edge of the main display, away from the window.
    subprocess.run(["osascript", "-l", "JavaScript", "-e", "ObjC.import('CoreGraphics'); const b = $.CGDisplayBounds($.CGMainDisplayID()); $.CGWarpMouseCursorPosition($.CGPointMake(b.size.width - 2, b.size.height / 2));"], capture_output=True)
    # Make the window the active one (coloured traffic lights); NSRunningApplication needs no accessibility permission.
    subprocess.run(["osascript", "-l", "JavaScript", "-e", f"ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationWithProcessIdentifier({pid}).activateWithOptions(2);"], capture_output=True)
    time.sleep(0.6)
    run(["screencapture", "-x", "-o", f"-l{wid}", str(path)])  # -o: no drop shadow
    trim_window_corners(path)


# --- Composition -----------------------------------------------------------------------------------
def compose(page, raw_path, out_path, size, headline, subtitle, bezel):
    """Flat Slate Blue frame (the same as the other stores), Barlow Condensed headline, and the real capture inside a flat device
    (store_screenshots.device_html: iPhone with its Dynamic Island and keys, iPad as a tablet). The simulator never draws the Dynamic
    Island or the bezel (they are hardware), so those two are added; everything inside the screen is the app as the device draws it."""
    from PIL import Image
    W, H = size
    portrait = H > W
    k = min(W, H) / 1080
    cap = Image.open(raw_path)
    m = round(72 * k)
    hs = round((104 if portrait else 84) * k)
    top = round((72 if portrait else 56) * k)
    ps = round((38 if portrait else 32) * k)
    hl = 2 if len(headline) > (19 if portrait else 44) else 1
    sl = 2 if portrait else 1
    iy = top + round(hs * hl + 24 * k) + round(ps * 1.35 * sl + (36 if portrait else 28) * k)
    bottom = m if portrait else round(56 * k)
    aw, ah = W - 2 * m, H - iy - bottom
    css = ss.FRAME_CSS % dict(fonts=ss.FONTS_DIR.as_uri(), w=W, h=H, m=m, top=top, ptop=top + round(hs * hl + 24 * k), hs=hs, ps=ps)
    data_uri = "data:image/png;base64," + base64.b64encode(Path(raw_path).read_bytes()).decode("ascii")
    if bezel:
        d = ss.device_layout(bezel, cap.width / cap.height, aw, ah)
        dx, dy = (W - d["total"][0]) / 2, iy + (ah - d["total"][1]) / 2
        body = ss.device_html(bezel, d, dx, dy, data_uri)
    else:  # a Mac window already has its own frame
        s = min(aw / cap.width, ah / cap.height)
        dw, dh = cap.width * s, cap.height * s
        body = f"<img style='left:{(W - dw) / 2:.1f}px;top:{iy + (ah - dh) / 2:.1f}px;width:{dw:.1f}px;height:{dh:.1f}px;background:none' src='{data_uri}'>"
    html = f"<!doctype html><meta charset=utf-8><style>{css}</style><h1>{headline}</h1><p>{subtitle}</p>{body}"
    page.set_viewport_size({"width": W, "height": H})
    page.set_content(html, wait_until="load")
    page.evaluate("document.fonts.ready")
    page.wait_for_timeout(200)
    Path(out_path).unlink(missing_ok=True)
    page.screenshot(path=str(out_path), full_page=False)


_SLICES = 12


def _tone(i):
    """Flat tone steps from the rim colour at the front to a darker one at the back, so the edge reads as a solid body."""
    f = i / _SLICES
    a_, b_ = (0x2a, 0x34, 0x48), (0x12, 0x18, 0x24)
    return "#" + "".join(f"{round(x + (y - x) * f):02x}" for x, y in zip(a_, b_))


def fold_panel(uri, w, h, outer, inner, seam, bz, rim, depth, extra):
    """One half of the folding body, as a slab. The slices (copies of the outline stepped back in depth) make its thickness with the
    rounded corners right all round; the front face is the bezel and the screen. `seam` is the side that is the hinge ('top', 'bottom',
    'left' or 'right'): it has no bezel and nothing drawn on it. outer/inner are border radii (top-left, top-right, bottom-right,
    bottom-left); the content follows the glass's inner curve, so the bezel hugs it."""
    o = " ".join(f"{r:.1f}px" for r in outer)
    i = " ".join(f"{r:.1f}px" for r in inner)
    c = " ".join(f"{max(r - bz, 0):.1f}px" for r in inner)
    rm = {side: (0 if side == seam else rim) for side in ("top", "right", "bottom", "left")}
    bm = {side: (0 if side == seam else bz) for side in ("top", "right", "bottom", "left")}
    body = "".join(f"<div style='position:absolute;left:0;top:0;width:100%;height:100%;border-radius:{o};background:{_tone(n)};transform:translateZ({-depth * n / _SLICES:.2f}px)'></div>"
                   for n in range(_SLICES, 0, -1))
    return (f"<div class=pn style='width:{w:.1f}px;height:{h:.1f}px;transform-style:preserve-3d;{extra}'>{body}"
            f"<div style='position:absolute;left:0;top:0;width:100%;height:100%;box-sizing:border-box;background:{ss.RIM};border-radius:{o};padding:{rm['top']:.1f}px {rm['right']:.1f}px {rm['bottom']:.1f}px {rm['left']:.1f}px'>"
            f"<div style='position:relative;width:100%;height:100%;background:{ss.GLASS};border-radius:{i};padding:{bm['top']:.1f}px {bm['right']:.1f}px {bm['bottom']:.1f}px {bm['left']:.1f}px'>"
            f"<div style='position:relative;width:100%;height:100%;overflow:hidden;border-radius:{c}'>"
            f"<img src='{uri}' style='position:static;display:block;width:100%;height:100%'></div></div></div></div>")


def _png_uri(im):
    import io
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def compose_laptop(page, raw_path, out_path, size, headline, subtitle, fold):
    """The Duo in tabletop: folded like a laptop. One foldable body: a single bezel runs round both halves and the screen is continuous,
    with nothing drawn at the fold: it shows only in the change of angle. The real capture is split at the middle of the fold (the app reports it: --fold-top is the top half's height,
    --fold-h the crease), keeping every pixel: the top half stands up and leans back, the bottom half lies flat in perspective, and they share the hinge
    edge, so the side bezels bend with it. Only CSS 3D transforms; the pictures are the capture, unretouched."""
    import io
    import math
    from PIL import Image
    W, H = size
    k = min(W, H) / 1080
    cap = Image.open(raw_path).convert("RGB")
    sc = cap.width / fold["w"]  # capture pixels per CSS pixel
    top_px = bot_px = round((fold["top"] + fold["h"] / 2) * sc)  # split in the middle of the crease: no pixel of the capture is dropped
    parts = {"top": cap.crop((0, 0, cap.width, top_px)), "bot": cap.crop((0, bot_px, cap.width, cap.height))}
    uris = {}
    for name, im in parts.items():
        buf = io.BytesIO()
        im.save(buf, "PNG")
        uris[name] = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
    m = round(72 * k)
    hs, ps, top = round(104 * k), round(38 * k), round(72 * k)
    hl = 2 if len(headline) > 19 else 1
    iy = top + round(hs * hl + 24 * k) + round(ps * 1.35 * 2 + 36 * k)
    aw, ah = W - 2 * m, H - iy - m
    lean, flat = 12, 68  # degrees: the screen leans back like a laptop lid, the deck lies nearly flat
    persp = 6.0  # camera distance in screen widths: the nearer the camera, the more the deck's near edge grows
    r_top, r_bot = parts["top"].height / cap.width, parts["bot"].height / cap.width
    # Apparent height of the group (the lid foreshortened by its lean, the deck by its tilt) with room for the perspective growth.
    app = (r_top * math.cos(math.radians(lean)) + r_bot * math.cos(math.radians(flat))) * 1.15
    ws = min(aw * 0.9, ah / app)
    bz, rim = 0.011 * min(ws, ws * r_top), 0.004 * min(ws, ws * r_top)
    pad = bz + rim
    pw = ws + 2 * pad
    ht, hb = ws * r_top + pad, ws * r_bot + pad  # no bezel at the shared hinge edge
    rad = 0.05 * min(ws, ws * r_top) + pad

    depth = 0.024 * ws  # the body's thickness

    def panel(uri, h, outer, inner, extra, seam):
        return fold_panel(uri, pw, h, outer, inner, seam, bz, rim, depth, extra)

    ri = max(rad - rim, 0)
    css = ss.FRAME_CSS % dict(fonts=ss.FONTS_DIR.as_uri(), w=W, h=H, m=m, top=top, ptop=top + round(hs * hl + 24 * k), hs=hs, ps=ps)
    scene_top = iy + max(0.0, (ah - ws * app) / 2)
    css += (f".scene{{position:absolute;left:{(W - pw) / 2:.1f}px;top:{scene_top:.1f}px;width:{pw:.1f}px;perspective:{persp * ws:.0f}px;perspective-origin:50% 15%}}"
            ".pn{position:absolute;left:0;box-sizing:border-box}")
    body = ("<div class=scene>"
            + panel(uris["top"], ht, (rad, rad, 0, 0), (ri, ri, 0, 0), f"top:0;transform-origin:50% 100%;transform:rotateX({lean}deg)", "bottom")
            + panel(uris["bot"], hb, (0, 0, rad, rad), (0, 0, ri, ri), f"top:{ht - 1:.1f}px;transform-origin:50% 0;transform:rotateX({flat}deg)", "top")
            + "</div>")
    html = f"<!doctype html><meta charset=utf-8><style>{css}</style><h1>{headline}</h1><p>{subtitle}</p>{body}"
    page.set_viewport_size({"width": W, "height": H})
    page.set_content(html, wait_until="load")
    page.evaluate("document.fonts.ready")
    page.wait_for_timeout(300)
    Path(out_path).unlink(missing_ok=True)
    page.screenshot(path=str(out_path), full_page=False)


def compose_book(page, raw_path, out_path, size, headline, subtitle, fold):
    """The Duo in book: opened like a book on its spine. The capture is cut at the crease (--fold-left, --fold-w) into the two pages, which
    open toward the viewer by the same angle on both sides (the hinge is the farthest line), as slabs with the same thickness and one
    continuous bezel; nothing is drawn at the hinge."""
    import math
    from PIL import Image
    W, H = size
    k = min(W, H) / 1080
    cap = Image.open(raw_path).convert("RGB")
    sc = cap.width / fold["vw"]
    lx = rx = round((fold["left"] + fold["w"] / 2) * sc)  # split in the middle of the crease: no pixel of the capture is dropped
    left, right = cap.crop((0, 0, lx, cap.height)), cap.crop((rx, 0, cap.width, cap.height))
    m = round(72 * k)
    hs, ps, top = round(84 * k), round(32 * k), round(56 * k)
    hl = 2 if len(headline) > 44 else 1
    iy = top + round(hs * hl + 24 * k) + round(ps * 1.35 + 28 * k)
    aw, ah = W - 2 * m, H - iy - round(56 * k)
    theta = 24  # degrees each page opens toward the viewer
    # In image pixels the pair is (left.width + right.width) wide and cap.height tall; the bezel adds a little on the outer edges.
    iw = left.width + right.width
    growth = 1.08  # the outer edges come toward the camera
    s = min(aw * 0.94 / (iw * math.cos(math.radians(theta)) * growth), ah / (cap.height * growth))
    short = cap.height * s
    bz, rim = 0.011 * short, 0.004 * short
    pad = bz + rim
    pl, pr = left.width * s + pad, right.width * s + pad
    hp = cap.height * s + 2 * pad
    rad = 0.05 * short + pad
    ri = max(rad - rim, 0)
    depth = 0.03 * short * 0.6
    tot = pl + pr
    css = ss.FRAME_CSS % dict(fonts=ss.FONTS_DIR.as_uri(), w=W, h=H, m=m, top=top, ptop=top + round(hs * hl + 24 * k), hs=hs, ps=ps)
    css += (f".scene{{position:absolute;left:{(W - tot) / 2:.1f}px;top:{iy + max(0.0, (ah - hp) / 2):.1f}px;width:{tot:.1f}px;height:{hp:.1f}px;perspective:{3.2 * tot:.0f}px;perspective-origin:50% 50%}}"
            ".pn{position:absolute;top:0;box-sizing:border-box}")
    body = ("<div class=scene>"
            + fold_panel(_png_uri(left), pl, hp, (rad, 0, 0, rad), (ri, 0, 0, ri), "right", bz, rim, depth,
                         f"left:0;transform-origin:100% 50%;transform:rotateY({theta}deg)")
            + fold_panel(_png_uri(right), pr, hp, (0, rad, rad, 0), (0, ri, ri, 0), "left", bz, rim, depth,
                         f"left:{pl - 1:.1f}px;transform-origin:0 50%;transform:rotateY({-theta}deg)")
            + "</div>")
    html = f"<!doctype html><meta charset=utf-8><style>{css}</style><h1>{headline}</h1><p>{subtitle}</p>{body}"
    page.set_viewport_size({"width": W, "height": H})
    page.set_content(html, wait_until="load")
    page.evaluate("document.fonts.ready")
    page.wait_for_timeout(300)
    Path(out_path).unlink(missing_ok=True)
    page.screenshot(path=str(out_path), full_page=False)


def capture(name, args):
    from playwright.sync_api import sync_playwright
    dev = DEVICES[name]
    out = ss.OUT_ROOT / dev["out"]
    raw_dir = out / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    if args.recompose:  # re-render the tabletop shots from the saved captures, without the simulator
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            frame = browser.new_context(viewport={"width": 1080, "height": 1920}).new_page()
            for n, (pose, sid, headline, subtitle) in (enumerate(DUO_SHOTS, 1) if name == "duo" else []):
                raw = raw_dir / f"{n:02d}-{sid}.png"
                fj = raw.with_suffix(".fold.json")
                if pose in ("tabletop", "book") and raw.exists() and fj.exists():
                    final = out / f"{n:02d}-{sid}-{pose}.png"
                    from PIL import Image
                    (compose_laptop if pose == "tabletop" else compose_book)(frame, raw, final, Image.open(raw).size, headline, subtitle, json.loads(fj.read_text()))
                    print(f"  wrote {final}", flush=True)
                elif raw.exists():
                    final = out / f"{n:02d}-{sid}.png"
                    from PIL import Image
                    size = (2853, 2007) if pose == "book" else (2007, 2853)
                    bezel = "duo-closed" if pose == "closed" else dev["bezel"]
                    compose(frame, raw, final, size, headline, subtitle, None if args.no_bezel else bezel)
                    print(f"  wrote {final}", flush=True)
            if name != "duo":
                from PIL import Image
                n = 0
                for shot in ss.SHOTS:
                    n += 1
                    raw = raw_dir / f"{shot['id']}.png"
                    if raw.exists() and (not args.only or shot["id"] in args.only):
                        final = out / f"{n:02d}-{shot['id']}.png"
                        compose(frame, raw, final, dev["final"] or Image.open(raw).size, shot["headline"], shot["subtitle"], None if args.no_bezel else dev["bezel"])
                        print(f"  wrote {final}", flush=True)
            browser.close()
        return
    app = App()
    udid = pid = proc = None
    if dev["kind"] == "sim":
        if not args.no_build:
            build_sim_app(dev["channel"])
        for udid in find_udids(dev["model"]):  # the newest runtime first; a simulator whose data will not migrate fails to install, try the next
            print(f"[{name}] {dev['model']} {udid}", flush=True)
            for attempt in range(2):
                try:
                    boot(udid)
                    break
                except subprocess.CalledProcessError as e:
                    print(f"  could not boot or install on {udid}: {e.stderr.strip()[:120]}", flush=True)
                    time.sleep(5)
            else:
                continue
            break
        else:
            raise SystemExit(f"No working {dev['model']} simulator")
        ad_session(udid)
        if name == "ipad":
            ipad_full_screen()
            subprocess.run(["xcrun", "simctl", "terminate", udid, "com.apple.Preferences"], capture_output=True)
            subprocess.run(["xcrun", "simctl", "terminate", udid, BUNDLE_ID], capture_output=True)
            launch(udid)
            ad_session(udid)
            if args.landscape:
                ad("orientation", "landscape-left")
                time.sleep(2)
    else:
        if not args.no_build:
            build_mac_app(dev["channel"])
        subprocess.run(["pkill", "-x", "majestictab"], capture_output=True)
        time.sleep(1)
        proc = subprocess.Popen([str(MAC_BIN)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                env={**__import__("os").environ, "MAJESTICTAB_DEBUG_BRIDGE_PORT": str(BRIDGE_PORT)})
        pid = proc.pid
    wait_bridge(app)
    live = app.evaluate("fetch('/channel.json', {cache: 'no-store'}).then(r => r.ok ? r.json() : null)")
    cfg = ss.resolve_channel(dev["channel"])
    if live is None or any(live.get(k) != v for k, v in cfg.items()):
        raise SystemExit(f"The app is not the {dev['channel']} channel: {live}")
    if not args.only:
        for f in out.glob("[0-9][0-9]-*.png"):
            f.unlink(missing_ok=True)
    plan = []
    if name == "duo":
        plan = [(i + 1, pose, sid, h, sub) for i, (pose, sid, h, sub) in enumerate(DUO_SHOTS)]
    else:
        n = 0
        for shot in ss.SHOTS:
            n += 1
            plan.append((n, None, shot["id"], shot["headline"], shot["subtitle"]))
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        frame = browser.new_context(viewport={"width": 1080, "height": 1920}).new_page()
        for n, pose, sid, headline, subtitle in plan:
            if args.only and sid not in args.only:
                continue
            shot = next((s for s in ss.SHOTS if s["id"] == sid), dict(id=sid, setup=sid))
            if udid:
                fresh_app(udid, app)
            if pose:
                duo_set_pose(app, pose)
            prepare_shot(app, shot)
            if pose:
                duo_set_pose(app, pose)
            if pose == "book":
                # The app goes to two-page Page mode on a fold *change*, so a page loaded while already folded needs the player's own switch.
                app.evaluate("""(() => {
                    const out = document.getElementById('output');
                    const pageRadio = document.getElementById('pageModeRadio');
                    const contRadio = document.getElementById('continuousModeRadio');
                    if (pageRadio) {
                        pageRadio.checked = true;
                        if (contRadio) contRadio.checked = false;
                        if (window.gpState && window.gpState.renderGPPage) {
                            window.gpState.renderGPPage(out, true, contRadio);
                        } else {
                            pageRadio.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    }
                    return 1;
                })()""")
                app.wait_for_function("document.querySelectorAll('.gp-page-wrapper, .page-container, .gp-page, [data-page-index]').length > 1 || /\\d+-\\d+ of \\d+/.test(document.body.innerText)", 30000)
                time.sleep(2)
            app.evaluate(SILENCE_JS)
            time.sleep(3 if udid else 1.2)  # let any system audio indicator clear before the picture
            raw = raw_dir / f"{n:02d}-{sid}.png" if name == "duo" else raw_dir / f"{sid}.png"
            fold = None
            if pose == "book":
                fold = app.evaluate("""(() => { const cs = getComputedStyle(document.documentElement); return { left: parseFloat(cs.getPropertyValue('--fold-left')), w: parseFloat(cs.getPropertyValue('--fold-w')), vw: innerWidth }; })()""")
                if not fold or not fold.get("w"):
                    raise SystemExit(f"{sid}: the app did not report the fold geometry (--fold-left, --fold-w): {fold}")
            if pose == "tabletop":
                fold = app.evaluate("""(() => { const cs = getComputedStyle(document.documentElement); return { top: parseFloat(cs.getPropertyValue('--fold-top')), h: parseFloat(cs.getPropertyValue('--fold-h')), w: innerWidth }; })()""")
                if not fold or not fold.get("top"):
                    raise SystemExit(f"{sid}: the app did not report the fold geometry (--fold-top): {fold}")
            if udid:
                sim_shot(udid, raw, display="LCD" if pose == "closed" else "LCD-1")
            else:
                mac_shot(pid, raw)
            if fold:
                raw.with_suffix(".fold.json").write_text(json.dumps(fold))
            from PIL import Image
            Image.open(raw).convert("RGB").save(raw)  # App Store screenshots must not carry an alpha channel
            size = dev["final"] or Image.open(raw).size
            if name == "duo" and pose != "book":
                size = (2007, 2853)
            if dev["kind"] == "mac":
                size = dev["final"]
            final = out / f"{n:02d}-{sid}{'-' + pose if pose in ('tabletop', 'book') else ''}.png"
            if fold and not args.no_bezel:
                (compose_laptop if pose == "tabletop" else compose_book)(frame, raw, final, size, headline, subtitle, fold)
            else:
                bezel = "duo-closed" if (name == "duo" and pose == "closed") else dev["bezel"]
                compose(frame, raw, final, size, headline, subtitle, None if args.no_bezel else bezel)
            print(f"  wrote {final}", flush=True)
        browser.close()
    if udid:
        ad("close", check=False)
        subprocess.run(["xcrun", "simctl", "shutdown", udid], capture_output=True)  # frees the bridge port for the next device
    if proc:
        proc.terminate()
    if not args.raw:
        pass  # raw captures stay: Apple accepts them as they are, and they are the files to upload for iPhone and iPad


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("device", choices=[*DEVICES, "all"])
    ap.add_argument("--only", nargs="*", help="Only these shot ids")
    ap.add_argument("--no-build", action="store_true", help="Reuse the app already built")
    ap.add_argument("--recompose", action="store_true", help="re-render the frames from the saved captures (no simulator): every shot, and the Duo tabletop frames")
    ap.add_argument("--no-bezel", action="store_true", help="Show the capture without a device around it")
    ap.add_argument("--raw", action="store_true", help="(raw captures are always kept in raw/)")
    ap.add_argument("--landscape", action="store_true", help="iPad: rotate to landscape (2752x2064). Not the default: in landscape the reader's top bar sits under the iPad status bar")
    args = ap.parse_args()
    httpd = None if args.recompose else start_fixture_server()  # a recompose needs no fixtures, and must not clash with a capture running
    failures = []
    try:
        if args.device != "all":
            capture(args.device, args)
        else:
            order = ["iphone", "ipad", "duo", "mac"]
            if not args.no_build and not args.recompose:
                # One simulator app serves iPhone, iPad and Duo, and one Mac app the Mac: build each once, not once per device.
                for what, build in (("simulator app", lambda: build_sim_app(DEVICES["iphone"]["channel"])), ("Mac app", lambda: build_mac_app(DEVICES["mac"]["channel"]))):
                    try:
                        build()
                    except (subprocess.CalledProcessError, SystemExit) as e:
                        failures.append(f"build of the {what}: {e}")
                args.no_build = True
            for name in order:
                if name == "mac" and any(f.startswith("build of the Mac app") for f in failures):
                    continue
                if name != "mac" and any(f.startswith("build of the simulator app") for f in failures):
                    continue
                try:
                    capture(name, args)
                except (subprocess.CalledProcessError, SystemExit, Exception) as e:  # one device failing must not lose the others
                    failures.append(f"{name}: {e}")
                    print(f"[{name}] FAILED: {e}", flush=True)
            # The header and search art are made from the iPhone and iPad captures.
            r = subprocess.run([sys.executable, str(Path(__file__).with_name("apple_marketing_art.py"))])
            if r.returncode:
                failures.append("apple_marketing_art.py")
    finally:
        if httpd:
            httpd.shutdown()
        if not args.recompose:
            ad("close", check=False)
        for u in _BOOTED:
            subprocess.run(["xcrun", "simctl", "shutdown", u], capture_output=True)
    if failures:
        print("\nFailed:\n  " + "\n  ".join(failures), flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
