#!/usr/bin/env python3
"""Build app store listing screenshots for a specific distribution channel.

Each shot is captured from the app exactly as that channel ships it: the script runs
build/tauri/prepare-tauri-frontend.mjs for the channel (channel.json, files and options the channel excludes
removed), checks it with build/verify-channel.mjs, and serves the result. Capture is at the store's device size, then composed into a flat
marketing frame (Reimagined rules: tone steps, no gradients, glow or shadow; Barlow Condensed headline, sentence case, one subtitle) by
rendering HTML in the same browser; Flathub shots are not made here (see flathub_screenshots.mjs). Only public-domain / test fixtures in tests/ are used (no copyrighted tabs).

Usage:
    pip install playwright pillow && playwright install chromium
    python3 tools/store_screenshots.py play                    # all Google Play phone shots (tab zoom 50%)
    python3 tools/store_screenshots.py play-tablet-7           # Play 7-inch tablet shots (also play-tablet-10, play-tv, play-desktop)
    python3 tools/store_screenshots.py msstore                 # all Microsoft Store desktop shots
    python3 tools/store_screenshots.py play-all                # every Play device type (phone, 7" and 10" tablet, TV, Chromebook), one run
    python3 tools/store_screenshots.py all                     # every store above, one run, up to 4 stores at once
    python3 tools/store_screenshots.py all -j 1                # the same, one store at a time
    python3 tools/store_screenshots.py play --only gp_scroll   # one shot
    python3 tools/store_screenshots.py play --raw              # also keep the unframed captures
    python3 tools/store_screenshots.py play --no-prepare       # reuse the existing build/tauri/frontend-dist-<channel>

Output: support/store/<channel>/<NN>-<shot>.png , raw captures under .../raw/.
Add a store by adding an entry to STORES (device profile, `device` bezel: phone, iphone, tablet, laptop or tv; final size; `channel` is the id from build/channels.mjs and
defaults to the entry's own name, `out` is the folder under support/store/).
"""
import argparse
import base64
import functools
import http.server
import io
import json
import os
import re
import socket
import subprocess
import sys
import threading
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
GP_FILE = ROOT / "tests" / "Duo No 2 In G Major.gp5"
OUT_ROOT = ROOT / "support" / "store"
TAURI_DIR = ROOT / "build" / "tauri"
def frontend_dir(channel):
    """Each channel is prepared in its own directory, so stores of different channels can run at the same time."""
    return TAURI_DIR / f"frontend-dist-{channel}"


# Capture viewport is CSS px; final is the store's required pixel size.
STORES = {
    "play": {
        "device": "phone",
        "viewport": {"width": 390, "height": 700},
        "scale": 3,
        "user_agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
        "final": (1080, 1920),  # Play phone: 9:16, each side 320-3840 px, max 2:1
        "out": "../../fastlane/metadata/android/en-US/images/phoneScreenshots",
        "tab_scale": 50,  # sheet zoom (%), so a phone shows several bars instead of a couple
        "safe_area": {"top": 32},  # status bar and punch-hole camera, drawn by device_html
    },
    # Play tablet and Chromebook/desktop shots: landscape 16:9 (how a tab stand is used), each side 320-3840 px. Same `play` build as the phone.
    "play-tablet-7": {
        "device": "tablet",
        "channel": "play",
        "out": "../../fastlane/metadata/android/en-US/images/sevenInchScreenshots",
        "tab_scale": 50,
        "viewport": {"width": 960, "height": 540},
        "scale": 2,
        "user_agent": "Mozilla/5.0 (Linux; Android 14; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        "final": (1920, 1080),
    },
    "play-desktop": {
        "device": "laptop",
        "channel": "play",
        "out": "play/desktop",
        "viewport": {"width": 1440, "height": 810},
        "scale": 2,
        "mobile": False,
        "user_agent": "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        "final": (1920, 1080),
    },
    "play-tablet-10": {
        "device": "tablet",
        "channel": "play",
        "out": "../../fastlane/metadata/android/en-US/images/tenInchScreenshots",
        "tab_scale": 80,
        "viewport": {"width": 1280, "height": 720},
        "scale": 2,
        "user_agent": "Mozilla/5.0 (Linux; Android 14; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        "final": (2560, 1440),
    },
    # Play Android TV shots: 1920x1080 landscape, no touch. The real shell sets these root classes from AndroidTv.isTelevision() (src/tvMode.js).
    "play-tv": {
        "device": "tv",
        "channel": "play",
        "out": "../../fastlane/metadata/android/en-US/images/tvScreenshots",
        "tab_scale": 80,
        "viewport": {"width": 960, "height": 540},
        "scale": 2,
        "mobile": False,
        "user_agent": "Mozilla/5.0 (Linux; Android 14; Android TV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        "final": (1920, 1080),
        "root_classes": ["tv-mode", "fullscreen-unavailable"],
        "no_fullscreen": True,
        # No touch on a TV: copy that says "tap" is replaced per shot id.
        "copy": {
            "original": ("Play along with the record", "Sync once, and the cursor follows the original."),
            "page": ("Scroll or turn pages", "Use the remote or a Bluetooth page turner."),
        },
    },
    "appstore-ios": {
        "device": "iphone",
        # iPhone 6.3" (16 Pro / 18 Pro) logical width: 402 x 874 pt @ 3x = 1206 x 2622 px (supported App Store size)
        "viewport": {"width": 402, "height": 874},
        "scale": 3,
        "user_agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
        "final": (1206, 2622),
        # What the native shell does that a plain page lacks: main.js adds `tauri-ios` when window.__TAURI__ exists.
        "root_classes": ["tauri-ios"],
        # iOS is always a full-screen app, so the Fullscreen button must not appear anywhere.
        "no_fullscreen": True,
        "safe_area": {"top": 62, "bottom": 34},  # Dynamic Island and home indicator on a 16 Pro Max
    },
    "msstore": {
        "device": "laptop",
        # Microsoft Store desktop: 16:9, 1366x768 to 3840x2160.
        "viewport": {"width": 1440, "height": 810},
        "scale": 2,
        "mobile": False,
        "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
        "final": (1920, 1080),
        # Native Windows shell is undecorated and draws #winControls inside #topBar when .tauri-windows is set.
        "root_classes": ["tauri-windows"],
    },
}

# Marketing copy: sentence-case headline, one short subtitle. `requires` skips the shot when the channel lacks a capability.
# `theme` is the app theme (default Slate Blue). Order is the order in the store listing: the first two decide the click.
SHOTS = [
    dict(id="reader", headline="Every guitar part, together", subtitle="Drums, bass and keys stay out of the way.", setup="reader"),
    dict(id="library", headline="A library, not a folder", subtitle="Artists, albums and tracklists for every song you play.", setup="library"),
    dict(id="original", headline="Play along with the record", subtitle="Tap to sync, and the cursor follows the original.", setup="original"),
    dict(id="guitar", headline="Fit it to your guitar", subtitle="7 and 8 strings, tunings and capo, every pitch kept.", setup="guitar"),
    dict(id="page", headline="Scroll or turn pages", subtitle="Tap, or use a Bluetooth page turner.", setup="page", theme="Snow White", zoom_factor=0.8, density="tight"),
    dict(id="practice", headline="Practice at your pace", subtitle="Speed, loops, count-in and metronome.", setup="practice"),
    dict(id="tunings", headline="Browse by tuning", subtitle="Build a set that needs no retuning.", setup="tunings"),
    # Jam mode is native-only, so this shot fakes the native shell (tests/jam/mockTauri.js) in a page of its own.
    dict(id="jam", headline="Jam in the same room", subtitle="Everyone on the same bar, from their own device.", setup="jam", own_page=True),
]


