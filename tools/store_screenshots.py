#!/usr/bin/env python3
"""Build app store listing screenshots for a specific distribution channel.

Each shot is captured from the app exactly as that channel ships it: the script runs
build/tauri/prepare-tauri-frontend.mjs for the channel (channel.json, files and options the channel excludes
removed), checks it with build/verify-channel.mjs, and serves the result. Capture is at the store's device size, then composed into a marketing frame
(headline, subtitle, device-framed capture). Only the Keystone fixtures are used (no copyrighted tabs).

Usage:
    pip install playwright pillow && playwright install chromium
    python3 tools/store_screenshots.py play                    # all Google Play phone shots
    python3 tools/store_screenshots.py msstore                 # all Microsoft Store desktop shots
    python3 tools/store_screenshots.py play --only gp_scroll   # one shot
    python3 tools/store_screenshots.py play --raw              # also keep the unframed captures
    python3 tools/store_screenshots.py play --no-prepare       # reuse the existing build/tauri/frontend-dist

Output: store-support/<channel>/<NN>-<shot>.png (gitignored), raw captures under .../raw/.
Add a store by adding an entry to STORES (channel id from build/channels.mjs, device profile, final size).
"""
import argparse
import base64
import functools
import io
import json
import os
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
OUT_ROOT = ROOT / "store-support"
TAURI_DIR = ROOT / "build" / "tauri"
FRONTEND_DIR = TAURI_DIR / "frontend-dist"

