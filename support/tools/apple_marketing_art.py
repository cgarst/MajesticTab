#!/usr/bin/env python3
"""App Store header and search-result artwork, made from the real simulator captures.

Run support/tools/simulator_screenshots.py iphone ipad first: this reads their raw/ captures (the reader on iPhone, the library on
iPad), puts them in the same flat devices as the screenshots (store_screenshots.device_html) on the same flat Slate Blue frame, with the
app icon, the name and one line of copy on the left, and lets the devices run off the bottom edge.

Usage:
    python3 support/tools/apple_marketing_art.py            # every size below
    python3 support/tools/apple_marketing_art.py header     # header only (also: search)

Output: support/store/appstore-art/<kind>-<W>x<H>.png
    header: 5244x2950, 3840x1646
    search: 5244x2950, 3840x2560, 1920x1280
"""
import argparse
import base64
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import store_screenshots as ss  # noqa: E402

OUT = ss.OUT_ROOT / "appstore-art"
ICON = ss.ROOT / "src" / "icons" / "android-chrome-512x512.png"
SIZES = {
    "header": [(5244, 2950), (3840, 1646)],
    "search": [(5244, 2950), (3840, 2560), (1920, 1280)],
}
NAME, LINE = "MajesticTab", "Every guitar part, together."


def data_uri(path):
    return "data:image/png;base64," + base64.b64encode(Path(path).read_bytes()).decode("ascii")


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
    out = OUT / f"{kind}-{W}x{H}.png"
    page.screenshot(path=str(out), full_page=False)
    from PIL import Image as _I
    _I.open(out).convert("RGB").save(out)  # no alpha channel
    print(f"wrote {out}", flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("kind", nargs="?", choices=[*SIZES, "all"], default="all")
    args = ap.parse_args()
    from playwright.sync_api import sync_playwright
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_context(viewport={"width": 1080, "height": 1920}).new_page()
        for kind in ([*SIZES] if args.kind == "all" else [args.kind]):
            for size in SIZES[kind]:
                render(page, kind, size)
        browser.close()


if __name__ == "__main__":
    main()