def resolve_channel(channel):
    js = f"import('{(ROOT / 'build' / 'channels.mjs').as_uri()}').then(m=>console.log(JSON.stringify(m.resolveChannel('{channel}'))))"
    return json.loads(subprocess.check_output(["node", "-e", js]))


def prepare_channel_frontend(channel):
    """Build the channel's frontend and fail if it contains anything the channel must not ship."""
    dest = frontend_dir(channel)
    env = {**os.environ, "MAJESTICTAB_STORE_CHANNEL": channel, "MAJESTICTAB_FRONTEND_DIR": str(dest)}
    subprocess.run(["node", "prepare-tauri-frontend.mjs"], cwd=TAURI_DIR, env=env, check=True, stdout=subprocess.DEVNULL)
    subprocess.run(["node", str(ROOT / "build" / "verify-channel.mjs"), channel, str(dest)], check=True)


def _frontend_matches(channel, cfg):
    try:
        live = json.loads((frontend_dir(channel) / "channel.json").read_text())
    except (OSError, ValueError):
        return False
    return all(live.get(k) == v for k, v in cfg.items())


def ensure_channel_frontend(channel, cfg, force):
    """Prepare the channel's frontend unless a matching one is already there. A lock keeps parallel runs of the
    same channel from rebuilding the directory under each other."""
    import fcntl
    with open(TAURI_DIR / f".frontend-dist-{channel}.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if force or not _frontend_matches(channel, cfg):
            print(f"[{channel}] preparing the frontend...", flush=True)
            prepare_channel_frontend(channel)


class _Server(http.server.ThreadingHTTPServer):
    request_queue_size = 256  # default backlog of 5 resets connections during the app's module-load burst

    def handle_error(self, request, client_address):
        # The browser cancels requests when a page navigates away; that is not an error worth a traceback.
        if isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError)):
            return
        super().handle_error(request, client_address)


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


_SAFE_ENV = re.compile(r"env\(\s*safe-area-inset-(top|right|bottom|left)\s*(?:,[^()]*)?\)")


class _ChannelHandler(_Quiet):
    """Serve the prepared channel frontend at /src/ (as the native shell does at /) and fixtures at /tests/.

    Playwright cannot set env(safe-area-inset-*), so when the store has a `safe_area` the served CSS/HTML/JS has each
    env() replaced by that many pixels. The app then reserves the room a real phone's camera or Dynamic Island takes."""
    safe_area = None
    frontend = None

    def do_GET(self):
        rel = urllib.parse.urlsplit(self.path).path
        if self.safe_area and rel.startswith("/src/") and rel.endswith((".css", ".html", ".js", ".mjs")) or (self.safe_area and rel in ("/src", "/src/")):
            target = Path(self.translate_path(self.path))
            if target.is_dir():
                target = target / "index.html"
            if target.is_file():
                text = _SAFE_ENV.sub(lambda m: f"{self.safe_area.get(m.group(1), 0)}px", target.read_text(encoding="utf-8"))
                body = text.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", self.guess_type(str(target)))
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
        super().do_GET()

    def translate_path(self, path):
        rel = urllib.parse.urlsplit(path).path
        if rel.startswith("/src/") or rel == "/src":
            return str(self.frontend / urllib.parse.unquote(rel[len("/src/"):]))
        return super().translate_path(path)


def start_channel_server(channel, safe_area=None):
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    handler = type("_SafeChannelHandler", (_ChannelHandler,), {"safe_area": safe_area, "frontend": frontend_dir(channel)})
    httpd = _Server(("127.0.0.1", port), functools.partial(handler, directory=str(ROOT)))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{port}"


def has_feature(cfg, name):
    v = cfg.get(name)
    return v not in (False, "off", "none", None)


# Fictional artists (1-4 albums each) plus Custom Music, from demo_library.json, so the library never shows copyrighted names or artwork.
with open(Path(__file__).with_name("demo_library.json")) as _f:
    _demo = json.load(_f)
FIXTURE = "Duo No 2 In G Major.gp5"


COVER_CACHE = OUT_ROOT / ".cover-cache"


def cover_data_url(artist, album):
    """The invented album sleeve cached for this album (shared with flathub_screenshots.mjs), as a data URL."""
    slug = re.sub(r"[^\w]", "_", f"{artist}_{album}").lower()
    f = COVER_CACHE / f"{slug}.jpg"
    if not f.exists():
        raise SystemExit(f"Missing {f}: the demo album sleeves live in support/store/.cover-cache")
    return "data:image/jpeg;base64," + base64.b64encode(f.read_bytes()).decode("ascii")


def seed_library(page, base):
    """Replace the library with the invented demo artists and their cached album sleeves."""
    covers = {f"{a}|{al}": cover_data_url(a, al) for a, albums in _demo["library"].items() for al in albums}
    page.goto(f"{base}/src/", wait_until="load", timeout=60000)
    page.evaluate("""async ([d, covers]) => {
        const m = await import('/src/libraryStore.js');
        for (const s of await m.getSongsByCollection()) await m.deleteSongFromLibrary(s.id);
        await m.clearRecents();
        let i = 0, k = 0;
        for (const [artist, albums] of Object.entries(d.library)) {
            let year = 2008;
            for (const [album, tracks] of Object.entries(albums)) {
                year += 2; let tn = 1;
                for (const title of tracks) {
                    const tuning = d.tunings[i++ % d.tunings.length];
                    const song = await m.saveSongToLibrary({ title, artist, album, year, trackNumber: tn++, coverUrl: covers[artist + '|' + album], tunings: [tuning], stringCount: /^7/.test(tuning) ? 7 : 6 });
                    k++; if (k % 4 === 0) continue;
                    const ft = ['gp', 'gp', 'pdf', 'gp', 'txt'][k % 5], ext = { gp: 'gp5', pdf: 'pdf', txt: 'txt' }[ft];
                    await m.addTabOptionToSong(song.id, { name: title + '.' + ext, fileType: ft, tuning, stringCount: song.stringCount, isDefault: true, fileStoreId: 'demo_' + song.id });
                }
            }
        }
    }""", [_demo, covers])


JAM_MOCK = ROOT / "tests" / "jam" / "mockTauri.js"
# Fictional players for the Jam shot; the host is the capturing device.
JAM_PLAYERS = [("p1", "Dave's iPad"), ("p2", "Adrian's phone")]


def open_reader(page, base):
    """Open the app fresh on the fixture score (the ?test= loader) and wait until it is laid out."""
    page.goto(f"{base}/src/?test={urllib.parse.quote(FIXTURE)}", wait_until="load", timeout=60000)
    page.wait_for_function("!/Loading score|Laying out|Rendering|Parsing/i.test(document.body.innerText)"
                           " && (document.querySelectorAll('.at-surface svg').length > 3 || document.querySelectorAll('canvas, .gp-page-wrapper').length > 0)", timeout=90000)
    page.wait_for_timeout(2500)


