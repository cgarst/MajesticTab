#!/usr/bin/env python3
"""App Store header and search-result artwork, plus the GitHub social preview, made from the real store captures.

Run support/tools/simulator_screenshots.py iphone ipad first: this reads their raw/ captures (the reader on iPhone, the library on
iPad), puts them in the same flat devices as the screenshots (store_screenshots.device_html) on the same flat Slate Blue frame, with the
app icon, the name and one line of copy on the left, and lets the devices run off the bottom edge. The `github` target pulls in all five
supported platforms: an iPhone Duo in tabletop mode, a desktop monitor running the Windows version, a MacBook running the Mac version,
an Android phone, and a Steam Deck running the Flatpak.

Usage:
    python3 support/tools/apple_marketing_art.py            # every size below
    python3 support/tools/apple_marketing_art.py header     # header only (also: search, github)

Output:
    support/store/appstore-art/<kind>-<W>x<H>.png
        header: 5244x2950, 3840x1646
        search: 5244x2950, 3840x2560, 1920x1280
    support/store/github/social-preview-1280x640.png
    support/store/github/social-preview-all-devices-1280x640.png
"""
import argparse
import base64
import io
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import simulator_screenshots as sim  # noqa: E402
import store_screenshots as ss  # noqa: E402

OUT = ss.OUT_ROOT / "appstore-art"
GITHUB_OUT = ss.OUT_ROOT / "github"
ICON = ss.ROOT / "src" / "icons" / "android-chrome-512x512.png"
SIZES = {
    "header": [(5244, 2950), (3840, 1646)],
    "search": [(5244, 2950), (3840, 2560), (1920, 1280)],
    "github": [(1280, 640)],
}
NAME, LINE = "MajesticTab", "Every guitar part, together."


def data_uri(path):
    return "data:image/png;base64," + base64.b64encode(Path(path).read_bytes()).decode("ascii")


def pil_uri(im):
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def extract_store_screen(framed_path):
    """Crop the exact screen rectangle out of a composed store screenshot by scanning from the center to the #05070b glass bezel."""
    from PIL import Image
    im = Image.open(framed_path).convert("RGB")
    w, h = im.size
    cx, cy = w // 2 - 120, int(h * 0.6)
    sy0 = next(y for y in range(cy, 0, -1) if im.getpixel((cx, y)) == (5, 7, 11)) + 1
    sy1 = next(y for y in range(cy, h) if im.getpixel((cx, y)) == (5, 7, 11))
    sx0 = next(x for x in range(cx, 0, -1) if im.getpixel((x, cy)) == (5, 7, 11)) + 1
    sx1 = next(x for x in range(cx, w) if im.getpixel((x, cy)) == (5, 7, 11))
    crop = im.crop((sx0, sy0, sx1, sy1))
    return pil_uri(crop), crop.width / crop.height


def duo_tabletop_html(x, y, ws, raw_path, fold_path):
    """3D tabletop iPhone Duo from simulator_screenshots.compose_laptop, positioned at (x, y) with screen width `ws`."""
    from PIL import Image
    cap = Image.open(raw_path).convert("RGB")
    fold = json.loads(Path(fold_path).read_text())
    sc = cap.width / fold["w"]
    split = round((fold["top"] + fold["h"] / 2) * sc)
    top_im = cap.crop((0, 0, cap.width, split))
    bot_im = cap.crop((0, split, cap.width, cap.height))
    lean, flat, persp = 12, 68, 6.0
    r_top, r_bot = top_im.height / cap.width, bot_im.height / cap.width
    short = min(ws, ws * r_top)
    bz, rim = 0.011 * short, 0.004 * short
    pad = bz + rim
    pw = ws + 2 * pad
    ht, hb = ws * r_top + pad, ws * r_bot + pad
    rad = 0.05 * short + pad
    ri = max(rad - rim, 0)
    depth = 0.024 * ws
    top_panel = sim.fold_panel(pil_uri(top_im), pw, ht, (rad, rad, 0, 0), (ri, ri, 0, 0), "bottom", bz, rim, depth,
                               f"position:absolute;left:0;top:0;box-sizing:border-box;transform-origin:50% 100%;transform:rotateX({lean}deg)")
    bot_panel = sim.fold_panel(pil_uri(bot_im), pw, hb, (0, 0, rad, rad), (0, 0, ri, ri), "top", bz, rim, depth,
                               f"position:absolute;left:0;top:{ht - 1:.1f}px;box-sizing:border-box;transform-origin:50% 0;transform:rotateX({flat}deg)")
    return (f"<div style='position:absolute;left:{x:.1f}px;top:{y:.1f}px;width:{pw:.1f}px;"
            f"perspective:{persp * ws:.0f}px;perspective-origin:50% 15%'>{top_panel}{bot_panel}</div>")


