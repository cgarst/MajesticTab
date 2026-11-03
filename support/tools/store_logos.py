"""Regenerate the Microsoft Store box/poster art in support/store/msstore/logos, and the Google Play
icon (512x512), feature graphic (1024x500) and TV banner (1280x720) in fastlane/metadata/android/en-US/images.

Store tiles are shown at thumbnail size (~150-300px), so the art is built for that:
a large pick mark, a wordmark spanning most of the width, and no tagline (it was
unreadable when scaled down).

Requires: pip install resvg-py pillow fonttools brotli
"""
import io
import tempfile
from pathlib import Path

import resvg_py
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent.parent
SOURCE = ROOT / "support" / "branding" / "icon_v3.svg"
OUT = ROOT / "support" / "store" / "msstore" / "logos"
PLAY_OUT = ROOT / "fastlane" / "metadata" / "android" / "en-US" / "images"
# The wordmark uses the landing page header font (.brand in docs/site.css: Barlow Condensed 600).
FONT_WOFF2 = ROOT / "docs" / "fonts" / "barlow-condensed-latin-600-normal.woff2"
TOP, BOTTOM = (0xFF, 0xFF, 0xFF), (0xFF, 0xFF, 0xFF)  # flat white ground, like the app icon's tile
INK = (0x11, 0x17, 0x24)  # the pick's body color
TAB_COLOR = (0x2F, 0x40, 0x66)  # the pick's rim (Slate Blue); the landing page colors "Tab" with --action instead, since its ground is dark

# name -> (w, h, mark width fraction, wordmark width fraction, content block center y fraction)
SIZES = {
    "box-art-1080x1080.png": (1080, 1080, 0.58, 0.86, 0.50),
    "poster-art-720x1080.png": (720, 1080, 0.88, 0.92, 0.50),
}


def font_path():
    """PIL cannot read woff2, so convert the site's font to a temporary TTF once."""
    out = Path(tempfile.gettempdir()) / "majestictab-barlow-condensed-600.ttf"
    if not out.exists():
        f = TTFont(str(FONT_WOFF2))
        f.flavor = None
        f.save(str(out))
    return str(out)


def background(w, h):
    col = Image.new("RGB", (1, h))
    for y in range(h):
        t = y / (h - 1)
        col.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)))
    return col.resize((w, h)).convert("RGBA")


def mark(width):
    data = bytes(resvg_py.svg_to_bytes(svg_path=str(SOURCE), width=width))
    return Image.open(io.BytesIO(data)).convert("RGBA")


def wordmark(width):
    size = 100
    font = ImageFont.truetype(font_path(), size)
    a, b = "Majestic", "Tab"
    wa, wb = font.getlength(a), font.getlength(b)
    size = int(size * width / (wa + wb))
    font = ImageFont.truetype(font_path(), size)
    wa, wb = font.getlength(a), font.getlength(b)
    asc, desc = font.getmetrics()
    img = Image.new("RGBA", (round(wa + wb) + 4, asc + desc), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.text((0, 0), a, font=font, fill=INK + (255,))
    d.text((wa, 0), b, font=font, fill=TAB_COLOR + (255,))
    return img


def render(w, h, mark_frac, word_frac, center):
    canvas = background(w, h)
    m = mark(round(w * mark_frac))
    t = wordmark(round(w * word_frac))
    gap = round(h * 0.05)
    block = m.height + gap + t.height
    y0 = round(h * center - block / 2)
    canvas.alpha_composite(m, ((w - m.width) // 2, y0))
    canvas.alpha_composite(t, ((w - t.width) // 2, y0 + m.height + gap))
    return canvas.convert("RGB")


def render_play_icon(size=512):
    """The launcher icon (opaque full-bleed square; Play applies its own mask), so the listing matches the installed app.

    Same art and white tile as build/tauri/generate-icons.mjs.
    """
    canvas = Image.new("RGBA", (size, size), (255, 255, 255, 255))
    m = mark(round(size * 0.62))
    canvas.alpha_composite(m, ((size - m.width) // 2, (size - m.height) // 2))
    return canvas


def render_play_feature(w=1024, h=500):
    """Mark left, wordmark right; Play crops the edges on some surfaces, so keep a wide margin."""
    canvas = background(w, h)
    m = mark(round(h * 0.70))
    t = wordmark(round(w * 0.46))
    gap = round(w * 0.04)
    x0 = round((w - (m.width + gap + t.width)) / 2)
    my = (h - m.height) // 2
    canvas.alpha_composite(m, (x0, my))
    canvas.alpha_composite(t, (x0 + m.width + gap, (h - t.height) // 2))
    return canvas.convert("RGB")


def render_tv_banner(w=1280, h=720):
    """Android TV banner: the Play listing's 1280x720 tvBanner and (scaled to 320x180) the launcher android:banner.

    Mark left, wordmark right like the feature graphic, but sized to fill the 16:9 frame since the launcher shows
    it small; the leanback launcher requires the app name in the banner itself.
    """
    canvas = background(w, h)
    m = mark(round(h * 0.62))
    t = wordmark(round(w * 0.44))
    gap = round(w * 0.03)
    x0 = round((w - (m.width + gap + t.width)) / 2)
    my = (h - m.height) // 2
    canvas.alpha_composite(m, (x0, my))
    canvas.alpha_composite(t, (x0 + m.width + gap, (h - t.height) // 2))
    return canvas.convert("RGB")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    PLAY_OUT.mkdir(parents=True, exist_ok=True)
    for name, args in SIZES.items():
        render(*args).save(OUT / name)
        print(f"wrote {name}")
    render_play_icon().save(PLAY_OUT / "icon.png")
    render_play_feature().save(PLAY_OUT / "featureGraphic.png")
    print("wrote fastlane icon.png, featureGraphic.png")
    tv = render_tv_banner()
    tv.save(PLAY_OUT / "tvBanner.png")
    tv.resize((320, 180), Image.LANCZOS).save(ROOT / "build" / "tauri" / "android-tv-banner.png")
    print("wrote fastlane tvBanner.png, build/tauri/android-tv-banner.png")


if __name__ == "__main__":
    main()