def click(page, selector):
    return page.evaluate("(s) => { const e = document.querySelector(s); if (!e) return false; e.click(); return true; }", selector)


def setup_jam(page, base):
    """Host a Jam with two players who have the song and are in sync, and give each their own track."""
    page.add_init_script("window.__jamMockRole = 'host';\n" + JAM_MOCK.read_text())
    open_reader(page, base)
    page.evaluate("document.documentElement.classList.remove('tauri-macos')")  # the mock fakes the native shell
    click(page, "#toolsToggleBtn")
    page.wait_for_timeout(500)
    click(page, "#jamToggleBtn")
    page.wait_for_timeout(600)
    page.evaluate("document.querySelector('[data-jam-tab=host]')?.click()")
    page.wait_for_timeout(300)
    page.evaluate("document.getElementById('jamStartHostBtn')?.click()")
    page.wait_for_timeout(1500)
    for pid, name in JAM_PLAYERS:
        page.evaluate("([id, name]) => window.__jamMock.join(id, name)", [pid, name])
    page.wait_for_timeout(500)
    for pid, _ in JAM_PLAYERS:
        page.evaluate("(id) => window.__jamMock.sync(id)", pid)
    page.wait_for_selector(".jam-matrix-cell", state="attached", timeout=10000)
    tracks = page.evaluate("document.querySelectorAll('.jam-matrix-col').length - 1")
    for n, (pid, _) in enumerate(JAM_PLAYERS):
        page.locator(f".jam-matrix-cell[data-jam-assign='{pid}'][data-jam-track]").nth(n % tracks).click()
        page.wait_for_timeout(200)
    page.locator(".jam-matrix-cell[data-jam-listening='host']").click()
    page.wait_for_timeout(200)
    page.locator("[data-jam-rule='assignedAudioMode'][data-jam-value='backing']").click()
    page.wait_for_timeout(200)
    page.locator("[data-jam-rule='assignedViewOnly'][data-jam-value='own']").click()
    page.wait_for_timeout(200)
    page.evaluate("document.getElementById('jamModalBody').scrollTop = 0")


def setup_guitar_fit(page):
    """The Guitar panel: the tab rewritten for 7-string standard with a capo on fret 2 (the same picture the website shows)."""
    def wait(js):
        for _ in range(30):
            if page.evaluate(js):
                return
            page.wait_for_timeout(300)
    click(page, 'label[for="synthStringCount7"]'); page.wait_for_timeout(2500)
    if not page.evaluate("document.querySelector('#adaptEnableSwitch').checked"):
        click(page, "#adaptEnableSwitch")
    page.wait_for_timeout(1200)
    page.evaluate("(() => { const s = document.querySelector('#adaptTuningSelect'); s.value = '7-String Standard'; s.dispatchEvent(new Event('change', { bubbles: true })); })()")
    page.wait_for_timeout(1500)
    click(page, 'label[for="adaptMethodCapo"]'); page.wait_for_timeout(800)
    page.evaluate("(() => { const s = document.querySelector('#adaptCapoSelect'); s.value = '2'; s.dispatchEvent(new Event('change', { bubbles: true })); })()")
    wait("/Capo \\d/.test(document.querySelector('#adaptSummary')?.textContent || '')")
    page.wait_for_timeout(1500)


def setup_shot(page, base, kind):
    if kind == "jam":
        setup_jam(page, base)
        page.wait_for_timeout(800)
        return
    if kind in ("library", "tunings"):
        seed_library(page, base)
        page.goto(f"{base}/src/", wait_until="load", timeout=60000)
        page.wait_for_function("/Artists/.test(document.body.innerText)", timeout=30000)
        page.wait_for_timeout(1200)
        if kind == "tunings":
            page.evaluate("(() => { const b = [...document.querySelectorAll('button,a')].find(e => /^\\s*Tunings\\s*$/.test(e.textContent) && e.offsetParent); b?.click(); })()")
            page.wait_for_timeout(1200)
        return
    open_reader(page, base)
    if kind == "page":
        click(page, "#fretboardDockBtn, #fretboardCloseBtn"); page.wait_for_timeout(700)  # the pages need the full height
        page.evaluate("document.querySelector('#pageModeRadio').click()")
        page.wait_for_timeout(2500)
    elif kind == "reader":
        # Put the cursor on a bar with two voices sounding, so the fretboard shows notes from both guitars.
        page.evaluate("""async () => {
            const gp = await import('/src/gpProcessor/gpPlayer.js');
            const { fretboardController } = await import('/src/fretboard/fretboardController.js');
            const api = window.gpState.canvases[0].api;
            const beat = api.tracks[0].staves[0].bars[6].voices[0].beats[1];
            document.body.classList.add('synth-playback-started');
            const bounds = api.renderer.boundsLookup.findBeat(beat);
            document.getElementById('output').scrollTop = Math.max(0, bounds.realBounds.y - 80);
            api.tickPosition = gp.getPlaybackTickForBeat(beat, api);
            fretboardController.showBeatsAtCursor(beat);
        }""")
        # Make sure the picture shows the top and the controls (nothing auto-hides, but a remembered Reading mode would).
        page.wait_for_timeout(600)
        page.evaluate("document.body.classList.remove('top-away', 'reading-mode')")
        page.wait_for_timeout(600)
    elif kind in ("practice", "guitar"):
        click(page, "#fretboardDockBtn, #fretboardCloseBtn"); page.wait_for_timeout(700)  # panels read best without the fretboard behind them
        click(page, f"#{kind}ToggleBtn"); page.wait_for_timeout(900)
        if kind == "guitar":
            setup_guitar_fit(page)
    elif kind == "original":
        click(page, "#fretboardDockBtn, #fretboardCloseBtn"); page.wait_for_timeout(700)
        page.wait_for_timeout(2500)  # let the score finish laying out so the panel can count its bars
        click(page, "#ytToggleBtn, #mobileYtToggleBtn"); page.wait_for_timeout(800)
        click(page, "#realAudioSourceLocal")
        for _ in range(40):
            if page.evaluate("/of [1-9]\\d* bars synced/.test(document.body.innerText)"):
                break
            page.wait_for_timeout(500)
        page.wait_for_timeout(800)
    page.wait_for_timeout(1200)


# --- Composition -----------------------------------------------------------------------------------
# A flat frame in the app's Slate Blue tokens: --s1 behind, the capture one tone step up (--ground), a big Barlow Condensed
# headline, one grey subtitle, left aligned. The capture sits in a flat device bezel for the device it was taken on (phone with
# punch-hole camera, iPhone with Dynamic Island, tablet, laptop with base, TV with feet), built from tone steps only:
# no gradient, glow, shadow or hairline.

FONTS_DIR = ROOT / "docs" / "fonts"
FRAME_CSS = """
@font-face { font-family: 'Barlow Condensed'; font-weight: 600; src: url('%(fonts)s/barlow-condensed-latin-600-normal.woff2') format('woff2'); }
:root { --s1: #111724; --ground: #1e2636; --ink: #f4f7fc; --ink2: #a9b8d2; }
* { box-sizing: border-box; margin: 0; }
html, body { width: %(w)dpx; height: %(h)dpx; overflow: hidden; background: var(--s1); color: var(--ink); }
body { position: relative; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
h1 { position: absolute; left: %(m)dpx; right: %(m)dpx; top: %(top)dpx; font: 600 %(hs)dpx/1.0 'Barlow Condensed', 'Arial Narrow', sans-serif; letter-spacing: -0.005em; }
p { position: absolute; left: %(m)dpx; right: %(m)dpx; top: %(ptop)dpx; font-size: %(ps)dpx; line-height: 1.35; color: var(--ink2); }
.d { position: absolute; }
img { position: absolute; background: var(--ground); }
"""