def render_github(page, size):
    """Compose all supported platforms on a 1280x640 canvas, with visual focus on the MacBook, iPad, and iPhone."""
    from PIL import Image
    W, H = size
    iphone_raw = ss.OUT_ROOT / "appstore-ios" / "raw" / "reader.png"
    ipad_raw = ss.OUT_ROOT / "appstore-ipad" / "raw" / "library.png"
    mac_raw = ss.OUT_ROOT / "appstore-mac" / "raw" / "original.png"
    win_framed = ss.OUT_ROOT / "msstore" / "06-practice.png"
    duo_raw = ss.OUT_ROOT / "appstore-duo" / "raw" / "01-reader.png"
    duo_fold = ss.OUT_ROOT / "appstore-duo" / "raw" / "01-reader.fold.json"
    android_framed = ss.ROOT / "fastlane" / "metadata" / "android" / "en-US" / "images" / "phoneScreenshots" / "04-guitar.png"
    deck_shot = ss.ROOT / "docs" / "img" / "app" / "guitar.webp"
    for f in (iphone_raw, ipad_raw, mac_raw, win_framed, duo_raw, duo_fold, android_framed, deck_shot, ICON):
        if not f.exists():
            raise SystemExit(f"Missing {f}")

    # Back-upper: Desktop monitor running the Windows version (full stand visible above the MacBook)
    win_uri, win_a = extract_store_screen(win_framed)
    d_win = ss.device_layout("tv", win_a, 420, 260)
    sh_w = d_win["sh"]
    d_win["bz"] = (0.016 * sh_w, 0.016 * sh_w, 0.016 * sh_w, 0.024 * sh_w)
    d_win["rim"] = 0.006 * sh_w
    d_win["sr"] = 0.006 * sh_w

    # Far-right supporting: Android phone
    and_uri, and_a = extract_store_screen(android_framed)
    d_and = ss.device_layout("phone", and_a, 185, 360)

    # Center-left hero: MacBook running the Mac version
    mac_im = Image.open(mac_raw).convert("RGB")
    d_mac = ss.device_layout("laptop", mac_im.width / mac_im.height, 450, 300)

    # Center-right heroes: iPad and iPhone (same pair and arrangement as the original header art)
    ipad_im = Image.open(ipad_raw).convert("RGB")
    d_ipad = ss.device_layout("ipad", ipad_im.width / ipad_im.height, 420, 520)
    iphone_im = Image.open(iphone_raw).convert("RGB")
    d_iphone = ss.device_layout("iphone", iphone_im.width / iphone_im.height, 260, 510)

    # Off to the lower-left side: Steam Deck running the Flatpak
    deck_im = Image.open(deck_shot).convert("RGB")
    d_deck = ss.device_layout("steamdeck", deck_im.width / deck_im.height, 320, 160)

    # Upper-left branding column
    m = 40
    name_px = 64
    head = "Your music stand. Without the mess."
    sub = "Stacked guitar tracks and built-in practice tools, synced everywhere you play."
    css = ss.FRAME_CSS % dict(fonts=ss.FONTS_DIR.as_uri(), w=W, h=H, m=m, top=0, ptop=0, hs=0, ps=0)
    css += f"""
    .copy {{ position:absolute; left:{m}px; top:122px; width:322px; display:flex; flex-direction:column; align-items:flex-start; }}
    .icon {{ position:static; width:56px; height:56px; border-radius:12.5px; background:none; margin-bottom:14px; }}
    .name {{ white-space:nowrap; font:600 {name_px}px/0.95 'Barlow Condensed','Arial Narrow',sans-serif; letter-spacing:-0.005em; margin-bottom:14px; }}
    .head {{ font-size:19.5px; font-weight:600; line-height:1.25; color:var(--ink); white-space:nowrap; margin-bottom:7px; }}
    .line {{ font-size:16.5px; line-height:1.38; color:var(--ink2); }}
    """
    body = "".join([
        ss.device_html("tv", d_win, 386, 14, win_uri),
        ss.device_html("ipad", d_ipad, 736, 76, pil_uri(ipad_im)),
        ss.device_html("phone", d_and, 1084, 118, and_uri),
        ss.device_html("laptop", d_mac, 386, 282, pil_uri(mac_im)),
        ss.device_html("iphone", d_iphone, 916, 178, pil_uri(iphone_im)),
        duo_tabletop_html(648, 392, 166, duo_raw, duo_fold),
        ss.device_html("steamdeck", d_deck, 56, 448, pil_uri(deck_im)),
    ])
    html = (f"<!doctype html><meta charset=utf-8><style>{css}</style>"
            f"<div class=copy><img class=icon src='{data_uri(ICON)}'><div class=name>{NAME}</div>"
            f"<div class=head>{head}</div><div class=line>{sub}</div></div>{body}")
    page.set_viewport_size({"width": W, "height": H})
    page.set_content(html, wait_until="load")
    page.evaluate("document.fonts.ready")
    page.wait_for_timeout(300)
    out = GITHUB_OUT / f"social-preview-all-devices-{W}x{H}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(out), full_page=False)
    Image.open(out).convert("RGB").save(out)
    print(f"wrote {out}", flush=True)


