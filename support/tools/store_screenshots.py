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
    python3 tools/store_screenshots.py play --only gp_scroll   # one shot
    python3 tools/store_screenshots.py play --raw              # also keep the unframed captures
    python3 tools/store_screenshots.py play --no-prepare       # reuse the existing build/tauri/frontend-dist

Output: support/store/<channel>/<NN>-<shot>.png , raw captures under .../raw/.
Add a store by adding an entry to STORES (device profile, `device` bezel: phone, iphone, tablet, laptop or tv; final size; `channel` is the id from build/channels.mjs and
defaults to the entry's own name, `out` is the folder under support/store/).
"""
import argparse
import base64
import functools
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

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate_screenshots as gs  # noqa: E402  (reuses the fixture loaders and local server)

ROOT = gs.ROOT
GP_FILE = ROOT / "tests" / "Duo No 2 In G Major.gp5"
OUT_ROOT = ROOT / "support" / "store"
TAURI_DIR = ROOT / "build" / "tauri"
FRONTEND_DIR = TAURI_DIR / "frontend-dist"

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
        # iPhone 6.9" (16 Pro Max) logical width; height matched to visible frame so bottom docks aren't cropped.
        "viewport": {"width": 440, "height": 840},
        "scale": 3,
        "user_agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
        "final": (1320, 2868),
        # What the native shell does that a plain page lacks: main.js adds `tauri-ios` when window.__TAURI__ exists.
        "root_classes": ["tauri-ios"],
        # iOS is always a full-screen app, so the Fullscreen button must not appear anywhere.
        "no_fullscreen": True,
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
    env = {**os.environ, "MAJESTICTAB_STORE_CHANNEL": channel}
    subprocess.run(["node", "prepare-tauri-frontend.mjs"], cwd=TAURI_DIR, env=env, check=True, stdout=subprocess.DEVNULL)
    subprocess.run(["node", str(ROOT / "build" / "verify-channel.mjs"), channel], check=True)


class _ChannelHandler(gs._Quiet):
    """Serve the prepared channel frontend at /src/ (as the native shell does at /) and fixtures at /tests/."""
    def translate_path(self, path):
        rel = urllib.parse.urlsplit(path).path
        if rel.startswith("/src/") or rel == "/src":
            return str(FRONTEND_DIR / urllib.parse.unquote(rel[len("/src/"):]))
        return super().translate_path(path)


def start_channel_server():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    httpd = gs._Server(("127.0.0.1", port), functools.partial(_ChannelHandler, directory=str(ROOT)))
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
                           " && document.querySelectorAll('.at-surface svg').length > 3", timeout=90000)
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
        click(page, "#fretboardCloseBtn"); page.wait_for_timeout(700)  # the pages need the full height
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
        # The playback class also hides the top bar and the five buttons (auto-hide chrome); the picture shows them.
        page.wait_for_timeout(600)
        page.evaluate("document.body.classList.remove('chrome-hidden')")
        page.wait_for_timeout(600)
    elif kind in ("practice", "guitar"):
        click(page, "#fretboardCloseBtn"); page.wait_for_timeout(700)  # panels read best without the fretboard behind them
        click(page, f"#{kind}ToggleBtn"); page.wait_for_timeout(900)
        if kind == "guitar":
            setup_guitar_fit(page)
    elif kind == "original":
        click(page, "#fretboardCloseBtn"); page.wait_for_timeout(700)
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


def device_layout(kind, a, avail_w, avail_h):
    """Size a flat device around a screen of aspect `a` (w/h) so the whole device fits avail_w x avail_h."""
    if kind in ("phone", "iphone"):
        def build(sw):
            return dict(sw=sw, sh=sw / a, bz=(0.032 * sw,) * 4, rim=0.009 * sw, sr=(0.15 if kind == "iphone" else 0.105) * sw, extra=0)
    elif kind == "tablet":
        def build(sw):
            sh = sw / a
            return dict(sw=sw, sh=sh, bz=(0.05 * sh,) * 4, rim=0.006 * sh, sr=0.03 * sh, extra=0)
    elif kind == "laptop":
        def build(sw):
            sh = sw / a
            return dict(sw=sw, sh=sh, bz=(0.022 * sh, 0.034 * sh, 0.022 * sh, 0.03 * sh), rim=0.006 * sh, sr=0.008 * sh, extra=0.05 * sh)
    else:  # tv
        def build(sw):
            sh = sw / a
            return dict(sw=sw, sh=sh, bz=(0.009 * sh,) * 4, rim=0.004 * sh, sr=0, extra=0.075 * sh)

    def total(d):
        w = d["sw"] + d["bz"][0] + d["bz"][2] + 2 * d["rim"]
        h = d["sh"] + d["bz"][1] + d["bz"][3] + 2 * d["rim"] + d["extra"]
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
    rim, (bl, bt, br, bb) = d["rim"], d["bz"]
    sw, sh = d["sw"], d["sh"]
    bw, bh = sw + bl + br + 2 * rim, sh + bt + bb + 2 * rim
    tw, _ = d["total"]
    bx = x + (tw - bw) / 2  # centre the lid over a laptop's wider base
    gr = d["sr"] + max(bl, bt)
    sx, sy = bx + rim + bl, y + rim + bt
    p = [_box(bx, y, bw, bh, RIM, f"{gr + rim:.1f}px"),
         _box(bx + rim, y + rim, bw - 2 * rim, bh - 2 * rim, GLASS, f"{gr:.1f}px"),
         f"<img src='{data_uri}' style='left:{sx:.1f}px;top:{sy:.1f}px;width:{sw:.1f}px;height:{sh:.1f}px;border-radius:{d['sr']:.1f}px'>"]
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
    elif kind == "tablet":  # front camera in the bezel
        c = 0.016 * sh
        p.append(_box(sx + (sw - c) / 2, y + rim + bt / 2 - c / 2, c, c, RIM, "50%"))
    elif kind == "laptop":  # webcam in the lid, then the base with its finger notch
        c = 0.012 * sh
        p.append(_box(sx + (sw - c) / 2, y + rim + bt / 2 - c / 2, c, c, RIM, "50%"))
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
    sub_lines = 2 if len(subtitle) > (40 if portrait else 70) else 1
    iy = ptop + round(ps * 1.35 * sub_lines + (36 if portrait else 28) * k)
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
GROUPS = {"play-all": ["play", "play-tablet-7", "play-tablet-10", "play-tv", "play-desktop"]}
_prepared = None  # channel whose frontend is currently in build/tauri/frontend-dist


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("channel", choices=[*STORES, *GROUPS], help="A store, or `play-all` for every Google Play device type in one run")
    ap.add_argument("--only", nargs="*", help="Only these shot ids")
    ap.add_argument("--no-prepare", action="store_true", help="Reuse build/tauri/frontend-dist as is")
    ap.add_argument("--raw", action="store_true", help="Keep unframed captures in raw/")
    ap.add_argument("--out-dir", default=None)
    args = ap.parse_args()
    if args.channel not in GROUPS:
        return run_store(args, args.channel)
    if args.out_dir:
        ap.error("--out-dir cannot be used with a group")
    for name in GROUPS[args.channel]:
        print(f"=== {name} ===", flush=True)
        run_store(args, name)


def run_store(args, name):
    global _prepared
    from playwright.sync_api import sync_playwright

    store = STORES[name]
    channel = store.get("channel", name)
    cfg = resolve_channel(channel)
    out = Path(args.out_dir).resolve() if args.out_dir else OUT_ROOT / store.get("out", name)
    raw_dir = out / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    if not args.only:
        for f in out.glob("[0-9][0-9]-*.png"):
            f.unlink(missing_ok=True)
    shots = [s for s in SHOTS if (not args.only or s["id"] in args.only)]
    if not args.no_prepare and _prepared != channel:
        prepare_channel_frontend(channel)
        _prepared = channel
    httpd, base = start_channel_server()
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
            live = page.evaluate("import('/src/channel.js').then(m => m.getChannel())")
            if live != channel:
                raise SystemExit(f"App is not running as the {channel} channel: {live}")
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