# Bezel tones: the rim is one step above the app's ground, the glass surround is near black.
RIM, GLASS = "#2a3448", "#05070b"

STEAMDECK_SVG = (
    "<svg class=d style='left:%(x).1fpx;top:%(y).1fpx;width:%(w).1fpx;height:%(h).1fpx' viewBox='0 0 1024 414' preserveAspectRatio='none' fill='none' xmlns='http://www.w3.org/2000/svg'>"
    # Shoulder bumpers (L1 / R1)
    "<path d='M34.8352 20.8957C34.8352 20.8957 41.5423 9.53977 66.2582 6.06818C83.5116 3.64578 158.188 4.98813 158.188 4.98813C158.188 4.98813 166.899 6.2379 166.899 10.6198V22H34.8352Z"
    "M987.403 20.8957C987.403 20.8957 980.696 9.53977 955.98 6.06818C938.726 3.64578 864.05 4.98813 864.05 4.98813C864.05 4.98813 855.339 6.2379 855.339 10.6198V22H987.403Z' fill='#1e2636'/>"
    # Outer chassis shell
    "<path d='M4.68799 138.986C4.07808 84.8566 3.77312 57.7917 17.3951 38.7736C21.7923 32.6345 27.135 27.2312 33.2243 22.765C52.0876 8.92969 79.1543 8.92969 133.288 8.92969H891.302C945.435 8.92969 972.502 8.92969 991.365 22.765C997.454 27.2312 1002.8 32.6345 1007.19 38.7736C1020.82 57.7917 1020.51 84.8566 1019.9 138.986L1018.87 230.404C1018.05 303.325 1017.64 339.786 998.847 365.286C992.776 373.525 985.454 380.765 977.146 386.744C951.436 405.247 914.973 405.247 842.047 405.247H182.542C109.616 405.247 73.1532 405.247 47.443 386.744C39.1358 380.765 31.8139 373.525 25.7421 365.286C6.95052 339.786 6.53969 303.325 5.71804 230.404L4.68799 138.986Z' fill='#2a3448'/>"
    # Grip contour seams
    "<path d='M3.34961 149.594H49.1214C58.9864 149.594 66.9836 157.592 66.9836 167.457V236.361C66.9836 251.093 71.5375 265.465 80.0217 277.508L159.609 390.485C162.537 394.643 164.109 399.604 164.109 404.689"
    "M1020.38 149.594H974.606C964.741 149.594 956.743 157.592 956.743 167.457V236.361C956.743 251.093 952.19 265.465 943.705 277.508L864.118 390.485C861.19 394.643 859.618 399.604 859.618 404.689"
    "M1020.38 99.3572L1016.93 80.5049C1010.52 45.5118 980.024 20.0938 944.449 20.0938H79.2781C43.7032 20.0938 13.2086 45.5118 6.80144 80.5049L3.34961 99.3572' stroke='#1e2636' stroke-width='2.2'/>"
    # Outer stick well rings
    "<path d='M210.552 90.7616C210.552 116.843 189.409 137.985 163.328 137.985C137.247 137.985 116.105 116.843 116.105 90.7616C116.105 64.6806 137.247 43.5379 163.328 43.5379C189.409 43.5379 210.552 64.6806 210.552 90.7616Z"
    "M907.177 90.4787C907.177 116.56 886.034 137.702 859.953 137.702C833.872 137.702 812.73 116.56 812.73 90.4787C812.73 64.3977 833.872 43.2549 859.953 43.2549C886.034 43.2549 907.177 64.3977 907.177 90.4787Z' fill='#222b3d'/>"
    # Screen glass bezel
    "<path d='M801.936 389.956H221.335C219.315 389.956 217.696 388.32 217.696 386.314V31.0384C217.696 29.0172 219.33 27.3971 221.335 27.3971H801.921C803.94 27.3971 805.559 29.0326 805.559 31.0384V386.314C805.575 388.32 803.94 389.956 801.936 389.956Z' fill='#05070b'/>"
    # Dual square trackpads
    "<path d='M192.587 256.887H112.642C105.025 256.887 98.8573 250.715 98.8573 243.093V163.108C98.8573 155.485 105.025 149.314 112.642 149.314H192.571C200.188 149.314 206.356 155.485 206.356 163.108V243.093C206.371 250.715 200.188 256.887 192.587 256.887Z"
    "M831.856 256.887H911.786C919.403 256.887 925.57 250.715 925.57 243.093V163.108C925.57 155.485 919.403 149.314 911.786 149.314H831.856C824.239 149.314 818.072 155.485 818.072 163.108V243.093C818.072 250.715 824.239 256.887 831.856 256.887Z' fill='#182030'/>"
    # D-pad, ABXY buttons, thumbstick bases, View/Menu, Steam/QAM, and speaker grilles
    "<path d='M195.562 299.61H163.415C157.448 299.61 152.606 294.766 152.606 288.795C152.606 282.823 157.448 277.979 163.415 277.979H195.562C201.529 277.979 206.371 282.823 206.371 288.795C206.371 294.766 201.529 299.61 195.562 299.61Z"
    "M129.975 40.1229H113.665C109.98 40.1229 107.005 37.1296 107.005 33.4575C107.005 29.7699 109.996 26.792 113.665 26.792H129.975C133.66 26.792 136.636 29.7853 136.636 33.4575C136.652 37.1296 133.66 40.1229 129.975 40.1229Z"
    "M197.836 90.0094C197.836 108.893 182.539 124.201 163.669 124.201C144.799 124.201 129.501 108.893 129.501 90.0094C129.501 71.126 144.799 55.818 163.669 55.818C182.539 55.818 197.836 71.126 197.836 90.0094Z"
    "M206.711 345.281H198.879C197.691 345.281 196.72 344.309 196.72 343.121C196.72 341.933 197.691 340.961 198.879 340.961H206.711C207.898 340.961 208.87 341.933 208.87 343.121C208.885 344.325 207.914 345.281 206.711 345.281Z"
    "M191.8 345.281H183.968C182.78 345.281 181.809 344.309 181.809 343.121C181.809 341.933 182.78 340.961 183.968 340.961H191.8C192.987 340.961 193.959 341.933 193.959 343.121C193.959 344.325 193.003 345.281 191.8 345.281Z"
    "M176.891 345.281H169.059C167.872 345.281 166.9 344.309 166.9 343.121C166.9 341.933 167.872 340.961 169.059 340.961H176.891C178.079 340.961 179.05 341.933 179.05 343.121C179.05 344.325 178.079 345.281 176.891 345.281Z"
    "M206.71 324.004H198.877C197.69 324.004 196.719 323.032 196.719 321.844C196.719 320.656 197.69 319.684 198.877 319.684H206.71C207.897 319.684 208.869 320.656 208.869 321.844C208.884 323.032 207.913 324.004 206.71 324.004Z"
    "M191.847 324.004H184.014C182.827 324.004 181.856 323.032 181.856 321.844C181.856 320.656 182.827 319.684 184.014 319.684H191.847C193.034 319.684 194.006 320.656 194.006 321.844C194.006 323.032 193.034 324.004 191.847 324.004Z"
    "M176.968 324.004H169.135C167.948 324.004 166.977 323.032 166.977 321.844C166.977 320.656 167.948 319.684 169.135 319.684H176.968C178.155 319.684 179.126 320.656 179.126 321.844C179.126 323.032 178.17 324.004 176.968 324.004Z"
    "M162.105 324.004H154.272C153.085 324.004 152.114 323.032 152.114 321.844C152.114 320.656 153.085 319.684 154.272 319.684H162.105C163.292 319.684 164.263 320.656 164.263 321.844C164.263 323.032 163.292 324.004 162.105 324.004Z"
    "M206.711 334.635H191.554C190.367 334.635 189.396 333.663 189.396 332.475C189.396 331.287 190.367 330.315 191.554 330.315H206.711C207.898 330.315 208.869 331.287 208.869 332.475C208.885 333.678 207.913 334.635 206.711 334.635Z"
    "M184.616 334.635H176.783C175.596 334.635 174.624 333.663 174.624 332.475C174.624 331.287 175.596 330.315 176.783 330.315H184.616C185.803 330.315 186.774 331.287 186.774 332.475C186.774 333.678 185.803 334.635 184.616 334.635Z"
    "M169.397 334.635H161.565C160.377 334.635 159.406 333.663 159.406 332.475C159.406 331.287 160.377 330.315 161.565 330.315H169.397C170.584 330.315 171.556 331.287 171.556 332.475C171.556 333.678 170.584 334.635 169.397 334.635Z"
    "M828.88 299.61H861.028C866.995 299.61 871.836 294.766 871.836 288.795C871.836 282.823 866.995 277.979 861.028 277.979H828.88C822.913 277.979 818.072 282.823 818.072 288.795C818.072 294.766 822.913 299.61 828.88 299.61Z"
    "M894.451 40.1229H910.761C914.446 40.1229 917.422 37.1296 917.422 33.4575C917.422 29.7699 914.431 26.792 910.761 26.792H894.451C890.766 26.792 887.79 29.7853 887.79 33.4575C887.79 37.1296 890.766 40.1229 894.451 40.1229Z"
    "M893.943 90.559C893.943 109.442 878.646 124.75 859.776 124.75C840.906 124.75 825.608 109.442 825.608 90.559C825.608 71.6756 840.906 56.3677 859.776 56.3677C878.646 56.3677 893.943 71.6756 893.943 90.559Z"
    "M817.717 345.281H825.55C826.737 345.281 827.709 344.309 827.709 343.121C827.709 341.933 826.737 340.961 825.55 340.961H817.717C816.53 340.961 815.559 341.933 815.559 343.121C815.559 344.325 816.515 345.281 817.717 345.281Z"
    "M832.626 345.281H840.459C841.646 345.281 842.617 344.309 842.617 343.121C842.617 341.933 841.646 340.961 840.459 340.961H832.626C831.439 340.961 830.467 341.933 830.467 343.121C830.467 344.325 831.439 345.281 832.626 345.281Z"
    "M847.551 345.281H855.384C856.571 345.281 857.543 344.309 857.543 343.121C857.543 341.933 856.571 340.961 855.384 340.961H847.551C846.364 340.961 845.393 341.933 845.393 343.121C845.377 344.325 846.349 345.281 847.551 345.281Z"
    "M817.717 324.004H825.55C826.737 324.004 827.709 323.032 827.709 321.844C827.709 320.656 826.737 319.684 825.55 319.684H817.717C816.53 319.684 815.559 320.656 815.559 321.844C815.559 323.032 816.515 324.004 817.717 324.004Z"
    "M832.58 324.004H840.413C841.6 324.004 842.572 323.032 842.572 321.844C842.572 320.656 841.6 319.684 840.413 319.684H832.58C831.393 319.684 830.422 320.656 830.422 321.844C830.422 323.032 831.393 324.004 832.58 324.004Z"
    "M847.46 324.004H855.292C856.48 324.004 857.451 323.032 857.451 321.844C857.451 320.656 856.48 319.684 855.292 319.684H847.46C846.272 319.684 845.301 320.656 845.301 321.844C845.301 323.032 846.272 324.004 847.46 324.004Z"
    "M862.338 324.004H870.17C871.358 324.004 872.329 323.032 872.329 321.844C872.329 320.656 871.358 319.684 870.17 319.684H862.338C861.151 319.684 860.179 320.656 860.179 321.844C860.179 323.032 861.135 324.004 862.338 324.004Z"
    "M817.717 334.635H832.874C834.061 334.635 835.032 333.663 835.032 332.475C835.032 331.287 834.061 330.315 832.874 330.315H817.717C816.53 319.684 815.559 331.287 815.559 332.475C815.559 333.678 816.515 334.635 817.717 334.635Z"
    "M839.827 334.635H847.66C848.847 334.635 849.818 333.663 849.818 332.475C849.818 331.287 848.847 330.315 847.66 330.315H839.827C838.64 330.315 837.669 331.287 837.669 332.475C837.653 333.678 838.624 334.635 839.827 334.635Z"
    "M855.045 334.635H862.878C864.065 334.635 865.037 333.663 865.037 332.475C865.037 331.287 864.065 330.315 862.878 330.315H855.045C853.858 330.315 852.887 331.287 852.887 332.475C852.887 333.678 853.843 334.635 855.045 334.635Z"
    "M974.606 44.096C974.606 52.4196 967.858 59.1672 959.534 59.1672C951.211 59.1672 944.463 52.4196 944.463 44.096C944.463 35.7724 951.211 29.0248 959.534 29.0248C967.858 29.0248 974.606 35.7724 974.606 44.096Z"
    "M974.606 103.871C974.606 112.195 967.858 118.942 959.534 118.942C951.211 118.942 944.463 112.195 944.463 103.871C944.463 95.5476 951.211 88.8 959.534 88.8C967.858 88.8 974.606 95.5476 974.606 103.871Z"
    "M1004.19 74.2384C1004.19 82.562 997.438 89.3096 989.114 89.3096C980.791 89.3096 974.043 82.562 974.043 74.2384C974.043 65.9148 980.791 59.1672 989.114 59.1672C997.438 59.1672 1004.19 65.9148 1004.19 74.2384Z"
    "M944.463 74.2384C944.463 82.562 937.716 89.3096 929.392 89.3096C921.068 89.3096 914.321 82.562 914.321 74.2384C914.321 65.9148 921.068 59.1672 929.392 59.1672C937.716 59.1672 944.463 65.9148 944.463 74.2384Z"
    "M30.7604 84.1312C28.8943 77.2888 28.8943 70.0716 30.7604 63.2293C31.0549 62.1492 32.0359 61.4 33.1554 61.4H50.2378C52.7041 61.4 54.7034 59.4007 54.7034 56.9344V39.852C54.7034 38.7325 55.4526 37.7515 56.5327 37.457C63.375 35.5909 70.5922 35.5909 77.4346 37.457C78.5146 37.7515 79.2639 38.7325 79.2639 39.852V56.9344C79.2639 59.4007 81.2632 61.4 83.7294 61.4H100.812C101.931 61.4 102.912 62.1492 103.207 63.2293C105.073 70.0716 105.073 77.2888 103.207 84.1312C102.912 85.2112 101.931 85.9605 100.812 85.9605H83.7294C81.2632 85.9605 79.2639 87.9598 79.2639 90.426V107.508C79.2639 108.628 78.5146 109.609 77.4346 109.903C70.5922 111.77 63.375 111.77 56.5327 109.903C55.4526 109.609 54.7034 108.628 54.7034 107.508V90.426C54.7034 87.9598 52.7041 85.9605 50.2378 85.9605H33.1554C32.0359 85.9605 31.0549 85.2112 30.7604 84.1312Z' fill='#111724'/>"
    # Thumbstick caps and top bezel sensors
    "<path d='M186.822 90.635C186.822 103.698 176.24 114.288 163.185 114.288C150.131 114.288 139.549 103.698 139.549 90.635C139.549 77.5718 150.131 66.9819 163.185 66.9819C176.24 66.9819 186.822 77.5718 186.822 90.635Z"
    "M883.615 90.5588C883.615 103.622 873.032 114.212 859.978 114.212C846.924 114.212 836.342 103.622 836.342 90.5588C836.342 77.4956 846.924 66.9057 859.978 66.9057C873.032 66.9057 883.615 77.4956 883.615 90.5588Z' fill='#3a4762'/>"
    "<path fill-rule='evenodd' clip-rule='evenodd' d='M310.358 29.0261C311.591 29.0261 312.591 28.0264 312.591 26.7933C312.591 25.5602 311.591 24.5605 310.358 24.5605C309.125 24.5605 308.125 25.5602 308.125 26.7933C308.125 28.0264 309.125 29.0261 310.358 29.0261ZM716.721 29.0261C717.954 29.0261 718.954 28.0264 718.954 26.7933C718.954 25.5602 717.954 24.5605 716.721 24.5605C715.488 24.5605 714.488 25.5602 714.488 26.7933C714.488 28.0264 715.488 29.0261 716.721 29.0261Z' fill='#182030'/>"
    "</svg>"
)