def render(page, kind, size):
    from PIL import Image
    W, H = size
    k = H / 1000  # authored on a 1000 px tall canvas
    iphone = ss.OUT_ROOT / "appstore-ios" / "raw" / "reader.png"
    ipad = ss.OUT_ROOT / "appstore-ipad" / "raw" / "library.png"
    for f in (iphone, ipad, ICON):
        if not f.exists():
            raise SystemExit(f"Missing {f}: run support/tools/simulator_screenshots.py iphone ipad first")
    wide = W / H > 1.9
    # The devices sit on the right and run off the bottom; the iPad behind, the iPhone in front.
    ph, th = (1.02 * H, 0.92 * H) if not wide else (1.0 * H, 0.9 * H)
    ia, ta = Image.open(iphone), Image.open(ipad)
    di = ss.device_layout("iphone", ia.width / ia.height, 10 * W, ph)
    dt = ss.device_layout("ipad", ta.width / ta.height, 10 * W, th)
    right = W - 90 * k
    ix = right - di["total"][0]
    tx = ix - 0.55 * dt["total"][0] - 40 * k
    ty = 0.1 * H
    iy = 0.2 * H
    m = 110 * k
    colw = max(tx - 1.6 * m, 200 * k)  # the text column, up to the first device
    name_px = min(170 * k, colw / 5.6)  # "MajesticTab" in Barlow Condensed is about 5.5 em wide
    line_px = max(name_px * 0.3, 30 * k)
    cy = (0.5 if wide else 0.36) * H  # vertical centre of the text block
    css = ss.FRAME_CSS % dict(fonts=ss.FONTS_DIR.as_uri(), w=W, h=H, m=m, top=0, ptop=0, hs=0, ps=0)
    css += f"""
    .icon {{ position:absolute; left:{m}px; top:{cy - name_px * 1.9}px; width:{name_px * 0.9}px; height:{name_px * 0.9}px; border-radius:{name_px * 0.9 * 0.224}px; background:none; }}
    .name {{ position:absolute; left:{m}px; top:{cy - name_px * 0.75}px; white-space:nowrap; font:600 {name_px}px/1 'Barlow Condensed','Arial Narrow',sans-serif; letter-spacing:-0.005em; }}
    .line {{ position:absolute; left:{m}px; top:{cy + name_px * 0.45}px; width:{colw}px; font-size:{line_px}px; line-height:1.3; color:var(--ink2); }}
    """
    body = (ss.device_html("ipad", dt, tx, ty, data_uri(ipad)) + ss.device_html("iphone", di, ix, iy, data_uri(iphone)))
    html = (f"<!doctype html><meta charset=utf-8><style>{css}</style>"
            f"<img class=icon src='{data_uri(ICON)}'><div class=name>{NAME}</div><div class=line>{LINE}</div>{body}")
    page.set_viewport_size({"width": W, "height": H})
    page.set_content(html, wait_until="load")
    page.evaluate("document.fonts.ready")
    page.wait_for_timeout(300)
    out = (GITHUB_OUT / f"social-preview-{W}x{H}.png") if kind == "github" else (OUT / f"{kind}-{W}x{H}.png")
    out.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(out), full_page=False)
    from PIL import Image as _I
    _I.open(out).convert("RGB").save(out)  # no alpha channel
    print(f"wrote {out}", flush=True)
    if kind == "github":
        render_github(page, size)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("kind", nargs="?", choices=[*SIZES, "all"], default="all")
    args = ap.parse_args()
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_context(viewport={"width": 1080, "height": 1920}).new_page()
        for kind in ([*SIZES] if args.kind == "all" else [args.kind]):
            for size in SIZES[kind]:
                render(page, kind, size)
        browser.close()


if __name__ == "__main__":
    main()
