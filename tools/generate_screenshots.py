#!/usr/bin/env python3
"""Generate landing-page screenshots of the MajesticTab app using the demo files.

Serves the repo root on a temporary local port, drives the app with Playwright
(desktop 1440x900 and mobile 390x844), and writes PNGs to img/screenshots/.

Usage:
    pip install playwright && playwright install chromium
    python3 tools/generate_screenshots.py            # all shots
    python3 tools/generate_screenshots.py --only gp_scroll theme_palettes

Demo files live in tests/ (Keystone.gp and Keystone.pdf).
"""
import argparse
import functools
import http.server
import socket
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "img" / "screenshots"
GP_FILE = ROOT / "tests" / "Keystone.gp"
PDF_FILE = ROOT / "tests" / "Keystone.pdf"

VIEWPORTS = [
    ("desktop", {"width": 1440, "height": 900}, False, 1, ""),
    ("mobile", {"width": 390, "height": 844}, True, 2, "_mobile"),
]

FORCE_DEFAULT_THEME_JS = """
() => {
  try { localStorage.removeItem('majestictab_theme'); localStorage.removeItem('majestictab_sheet_mode'); } catch (e) {}
  document.documentElement.setAttribute('data-theme', 'Mystic Dream');
}
"""


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def start_server():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    handler = functools.partial(_Quiet, directory=str(ROOT))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{port}"


def load_file(page, base_url, path, mode):
    """Open the app fresh, upload `path`, and pick 'page' or 'continuous' view."""
    page.goto(f"{base_url}/app/", wait_until="load", timeout=60000)
    page.evaluate(FORCE_DEFAULT_THEME_JS)
    page.set_input_files("#localFile", str(path))
    page.wait_for_selector("#output canvas, #output svg", timeout=90000)
    page.wait_for_timeout(2500)
    radio = "#continuousModeRadio" if mode == "continuous" else "#pageModeRadio"
    page.evaluate(f"document.querySelector('{radio}').click()")
    page.wait_for_timeout(2000)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--only", nargs="*", help="Only capture these shot names (e.g. gp_scroll pdf_page)")
    args = parser.parse_args()

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        raise SystemExit("Playwright not installed: pip install playwright && playwright install chromium")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    httpd, base_url = start_server()
    print(f"[server] {base_url}")

    def wanted(name):
        return not args.only or name in args.only

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=["--disable-dev-shm-usage", "--no-sandbox"])
            for vp_name, vp, is_mobile, scale, suffix in VIEWPORTS:
                print(f"[{vp_name}] {vp['width']}x{vp['height']}")
                context = browser.new_context(
                    viewport=vp, is_mobile=is_mobile, has_touch=is_mobile, device_scale_factor=scale
                )
                page = context.new_page()

                def save(name):
                    target = OUT_DIR / f"{name}{suffix}.png"
                    page.screenshot(path=str(target))
                    print(f"  wrote {target.relative_to(ROOT)}")

                # Guitar Pro, continuous scroll
                if wanted("gp_scroll"):
                    load_file(page, base_url, GP_FILE, "continuous")
                    save("gp_scroll")

                # Guitar Pro, page view
                if wanted("gp_page"):
                    load_file(page, base_url, GP_FILE, "page")
                    save("gp_page")

                # PDF, page view
                if wanted("pdf_page"):
                    load_file(page, base_url, PDF_FILE, "page")
                    save("pdf_page")

                # Settings drawer
                if wanted("menu"):
                    load_file(page, base_url, GP_FILE, "continuous")
                    page.evaluate("document.querySelector('#menuToggleBtn').click()")
                    page.wait_for_timeout(1000)
                    save("menu")

                # Theme selector modal (desktop and mobile)
                if wanted("theme_palettes"):
                    load_file(page, base_url, GP_FILE, "continuous")
                    page.evaluate("import('./themeEngine.js').then(m => m.openThemeModal())")
                    page.wait_for_timeout(1000)
                    save("theme_palettes")

                # Same tab in a different theme, to show theming live
                if wanted("gp_themed"):
                    load_file(page, base_url, GP_FILE, "continuous")
                    page.evaluate("import('./themeEngine.js').then(m => { m.setTheme('Ember Glow'); m.setSheetMode('theme'); })")
                    page.wait_for_timeout(1500)
                    save("gp_themed")

                context.close()
            browser.close()
    finally:
        httpd.shutdown()


if __name__ == "__main__":
    main()