def device_layout(kind, a, avail_w, avail_h):
    """Size a flat device around a screen of aspect `a` (w/h) so the whole device fits avail_w x avail_h."""
    if kind in ("phone", "iphone"):
        def build(sw):
            return dict(sw=sw, sh=sw / a, bz=(0.032 * sw,) * 4, rim=0.009 * sw, sr=(0.15 if kind == "iphone" else 0.105) * sw, extra=0)
    elif kind == "tablet":
        def build(sw):
            sh = sw / a
            return dict(sw=sw, sh=sh, bz=(0.05 * sh,) * 4, rim=0.006 * sh, sr=0.03 * sh, extra=0)
    elif kind == "ipad":  # an iPad Pro: a thin even bezel (about 3% of the short side), whatever the orientation
        def build(sw):
            sh = sw / a
            short = min(sw, sh)
            return dict(sw=sw, sh=sh, bz=(0.03 * short,) * 4, rim=0.005 * short, sr=0.04 * short, extra=0)
    elif kind == "foldable":  # iPhone Duo's inner display: a thin even bezel, no camera or island, a phone's rounded corners
        def build(sw):
            sh = sw / a
            short = min(sw, sh)
            return dict(sw=sw, sh=sh, bz=(0.012 * short,) * 4, rim=0.004 * short, sr=0.05 * short, extra=0)
    elif kind == "duo-closed":  # iPhone Duo's outer display: hinge spine on the left, rounded outer corners on the right
        def build(sw):
            sh = sw / a
            return dict(
                sw=sw, sh=sh,
                bz=(0.024 * sw, 0.024 * sw, 0.024 * sw, 0.024 * sw),
                rim=(0.038 * sw, 0.010 * sw, 0.010 * sw, 0.010 * sw),
                sr=(0.055 * sw, 0.125 * sw, 0.125 * sw, 0.055 * sw),
                extra=0
            )
    elif kind == "laptop":
        def build(sw):
            sh = sw / a
            return dict(sw=sw, sh=sh, bz=(0.022 * sh, 0.034 * sh, 0.022 * sh, 0.03 * sh), rim=0.006 * sh, sr=0.008 * sh, extra=0.05 * sh)
    elif kind == "steamdeck":  # handheld PC: exact geometry from the official Steam Deck front SVG (1024x414, screen at 242.5,37 540.6x339.9)
        def build(sw):
            sh = sw / a
            kx, ky = sw / 540.598, sh / 339.873
            return dict(sw=sw, sh=sh, bz=(24.804 * kx, 9.603 * ky, 22.461 * kx, 13.083 * ky),
                        rim=(217.696 * kx, 27.397 * ky, 218.441 * kx, 24.044 * ky), sr=0, extra=0)
    else:  # tv
        def build(sw):
            sh = sw / a
            return dict(sw=sw, sh=sh, bz=(0.009 * sh,) * 4, rim=0.004 * sh, sr=0, extra=0.075 * sh)

    def total(d):
        rim_l, rim_t, rim_r, rim_b = d["rim"] if isinstance(d["rim"], tuple) else (d["rim"],) * 4
        w = d["sw"] + d["bz"][0] + d["bz"][2] + rim_l + rim_r
        h = d["sh"] + d["bz"][1] + d["bz"][3] + rim_t + rim_b + d["extra"]
        return (w * 1.07 if kind == "laptop" else w), h  # a laptop's base is wider than its lid
    lo, hi = 10.0, 20000.0
    for _ in range(40):
        mid = (lo + hi) / 2
        w, h = total(build(mid))
        lo, hi = (mid, hi) if w <= avail_w and h <= avail_h else (lo, mid)
    d = build(lo)
    d["total"] = total(d)
    return d