# Capture viewport is CSS px; final is the store's required pixel size.
STORES = {
    "play": {
        "viewport": {"width": 360, "height": 640},
        "scale": 3,
        "user_agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
        "final": (1080, 1920),  # Play phone: 9:16, each side 320-3840 px, max 2:1
    },
    "appstore-ios": {
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

# Marketing copy: sentence-case headline (max ~4 words), one short subtitle. `supporter` unlocks the
# paid Supporter features for that shot only; `requires` skips the shot when the channel lacks a capability.
SHOTS = [
    dict(id="gp_scroll", headline="Scroll through your tabs",
         subtitle="All guitar parts stacked together, with no other clutter",
         setup="gp_scroll"),
    dict(id="gp_page", headline="Or, turn pages like a book", subtitle="Tap or use a Bluetooth page turner",
         setup="gp_page"),
    dict(id="library", headline="Your whole tab library", subtitle="Browse by artist and album in one place",
         setup="library"),
    dict(id="tunings", headline="Browse tabs by tuning",
         subtitle="Group your songs by 6-string, 7-string, and drop tunings",
         setup="tunings"),
    dict(id="synth_menu", headline="Play along with the band", subtitle="Built-in synth with per-track mixing",
         setup="synth_menu"),
    dict(id="fretboard", headline="Follow each note on a fretboard", subtitle="A color for every track as the tab plays",
         setup="fretboard"),
    dict(id="theme_palettes", headline="Make it yours", subtitle="Visual finishes with MajesticTab Supporter",
         setup="themes", supporter=True),
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
    """Serve the prepared channel frontend at /app/ (as the native shell does at /) and fixtures at /tests/."""
    def translate_path(self, path):
        rel = urllib.parse.urlsplit(path).path
        if rel.startswith("/app/") or rel == "/app":
            return str(FRONTEND_DIR / urllib.parse.unquote(rel[len("/app/"):]))
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


# Fictional artists (1-4 albums each) plus Custom Music (books + songs) so the library shot never shows
# copyrighted names or artwork while showcasing 1-, 2-, 3-, and 4-album artist collages.
DEMO_LIBRARY = {
    "Aurora Vale": {
        "Glass Meridian": ["Open Water", "Paper Lanterns", "Meridian", "Slow Burn", "Last Light"],
        "Northbound": ["Departure", "Cold Front", "Harbor Lights", "Northbound"],
        "Solstice Echoes": ["First Frost", "Midwinter", "Thaw", "Equinox"],
    },
    "Copper Sky": {
        "Rustbelt": ["Iron Hymn", "Copper Sky", "Furnace", "Switchyard"],
        "Signal Fires": ["Beacon", "Telegraph", "Cinder", "Red Horizon", "Ashfall"],
    },
    "Hollow Pines": {
        "Static Bloom": ["Wildfire", "Static Bloom", "Ember Road", "Hollow Hearts"],
        "Timberline": ["Ridge", "Canopy", "moss & Stone", "Firewatch"],
        "Nightjar": ["Dusk", "Starlight", "Wingbeat", "Roost"],
        "Pale October": ["Equinox", "Harvest Moon", "Driftwood", "Frostline"],
    },
    "Neon Harbor": {
        "Midnight Arcade": ["Insert Coin", "Neon Tide", "Afterglow", "Player Two", "High Score"],
    },
    "Stonebridge": {
        "Foundations": ["Keystone Lane", "Arches", "Bedrock", "Crossing"],
        "Quarry": ["Granite", "Chisel", "Faultline", "Echo Chamber"],
        "High Water": ["Floodgate", "Millrace", "Undertow", "Breakwater"],
    },
    "The Velvet Hour": {
        "Low Tide Club": ["Velvet", "Low Tide", "Last Call"],
        "Late Checkout": ["Room 404", "Minibar", "Lobby Piano", "Sunrise Cab"],
        "Blue Neon": ["Rain on Glass", "Boulevard", "Nightcap", "Closing Time"],
        "Silver Lining": ["Daybreak", "Overcast", "Clear Skies"],
    },
}

COVER_TINTS = [
    (255, 110, 90),   # warm coral / sunset
    (70, 175, 255),   # glacial blue
    (230, 95, 210),   # magenta dusk
    (60, 220, 165),   # emerald / teal
    (255, 185, 65),   # amber gold
    (150, 115, 255),  # violet night
    (255, 85, 120),   # crimson neon
    (80, 210, 235),   # cyan horizon
]


def fake_cover_data_url(artist, title, idx):
    """Fetch a deterministic Unsplash photo via picsum.photos and grade it like an album sleeve."""
    from PIL import Image, ImageChops, ImageDraw, ImageEnhance
    cache_dir = OUT_ROOT / ".cover-cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    slug = "".join(c if c.isalnum() else "_" for c in f"{artist}_{title}").lower()
    cached = cache_dir / f"{slug}.jpg"
    if cached.exists():
        b64 = base64.b64encode(cached.read_bytes()).decode("ascii")
        return f"data:image/jpeg;base64,{b64}"

    seed = urllib.parse.quote(f"mt-album-{idx}-{title}")
    req = urllib.request.Request(
        f"https://picsum.photos/seed/{seed}/240/240",
        headers={"User-Agent": "MajesticTab-Screenshots/1.0"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        im = Image.open(io.BytesIO(resp.read())).convert("RGB").resize((240, 240), Image.LANCZOS)

    # Color grade + contrast boost so each album in a multi-album collage has a distinct palette.
    im = ImageEnhance.Contrast(im).enhance(1.22)
    im = ImageEnhance.Color(im).enhance(0.85)
    tint = Image.new("RGB", (240, 240), COVER_TINTS[idx % len(COVER_TINTS)])
    im = Image.blend(im, ImageChops.multiply(im, tint), 0.38)

    # Bottom gradient scrim + sleeve typography.
    overlay = Image.new("RGBA", (240, 240), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    for y in range(130, 240):
        alpha = round(185 * ((y - 130) / 110) ** 1.4)
        draw.line([(0, y), (240, y)], fill=(8, 6, 16, alpha))
    im = Image.alpha_composite(im.convert("RGBA"), overlay).convert("RGB")
    draw = ImageDraw.Draw(im)
    draw.text((16, 192), artist.upper(), font=font(13, bold=True), fill=(210, 205, 230))
    draw.text((16, 210), title, font=font(18, bold=True), fill=(255, 255, 255))

    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=88, optimize=True)
    data = buf.getvalue()
    cached.write_bytes(data)
    return "data:image/jpeg;base64," + base64.b64encode(data).decode("ascii")


# Weighted pool so the Tunings view shows 6-String (Standard, Drop D, D Standard, DADGAD) and
# 7-String (7-String Standard, 7-String Drop A) with distinct descending song counts.
DEMO_TUNINGS = (
    ["Standard"] * 7
    + ["Drop D"] * 4
    + ["D Standard"] * 3
    + ["DADGAD"] * 2
    + ["7-String Standard"] * 3
    + ["7-String Drop A"] * 2
)


def seed_library(page, base):
    songs = []
    alb_idx = 0
    song_idx = 0
    for a, albums in DEMO_LIBRARY.items():
        for al, tracks in albums.items():
            cover = fake_cover_data_url(a, al, alb_idx)
            alb_idx += 1
            for i, t in enumerate(tracks):
                tuning = DEMO_TUNINGS[song_idx % len(DEMO_TUNINGS)]
                song_idx += 1
                songs.append(dict(title=t, artist=a, album=al, trackNumber=i + 1,
                                  year=2018 + len(al) % 6, coverUrl=cover, tunings=[tuning]))
    books = ["Acoustic Songbook Vol. 1.pdf", "Progressive Etudes.pdf"]
    custom_songs = [
        dict(title="Keystone", isCustom=True, artist="Custom Music", album="", tunings=["Drop D"]),
        dict(title="Morning Prelude in G", isCustom=True, artist="Custom Music", album="", tunings=["Standard"]),
        dict(title="Odd-Meter Study No. 3", isCustom=True, artist="Custom Music", album="", tunings=["7-String Standard"]),
        dict(title="Fingerstyle Etude in D", isCustom=True, artist="Custom Music", album="", tunings=["DADGAD"]),
        dict(title="Sweep Arpeggio Workout", isCustom=True, artist="Custom Music", album="", tunings=["Standard"]),
    ]
    page.goto(f"{base}/app/", wait_until="networkidle", timeout=60000)
    page.evaluate("""async ({ songs, books, customSongs }) => {
        const lib = await import('/app/libraryStore.js');
        await lib.clearAllLibraryData();
        for (const s of songs) await lib.saveSongToLibrary(s);
        for (const b of books) {
            await lib.addTabOptionToAlbum('default', 'Custom Music', 'Custom Music', {
                name: b, fileType: 'pdf', isCustom: true
            });
        }
        for (const cs of customSongs) await lib.saveSongToLibrary(cs);
    }""", dict(songs=songs, books=books, customSongs=custom_songs))


def setup_shot(page, base, kind, supporter=False):
    if kind in ("library", "tunings"):
        seed_library(page, base)
        # Not gs.goto_library: its .lib-view-switch wait never resolves at phone width (the switch is hidden).
        page.goto(f"{base}/app/", wait_until="networkidle", timeout=60000)
        page.evaluate("import('/app/libraryModal.js').then(m => m.openLibraryModal('library'))")
        page.wait_for_selector(".artist-card", state="visible", timeout=15000)
        page.evaluate(gs.FORCE_DEFAULT_THEME_JS)
        if kind == "tunings":
            page.locator("[data-lib-tab='tunings']:visible").first.click()
            page.wait_for_selector(".tuning-card", state="visible", timeout=10000)
            page.wait_for_timeout(500)
        else:
            gs.wait_for_album_artwork(page)
        return
    gs.load_file(page, base, gs.GP_FILE, "page" if kind == "gp_page" else "continuous")
    if supporter:
        page.evaluate("import('/app/channel.js').then(m => m.setSupporterOwned(true))")
    if kind == "synth_menu":
        page.locator("#mobileSynthToggleBtn:visible, #synthToggleBtn:visible").first.click()
    elif kind == "fretboard":
        page.evaluate("document.querySelector('#toolsToggleBtn').click()")
        page.wait_for_timeout(400)
        page.evaluate("document.querySelector('#fretboardToggleBtn').click()")
        page.wait_for_timeout(800)
        page.evaluate("""async () => {
            const gp = await import('/app/gpProcessor/gpPlayer.js');
            const { fretboardController } = await import('/app/fretboard/fretboardController.js');
            const api = window.gpState.canvases[0].api;
            const beat = api.tracks[0].staves[0].bars[11].voices[0].beats[9];
            document.body.classList.add('synth-playback-started');
            const bounds = api.renderer.boundsLookup.findBeat(beat);
            document.getElementById('output').scrollTop = Math.max(0, bounds.realBounds.y - 80);
            api.tickPosition = gp.getPlaybackTickForBeat(beat, api);
            fretboardController.showBeatsAtCursor(beat);
        }""")
    elif kind == "themes":
        page.evaluate("import('/app/themeEngine.js').then(m => m.openThemeModal())")
    page.wait_for_timeout(1500)


# --- Composition -----------------------------------------------------------------------------------

FONT = "/System/Library/Fonts/Avenir Next.ttc"  # macOS: index 0 Bold, 7 Regular
WIN_FONTS = ("C:/Windows/Fonts/segoeuib.ttf", "C:/Windows/Fonts/segoeui.ttf")
BG_TOP, BG_BOTTOM, GLOW = (26, 14, 58), (8, 6, 22), (0, 190, 190)


def font(size, bold=True):
    from PIL import ImageFont
    if os.path.exists(FONT):
        return ImageFont.truetype(FONT, size, index=0 if bold else 7)
    return ImageFont.truetype(WIN_FONTS[0 if bold else 1], size)


def wrap(draw, text, fnt, width):
    lines, cur = [], ""
    for word in text.split():
        trial = f"{cur} {word}".strip()
        if draw.textlength(trial, font=fnt) <= width or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = word
    return lines + [cur]


def compose(raw_path, out_path, size, headline, subtitle):
    from PIL import Image, ImageChops, ImageDraw, ImageFilter
    W, H = size
    landscape = W > H
    k = min(W, H) / 1080  # layout below is authored at 1080 on the short side
    # Vertical gradient plus a soft accent glow behind the device.
    bg = Image.new("RGB", (W, H))
    px = ImageDraw.Draw(bg)
    for y in range(H):
        t = y / (H - 1)
        px.line([(0, y), (W, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM)))
    glow = Image.new("RGB", (W, H), (0, 0, 0))
    ImageDraw.Draw(glow).ellipse([W * 0.1, H * 0.35, W * 0.9, H * 0.95], fill=tuple(int(c * 0.28) for c in GLOW))
    bg = ImageChops.add(bg, glow.filter(ImageFilter.GaussianBlur(160 * k)))

    draw = ImageDraw.Draw(bg)
    margin = 60 * k
    head_sz, sub_sz = (56, 34) if landscape else (68, 40)
    head_f, sub_f = font(round(head_sz * k)), font(round(sub_sz * k), bold=False)
    y = (56 if landscape else 120) * k
    for line in wrap(draw, headline, head_f, W - 2 * margin):
        draw.text((W / 2, y), line, font=head_f, fill=(255, 255, 255), anchor="ma")
        y += (70 if landscape else 86) * k
    y += (10 if landscape else 16) * k
    for line in wrap(draw, subtitle, sub_f, W - 2 * margin):
        draw.text((W / 2, y), line, font=sub_f, fill=(196, 190, 226), anchor="ma")
        y += (46 if landscape else 54) * k

    # Device: scaled capture with rounded top corners, bleeding off the bottom edge without cropping bottom UI.
    shot = Image.open(raw_path).convert("RGB")
    bezel, radius = (round(12 * k), round(28 * k)) if landscape else (round(14 * k), round(64 * k))
    top = round(y + (42 if landscape else 70) * k)
    dev_w = min(round((H - top - bezel) * shot.width / shot.height), W - 2 * (bezel + round(30 * k)))
    shot = shot.resize((dev_w, round(shot.height * dev_w / shot.width)), Image.LANCZOS)
    frame_w, frame_h = dev_w + 2 * bezel, H - top + radius  # extra height keeps bottom corners off-canvas
    mask = Image.new("L", (frame_w, frame_h), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, frame_w, frame_h], radius + bezel, fill=255)
    frame = Image.new("RGB", (frame_w, frame_h), (12, 12, 20))
    inner = Image.new("L", (dev_w, frame_h - bezel), 0)
    ImageDraw.Draw(inner).rounded_rectangle([0, 0, dev_w, frame_h - bezel + radius], radius, fill=255)
    screen = Image.new("RGB", (dev_w, frame_h - bezel), (0, 0, 0))
    screen.paste(shot.crop((0, 0, dev_w, min(shot.height, frame_h - bezel))), (0, 0))
    frame.paste(screen, (bezel, bezel), inner)

    left = (W - frame_w) // 2
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    shadow.paste((0, 0, 0, 170), (left, top + round(24 * k)), mask)
    bg = Image.alpha_composite(bg.convert("RGBA"), shadow.filter(ImageFilter.GaussianBlur(36 * k))).convert("RGB")
    bg.paste(frame, (left, top), mask)
    Path(out_path).unlink(missing_ok=True)  # Windows: unlinking first avoids Errno 22 when Explorer memory-maps the PNG
    bg.save(out_path, optimize=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("channel", choices=STORES)
    ap.add_argument("--only", nargs="*", help="Only these shot ids")
    ap.add_argument("--no-prepare", action="store_true", help="Reuse build/tauri/frontend-dist as is")
    ap.add_argument("--raw", action="store_true", help="Keep unframed captures in raw/")
    ap.add_argument("--out-dir", default=None)
    args = ap.parse_args()

    from playwright.sync_api import sync_playwright

    store, cfg = STORES[args.channel], resolve_channel(args.channel)
    out = Path(args.out_dir).resolve() if args.out_dir else OUT_ROOT / args.channel
    raw_dir = out / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    if not args.only:
        for f in out.glob("[0-9][0-9]-*.png"):
            f.unlink(missing_ok=True)
    shots = [s for s in SHOTS if (not args.only or s["id"] in args.only)]
    if not args.no_prepare:
        prepare_channel_frontend(args.channel)
    httpd, base = start_channel_server()
    print(f"[{args.channel}] capabilities: {json.dumps(cfg)}")
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=["--autoplay-policy=no-user-gesture-required"])
            mobile = store.get("mobile", True)
            ctx = browser.new_context(viewport=store["viewport"], device_scale_factor=store["scale"],
                                      is_mobile=mobile, has_touch=mobile, user_agent=store["user_agent"])
            ctx.add_init_script("""
                try { Object.defineProperty(navigator, 'getGamepads', { value: () => [], configurable: true });
                      localStorage.setItem('hasSeenControllerGuide', 'true'); } catch (e) {}
            """)
            if store.get("root_classes"):
                ctx.add_init_script("document.addEventListener('DOMContentLoaded', () => document.documentElement.classList.add(...%s));"
                                    % json.dumps(store["root_classes"]))
            page = ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(f"{base}/app/", wait_until="networkidle", timeout=60000)
            live = page.evaluate("import('/app/channel.js').then(m => [m.getChannel(), m.hasSupporter()])")
            if live != [args.channel, False]:
                raise SystemExit(f"App is not running as the {args.channel} channel: {live}")
            n = 0
            for shot in SHOTS:
                if shot.get("requires") and not has_feature(cfg, shot["requires"]):
                    print(f"  skip {shot['id']}: channel lacks {shot['requires']}")
                    continue
                n += 1  # numbering follows the full list so --only never renames files
                if shot not in shots:
                    continue
                setup_shot(page, base, shot["setup"], shot.get("supporter", False))
                if store.get("no_fullscreen"):
                    shown = page.evaluate("""() => ['#fullscreenPill', '#fullscreenToggleBtn', '#toolsFullscreenRow']
                        .filter(s => { const e = document.querySelector(s); return e && e.offsetParent !== null; })""")
                    if shown:
                        raise SystemExit(f"{shot['id']}: fullscreen control visible on {args.channel}: {shown}")
                raw = raw_dir / f"{shot['id']}.png"
                page.screenshot(path=str(raw))
                final = out / f"{n:02d}-{shot['id']}.png"
                compose(raw, final, store["final"], shot["headline"], shot["subtitle"])
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
