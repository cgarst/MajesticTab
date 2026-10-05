"""Regenerate the web PNG/ICO icons from icon_v2_mystic.svg.

The iOS and maskable icons are opaque full-bleed squares (the OS applies its own mask);
the rest keep a transparent background.

Requires: pip install resvg-py pillow
"""
import io
from pathlib import Path

import resvg_py
from PIL import Image

HERE = Path(__file__).resolve().parent
SOURCE = HERE / "icon_v2_mystic.svg"

PNG_SIZES = {
    "android-chrome-192x192.png": 192,
    "android-chrome-512x512.png": 512,
    "favicon-16x16.png": 16,
    "favicon-32x32.png": 32,
}
# Vertical gradient (top, bottom) for the opaque icons.
BACKGROUND = ((0xFF, 0xFF, 0xFF), (0xDD, 0xD3, 0xF7))
# name -> (size, art longest side as a fraction of the canvas)
OPAQUE_SIZES = {
    "apple-touch-icon.png": (180, 0.62),
    "android-chrome-maskable-512x512.png": (512, 0.58),
}
ICO_SIZES = [16, 32, 48]


def vertical_gradient(size: int, top, bottom) -> Image.Image:
    column = Image.new("RGBA", (1, size))
    for y in range(size):
        t = y / max(size - 1, 1)
        column.putpixel((0, y), (*(round(a + (b - a) * t) for a, b in zip(top, bottom)), 255))
    return column.resize((size, size))


def render(size: int, fraction: float = 1.0, background=None) -> Image.Image:
    # The artwork is not square; fit its longest side and center it on a square canvas.
    box = round(size * fraction)
    data = bytes(resvg_py.svg_to_bytes(svg_path=str(SOURCE), height=box))
    art = Image.open(io.BytesIO(data)).convert("RGBA")
    if art.width > box:
        art = art.resize((box, round(art.height * box / art.width)), Image.LANCZOS)
    canvas = vertical_gradient(size, *background) if background else Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(art, ((size - art.width) // 2, (size - art.height) // 2))
    return canvas


def main() -> None:
    for name, size in PNG_SIZES.items():
        render(size).save(HERE / name)
        print(f"wrote {name}")
    for name, (size, fraction) in OPAQUE_SIZES.items():
        render(size, fraction, BACKGROUND).save(HERE / name)
        print(f"wrote {name}")
    render(max(ICO_SIZES)).save(
        HERE / "favicon.ico", format="ICO", sizes=[(s, s) for s in ICO_SIZES]
    )
    print("wrote favicon.ico")


if __name__ == "__main__":
    main()