def _box(x, y, w, h, color, radius="0"):
    return f"<div class=d style='left:{x:.1f}px;top:{y:.1f}px;width:{w:.1f}px;height:{h:.1f}px;background:{color};border-radius:{radius}'></div>"


def device_html(kind, d, x, y, data_uri):
    """Flat device with its total box's top-left at x, y: rim, glass, the screenshot, then the device's own details."""
    rim_l, rim_t, rim_r, rim_b = d["rim"] if isinstance(d["rim"], tuple) else (d["rim"],) * 4
    bl, bt, br, bb = d["bz"]
    sw, sh = d["sw"], d["sh"]
    bw, bh = sw + bl + br + rim_l + rim_r, sh + bt + bb + rim_t + rim_b
    tw, _ = d["total"]
    bx = x + (tw - bw) / 2  # centre the lid over a laptop's wider base
    if isinstance(d["sr"], tuple):
        sr_tl, sr_tr, sr_br, sr_bl = d["sr"]
        gr_tl, gr_tr, gr_br, gr_bl = sr_tl + bl, sr_tr + br, sr_br + br, sr_bl + bl
        rr_tl, rr_tr, rr_br, rr_bl = gr_tl + rim_l, gr_tr + rim_r, gr_br + rim_r, gr_bl + rim_l
        sr_css = f"{sr_tl:.1f}px {sr_tr:.1f}px {sr_br:.1f}px {sr_bl:.1f}px"
        gr_css = f"{gr_tl:.1f}px {gr_tr:.1f}px {gr_br:.1f}px {gr_bl:.1f}px"
        rr_css = f"{rr_tl:.1f}px {rr_tr:.1f}px {rr_br:.1f}px {rr_bl:.1f}px"
    else:
        gr = d["sr"] + max(bl, bt)
        sr_css = f"{d['sr']:.1f}px"
        gr_css = f"{gr:.1f}px"
        rr_css = f"{gr + rim_t:.1f}px"
    sx, sy = bx + rim_l + bl, y + rim_t + bt
    if kind == "steamdeck":
        return (STEAMDECK_SVG % dict(x=bx, y=y, w=bw, h=bh)
                + f"<img src='{data_uri}' style='left:{sx:.1f}px;top:{sy:.1f}px;width:{sw:.1f}px;height:{sh:.1f}px'>")
    p = [_box(bx, y, bw, bh, RIM, rr_css),
         _box(bx + rim_l, y + rim_t, bw - rim_l - rim_r, bh - rim_t - rim_b, GLASS, gr_css),
         f"<img src='{data_uri}' style='left:{sx:.1f}px;top:{sy:.1f}px;width:{sw:.1f}px;height:{sh:.1f}px;border-radius:{sr_css}'>"]
    if kind == "phone":  # punch-hole camera, power and volume keys
        c = 0.034 * sw
        p.append(_box(sx + (sw - c) / 2, sy + 0.022 * sw, c, c, GLASS, "50%"))
        kw = 0.012 * sw
        for ky, kh in ((0.15, 0.07), (0.26, 0.14)):  # power above volume, both in the upper third
            p.append(_box(bx + bw - 0.2 * kw, y + ky * bh, kw, kh * bh, RIM, f"{kw / 2:.1f}px"))
    elif kind == "iphone":  # Dynamic Island, action, volume and side buttons
        iw, ih = 0.27 * sw, 0.078 * sw
        p.append(_box(sx + (sw - iw) / 2, sy + 0.028 * sw, iw, ih, GLASS, f"{ih / 2:.1f}px"))
        kw = 0.012 * sw
        for ky, kh in ((0.17, 0.04), (0.24, 0.07), (0.33, 0.07)):
            p.append(_box(bx - 0.8 * kw, y + ky * bh, kw, kh * bh, RIM, f"{kw / 2:.1f}px"))
        p.append(_box(bx + bw - 0.2 * kw, y + 0.27 * bh, kw, 0.11 * bh, RIM, f"{kw / 2:.1f}px"))
    elif kind == "duo-closed":  # hinge spine on the left, top-right punch-hole camera aligned with the status cluster
        p.append(_box(bx, y + 0.08 * bh, rim_l, max(2.0, 0.003 * bh), "#141c2c"))
        p.append(_box(bx, y + bh - 0.08 * bh, rim_l, max(2.0, 0.003 * bh), "#141c2c"))
        p.append(_box(bx + 2, y + 0.08 * bh + 4, max(2.0, 0.004 * sw), bh * 0.84 - 8, "rgba(255,255,255,0.08)"))
        cd = 0.076 * sw
        cx = sx + 0.8956 * sw
        cy = sy + 0.064 * sh
        p.append(_box(cx - cd / 2, cy - cd / 2, cd, cd, GLASS, "50%"))
        ld = cd * 0.65
        p.append(_box(cx - ld / 2, cy - ld / 2, ld, ld, "#0d1522", "50%"))
        gd = cd * 0.22
        p.append(_box(cx + ld * 0.12, cy - ld * 0.28, gd, gd, "#2d3d58", "50%"))
        kw = 0.012 * sw
        for ky, kh in ((0.20, 0.07), (0.29, 0.07), (0.42, 0.10)):
            p.append(_box(bx + bw - 0.2 * kw, y + ky * bh, kw, kh * bh, RIM, f"{kw / 2:.1f}px"))
    elif kind == "ipad":  # the front camera sits on the long edge, so only a landscape iPad shows it
        if sw > sh:
            c = 0.012 * sh
            p.append(_box(sx + (sw - c) / 2, y + rim_t + bt / 2 - c / 2, c, c, RIM, "50%"))
    elif kind == "tablet":  # front camera in the bezel
        c = 0.016 * sh
        p.append(_box(sx + (sw - c) / 2, y + rim_t + bt / 2 - c / 2, c, c, RIM, "50%"))
    elif kind == "laptop":  # webcam in the lid, then the base with its finger notch
        c = 0.012 * sh
        p.append(_box(sx + (sw - c) / 2, y + rim_t + bt / 2 - c / 2, c, c, RIM, "50%"))
        bh2 = d["extra"]
        p.append(_box(x, y + bh, tw, bh2, RIM, f"0 0 {bh2:.1f}px {bh2:.1f}px / 0 0 {bh2 * 0.8:.1f}px {bh2 * 0.8:.1f}px"))
        nw, nh = tw * 0.16, bh2 * 0.45
        p.append(_box(x + (tw - nw) / 2, y + bh, nw, nh, GLASS, f"0 0 {nh:.1f}px {nh:.1f}px"))
    else:  # tv: a centre pedestal, a short neck on a wide flat base
        fh = d["extra"]
        cx, top = bx + bw / 2, y + bh
        nw, nh = bw * 0.08, fh * 0.6
        p.append(_box(cx - nw / 2, top - 1, nw, nh + 1, RIM))
        base_w, base_h = bw * 0.3, fh * 0.4
        p.append(_box(cx - base_w / 2, top + nh, base_w, base_h, RIM, f"{base_h / 2:.1f}px"))
    return "".join(p)


