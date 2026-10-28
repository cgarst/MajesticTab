"""Regenerate the Microsoft Store box/poster art in store-support/msstore/logos, and the Google Play
icon (512x512) and feature graphic (1024x500) in store-support/play.

Store tiles are shown at thumbnail size (~150-300px), so the art is built for that:
a large pick mark, a wordmark spanning most of the width, and no tagline (it was
unreadable when scaled down).

Requires: pip install resvg-py pillow
"""
import io
from pathlib import Path

import resvg_py
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "icons" / "icon_v2_mystic.svg"
OUT = ROOT / "store-support" / "msstore" / "logos"
PLAY_OUT = ROOT / "store-support" / "play"
FONT = "/System/Library/Fonts/Helvetica.ttc"  # index 1 = Bold
TOP, BOTTOM = (0x16, 0x13, 0x2A), (0x05, 0x04, 0x0A)
TAB_COLOR = (0x14, 0xC4, 0xC8)

# name -> (w, h, mark width fraction, wordmark width fraction, content block center y fraction)
SIZES = {
    "box-art-1080x1080.png": (1080, 1080, 0.58, 0.86, 0.50),
    "poster-art-720x1080.png": (720, 1080, 0.88, 0.92, 0.50),
}


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
    font = ImageFont.truetype(FONT, size, index=1)
    a, b = "Majestic", "Tab"
    wa, wb = font.getlength(a), font.getlength(b)
    size = int(size * width / (wa + wb))
    font = ImageFont.truetype(FONT, size, index=1)
    wa, wb = font.getlength(a), font.getlength(b)
    asc, desc = font.getmetrics()
    img = Image.new("RGBA", (round(wa + wb) + 4, asc + desc), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.text((0, 0), a, font=font, fill=(255, 255, 255, 255))
    d.text((wa, 0), b, font=font, fill=TAB_COLOR + (255,))
    return img


def render(w, h, mark_frac, word_frac, center):
    canvas = background(w, h)
    m = mark(round(w * mark_frac))
    t = wordmark(round(w * word_frac))
    gap = round(h * 0.05)
    block = m.height + gap + t.height
    y0 = round(h * center - block / 2)
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse(
        (w * 0.1, y0 - m.height * 0.1, w * 0.9, y0 + m.height * 1.1), fill=(20, 140, 170, 90)
    )
    canvas.alpha_composite(glow.filter(ImageFilter.GaussianBlur(w * 0.08)))
    canvas.alpha_composite(m, ((w - m.width) // 2, y0))
    canvas.alpha_composite(t, ((w - t.width) // 2, y0 + m.height + gap))
    return canvas.convert("RGB")


def render_play_icon(size=512):
    """The launcher icon (opaque full-bleed square; Play applies its own mask), so the listing matches the installed app.

    Needs the generated iOS icon: run `npm run generate:icons -- ios` in build/tauri first.
    """
    source = ROOT / "build" / "tauri" / "src-tauri" / "icons" / "ios" / "AppIcon-512@2x.png"
    if not source.exists():
        raise SystemExit(f"Missing {source.relative_to(ROOT)}; run `npm run generate:icons -- ios` in build/tauri.")
    return Image.open(source).convert("RGBA").resize((size, size), Image.LANCZOS)


def render_play_feature(w=1024, h=500):
    """Mark left, wordmark right; Play crops the edges on some surfaces, so keep a wide margin."""
    canvas = background(w, h)
    m = mark(round(h * 0.70))
    t = wordmark(round(w * 0.46))
    gap = round(w * 0.04)
    x0 = round((w - (m.width + gap + t.width)) / 2)
    my = (h - m.height) // 2
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse((x0 - m.width * 0.3, my - m.height * 0.2, x0 + m.width * 1.3, my + m.height * 1.2),
                                 fill=(20, 140, 170, 90))
    canvas.alpha_composite(glow.filter(ImageFilter.GaussianBlur(h * 0.12)))
    canvas.alpha_composite(m, (x0, my))
    canvas.alpha_composite(t, (x0 + m.width + gap, (h - t.height) // 2))
    return canvas.convert("RGB")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    PLAY_OUT.mkdir(parents=True, exist_ok=True)
    for name, args in SIZES.items():
        render(*args).save(OUT / name)
        print(f"wrote {name}")
    render_play_icon().save(PLAY_OUT / "icon-512.png")
    render_play_feature().save(PLAY_OUT / "feature-graphic-1024x500.png")
    print("wrote play/icon-512.png, play/feature-graphic-1024x500.png")


if __name__ == "__main__":
    main()