def compose(page, raw_path, out_path, size, headline, subtitle, device):
    """Render the frame as a page in the capture browser and screenshot it at the store's pixel size."""
    from PIL import Image
    W, H = size
    portrait = H > W
    k = min(W, H) / 1080  # authored at 1080 on the short side
    cap = Image.open(raw_path)
    m = round(72 * k)
    hs = round((104 if portrait else 76) * k)
    top = round((72 if portrait else 44) * k)
    lines = 2 if len(headline) > (19 if portrait else 40) else 1
    ptop = top + round(hs * lines + 24 * k)
    ps = round((38 if portrait else 30) * k)
    # The device starts at the same height in every shot: the room for a two-line headline and a two-line subtitle is always
    # reserved, so the device is one size across a store's set whatever the copy length. The text itself sits at the top.
    iy = top + round(hs * 2 + 24 * k) + round(ps * 1.35 * 2 + (36 if portrait else 28) * k)
    # The whole capture is shown inside its device, as large as the space left allows.
    bottom = m if portrait else round(44 * k)
    d = device_layout(device, cap.width / cap.height, W - 2 * m, H - iy - bottom)
    dx = (W - d["total"][0]) / 2
    dy = iy + (H - iy - bottom - d["total"][1]) / 2
    css = FRAME_CSS % dict(fonts=FONTS_DIR.as_uri(), w=W, h=H, m=m, top=top, ptop=ptop, hs=hs, ps=ps)
    data = base64.b64encode(Path(raw_path).read_bytes()).decode("ascii")
    html = (f"<!doctype html><meta charset=utf-8><style>{css}</style><h1>{headline}</h1><p>{subtitle}</p>"
            f"{device_html(device, d, dx, dy, 'data:image/png;base64,' + data)}")
    page.set_viewport_size({"width": W, "height": H})
    page.set_content(html, wait_until="load")
    page.evaluate("document.fonts.ready")
    page.wait_for_timeout(200)
    Path(out_path).unlink(missing_ok=True)
    page.screenshot(path=str(out_path), full_page=False)


# Groups of stores run together by one name. play-all is every Google Play device type (they share one `play` build).
GROUPS = {"play-all": ["play", "play-tablet-7", "play-tablet-10", "play-tv", "play-desktop"],
          "all": list(STORES)}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("channel", choices=[*STORES, *GROUPS], help="A store, `play-all` for every Google Play device type, or `all` for every store, in one run")
    ap.add_argument("--only", nargs="*", help="Only these shot ids")
    ap.add_argument("--no-prepare", action="store_true", help="Reuse build/tauri/frontend-dist-<channel> as is")
    ap.add_argument("--raw", action="store_true", help="Keep unframed captures in raw/")
    ap.add_argument("--out-dir", default=None)
    ap.add_argument("-j", "--jobs", type=int, default=4, help="Stores to capture at once when running a group (default 4; 1 runs them in turn)")
    args = ap.parse_args()
    if args.channel not in GROUPS:
        return run_store(args, args.channel)
    if args.out_dir:
        ap.error("--out-dir cannot be used with a group")
    names = GROUPS[args.channel]
    if args.jobs <= 1:
        for name in names:
            print(f"=== {name} ===", flush=True)
            run_store(args, name)
        return
    # One process per store. Each channel has its own prepared frontend, so stores no longer share state. Lines are
    # printed as they arrive, prefixed with the store, with a start and finish line for each.
    import time
    from concurrent.futures import ThreadPoolExecutor
    passthrough = [a for flag, on in (("--no-prepare", args.no_prepare), ("--raw", args.raw)) if on for a in [flag]]
    if args.only:
        passthrough += ["--only", *args.only]
    width = max(len(n) for n in names)
    out_lock = threading.Lock()

    def say(name, text):
        with out_lock:
            print(f"[{name:<{width}}] {text}", flush=True)

    def capture(name):
        t0 = time.monotonic()
        say(name, "started")
        proc = subprocess.Popen([sys.executable, "-u", str(Path(__file__).resolve()), name, *passthrough],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        for line in proc.stdout:
            say(name, line.rstrip())
        code = proc.wait()
        say(name, f"{'done' if code == 0 else f'FAILED (exit {code})'} in {time.monotonic() - t0:.0f}s")
        return name, code

    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        failed = [n for n, code in pool.map(capture, names) if code]
    if failed:
        raise SystemExit(f"Failed: {', '.join(failed)}")


def run_store(args, name):
    from playwright.sync_api import sync_playwright

    store = STORES[name]
    channel = store.get("channel", name)
    cfg = resolve_channel(channel)
    out = Path(args.out_dir).resolve() if args.out_dir else OUT_ROOT / store.get("out", name)
    raw_dir = out / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    shots = [s for s in SHOTS if (not args.only or s["id"] in args.only)]
    # Prepared per channel in its own directory. Reuse it only if its channel.json matches (something else may have
    # rewritten it); --no-prepare reuses whatever is there, and run `all` once without it to build them.
    if not args.no_prepare:
        ensure_channel_frontend(channel, cfg, force=False)
    httpd, base = start_channel_server(channel, store.get("safe_area"))
    print(f"[{channel}] capabilities: {json.dumps(cfg)}")
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=["--autoplay-policy=no-user-gesture-required"])
            mobile = store.get("mobile", True)
            ctx = browser.new_context(viewport=store["viewport"], device_scale_factor=store["scale"],
                                      is_mobile=mobile, has_touch=mobile, user_agent=store["user_agent"])
            ctx.add_init_script("""
                try { Object.defineProperty(navigator, 'getGamepads', { value: () => [], configurable: true });
                      localStorage.setItem('hasSeenControllerGuide', 'true');
                    } catch (e) {}
            """)
            frame_ctx = browser.new_context(viewport={"width": 1080, "height": 1920}, device_scale_factor=1)
            frame_page = frame_ctx.new_page()
            if store.get("root_classes"):
                ctx.add_init_script("document.addEventListener('DOMContentLoaded', () => document.documentElement.classList.add(...%s));"
                                    % json.dumps(store["root_classes"]))
            page = ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(f"{base}/src/", wait_until="networkidle", timeout=60000)
            live = page.evaluate("fetch('/src/channel.json', {cache: 'no-store'}).then(r => r.ok ? r.json() : null)")
            if live is None or any(live.get(k) != v for k, v in cfg.items()):
                raise SystemExit(f"App is not running as the {channel} channel: {live}")
            # Only now clear the old shots, so a failed run leaves the committed ones alone.
            if not args.only:
                for f in out.glob("[0-9][0-9]-*.png"):
                    f.unlink(missing_ok=True)
            n = 0
            for shot in SHOTS:
                if shot.get("requires") and not has_feature(cfg, shot["requires"]):
                    print(f"  skip {shot['id']}: channel lacks {shot['requires']}")
                    continue
                n += 1  # numbering follows the full list so --only never renames files
                if shot not in shots:
                    continue
                # A shot that fakes the native shell gets its own page so the mock never leaks into later shots.
                shot_page = ctx.new_page() if shot.get("own_page") else page
                if shot_page is not page:
                    shot_page.on("pageerror", lambda e: errors.append(str(e)))
                # Page-level init scripts run after the context's and accumulate, so the newest (this shot's) theme and zoom win.
                zoom = store.get("tab_scale")
                if shot.get("zoom_factor"):  # a tighter sheet shows more bars per page
                    zoom = round((zoom or 100) * shot["zoom_factor"])
                shot_page.add_init_script("try { localStorage.setItem('majestictab_theme', %s); %s %s } catch (e) {}" % (
                    json.dumps(shot.get("theme", "Slate Blue")),
                    f"localStorage.setItem('gpSheetScale', '{zoom}');" if zoom else "localStorage.removeItem('gpSheetScale');",
                    f"localStorage.setItem('gpNoteDensity', '{shot['density']}');" if shot.get("density") else "localStorage.removeItem('gpNoteDensity');"))
                setup_shot(shot_page, base, shot["setup"])
                if store.get("no_fullscreen"):
                    shown = shot_page.evaluate("""() => ['#fullscreenPill', '#fullscreenToggleBtn', '#toolsFullscreenRow']
                        .filter(s => { const e = document.querySelector(s); return e && e.offsetParent !== null; })""")
                    if shown:
                        raise SystemExit(f"{shot['id']}: fullscreen control visible on {channel}: {shown}")
                # The app focuses #output for keyboard scrolling, and the browser draws an orange focus ring around it.
                shot_page.evaluate("document.activeElement && document.activeElement.blur()")
                raw = raw_dir / f"{shot['id']}.png"
                shot_page.screenshot(path=str(raw))
                if shot_page is not page:
                    shot_page.close()
                final = out / f"{n:02d}-{shot['id']}.png"
                headline, subtitle = store.get("copy", {}).get(shot["id"], (shot["headline"], shot["subtitle"]))
                compose(frame_page, raw, final, store["final"], headline, subtitle, store["device"])
                print(f"  wrote {final}")
            browser.close()
        if errors:
            print(f"  warning: {len(errors)} page error(s), first: {errors[0]}")
    finally:
        httpd.shutdown()
    if not args.raw:
        for f in raw_dir.glob("*.png"):
            f.unlink()
        raw_dir.rmdir()


if __name__ == "__main__":
    main()
