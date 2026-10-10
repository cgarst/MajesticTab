#!/usr/bin/env python3
"""Generate landing-page screenshots of the MajesticTab app using the demo files and user backup.

Serves the repo root on a temporary local port, drives the app with Playwright
(desktop 1440x900 and mobile 390x844), and writes PNGs to img/screenshots/.

Usage:
    pip install playwright && playwright install chromium
    python3 tools/generate_screenshots.py            # all shots
    python3 tools/generate_screenshots.py --only gp_scroll theme_palettes
"""
import argparse
import functools
import http.server
import os
import socket
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "img" / "screenshots"
GP_FILE = ROOT / "tests" / "Keystone.gp"
PDF_FILE = ROOT / "tests" / "Keystone.pdf"
DEFAULT_BACKUP = Path.home() / "Downloads" / "MajesticTab-backup-2026-10-10.mtbackup"

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


def restore_backup(page, base_url, backup_path):
    """Restore .mtbackup user data into browser IndexedDB."""
    if not backup_path or not os.path.exists(backup_path):
        print(f"[restore] backup file not found: {backup_path}")
        return False
    print(f"[restore] restoring user data from {backup_path}...")
    page.goto(f"{base_url}/app/", wait_until="networkidle", timeout=60000)
    page.evaluate(FORCE_DEFAULT_THEME_JS)
    page.wait_for_timeout(1000)
    page.evaluate("import('/app/backupRestore.js').then(m => m.openBackupModal('restore'))")
    page.wait_for_timeout(500)
    page.set_input_files("#restoreFileInput", str(backup_path))
    page.wait_for_selector("#restoreInspectionCard", state="visible", timeout=20000)
    page.click("#restoreExecuteBtn")
    # Wait for restore completion alert
    t0 = time.time()
    while time.time() - t0 < 60:
        alert_text = page.locator("#restoreStatusAlert").inner_text()
        if "Restore Complete" in alert_text:
            print("[restore] completed successfully!")
            break
        page.wait_for_timeout(1000)
    page.click("#backupModalCloseBtn")
    page.wait_for_timeout(1500)
    return True


def wait_for_album_artwork(page, timeout=12000):
    """Wait for album cover images and artwork blobs in the library to complete loading."""
    t0 = time.time()
    while time.time() - t0 < (timeout / 1000.0):
        pending = page.evaluate("""() => {
            const imgs = Array.from(document.querySelectorAll('.artist-thumbnail img, .library-card img, .album-card img, .album-detail-view img'));
            if (imgs.length === 0) return 0;
            return imgs.filter(img => !img.complete).length;
        }""")
        if pending == 0:
            break
        page.wait_for_timeout(500)
    page.wait_for_timeout(1000)


def load_file(page, base_url, path, mode, condense=False):
    """Open the app fresh with ?test=<filename>, and pick 'page' or 'continuous' view.

    With condense=True the (experimental) Condense PDF option is enabled first.
    """
    filename = Path(path).name
    page.goto(f"{base_url}/app/?test={filename}", wait_until="networkidle", timeout=60000)
    page.evaluate(FORCE_DEFAULT_THEME_JS)
    if condense:
        page.evaluate("document.querySelector('#condensePdfMode').click()")
    page.wait_for_selector("#output canvas, #output svg", timeout=90000)
    # Condensing renders progressively; give it time to finish before capturing.
    page.wait_for_timeout(15000 if condense else 2500)
    radio = "#continuousModeRadio" if mode == "continuous" else "#pageModeRadio"
    page.evaluate(f"document.querySelector('{radio}').click()")
    page.wait_for_timeout(2000)


def load_stored_tab(page, base_url, search_query, mode="continuous"):
    """Load a tab directly from IndexedDB fileStore by partial filename match."""
    page.goto(f"{base_url}/app/", wait_until="networkidle", timeout=60000)
    page.evaluate(FORCE_DEFAULT_THEME_JS)
    page.wait_for_timeout(1000)
    res = page.evaluate(
        """async (query) => {
        const fsMod = await import('/app/fileStore.js');
        const files = await fsMod.getAllStoredFiles();
        const f = files.find(x => x.name.toLowerCase().includes(query.toLowerCase()));
        if (!f) return { error: 'Tab not found in fileStore: ' + query };
        const stored = await fsMod.getStoredFile(f.id);
        const main = await import('/app/main.js');
        await main.loadFile(stored.file);
        return { success: true, name: f.name };
    }""",
        search_query,
    )
    if res and res.get("error"):
        print(f"[warning] {res['error']}, falling back to test tab...")
        load_file(page, base_url, GP_FILE, mode)
        return False
    print(f"[tab] loaded stored tab: {res.get('name')}")
    page.wait_for_selector("#output canvas, #output svg", timeout=90000)
    page.wait_for_timeout(3000)
    radio = "#continuousModeRadio" if mode == "continuous" else "#pageModeRadio"
    page.evaluate(f"document.querySelector('{radio}').click()")
    page.wait_for_timeout(2500)
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--only", nargs="*", help="Only capture these shot names")
    parser.add_argument("--backup-file", default=str(DEFAULT_BACKUP), help="Path to .mtbackup file")
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

    backup_path = Path(args.backup_file)

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

                # 1. Restore backup data if requested/available
                has_backup = False
                if backup_path.exists():
                    has_backup = restore_backup(page, base_url, backup_path)

                # 2. Tab Library View (Artists grid with artwork loaded)
                if wanted("library_grid") and has_backup:
                    page.goto(f"{base_url}/app/", wait_until="networkidle", timeout=60000)
                    wait_for_album_artwork(page)
                    save("library_grid")

                # 2b. Tab Library: Tunings View
                if wanted("library_tunings") and has_backup and not is_mobile:
                    page.goto(f"{base_url}/app/", wait_until="networkidle", timeout=60000)
                    page.wait_for_selector("button[data-mode='tunings']", timeout=10000)
                    page.locator("button[data-mode='tunings']").click()
                    page.wait_for_timeout(1500)
                    save("library_tunings")

                # 2c. Tab Library: Parasomnia Album Song List View
                if wanted("library_album_parasomnia") and has_backup and not is_mobile:
                    page.goto(f"{base_url}/app/", wait_until="networkidle", timeout=60000)
                    page.wait_for_selector(".artist-card[data-artist-name='Dream Theater']", timeout=15000)
                    page.locator(".artist-card[data-artist-name='Dream Theater']").click()
                    page.wait_for_timeout(1500)
                    page.wait_for_selector(".album-card[data-album-title='Parasomnia']", timeout=15000)
                    wait_for_album_artwork(page)
                    page.locator(".album-card[data-album-title='Parasomnia']").click()
                    page.wait_for_timeout(1500)
                    wait_for_album_artwork(page)
                    save("library_album_parasomnia")

                # 3. Continuous Scroll View: Rush - Tom Sawyer
                if wanted("gp_scroll"):
                    if has_backup:
                        load_stored_tab(page, base_url, "rush_tom_sawyer.gp4", "continuous")
                    else:
                        load_file(page, base_url, GP_FILE, "continuous")
                    save("gp_scroll")

                # 4. Page View: Rush - Tom Sawyer (same song as scroll view)
                if wanted("gp_page"):
                    if has_backup:
                        load_stored_tab(page, base_url, "rush_tom_sawyer.gp4", "page")
                    else:
                        load_file(page, base_url, GP_FILE, "page")
                    save("gp_page")

                # 5. Top Bar HUD crop (desktop only): Megadeth - Hangar 18 (NO gamepad pill, clipped 2px bottom)
                if wanted("topbar_hud") and not is_mobile:
                    if has_backup:
                        load_stored_tab(page, base_url, "Megadeth - Hangar 18.gp", "continuous")
                    else:
                        load_file(page, base_url, GP_FILE, "continuous")
                    page.evaluate("""() => {
                        const cp = document.getElementById('controllerPill'); if (cp) cp.style.display = 'none';
                        const ap = document.getElementById('globalAudioControls'); if (ap) ap.style.display = 'inline-flex';
                        const sp = document.getElementById('audioSourcePill'); if (sp) sp.style.display = 'inline-flex';
                        const sb = document.getElementById('synthToggleBtn'); if (sb) sb.style.display = 'inline-block';
                        const yb = document.getElementById('ytToggleBtn'); if (yb) yb.style.display = 'inline-block';
                    }""")
                    page.wait_for_timeout(500)
                    box = page.locator("#topBar").bounding_box()
                    clip_rect = {
                        "x": box["x"],
                        "y": box["y"],
                        "width": box["width"],
                        "height": box["height"] - 2,
                    }
                    tb_target = OUT_DIR / "topbar_hud.png"
                    page.screenshot(path=str(tb_target), clip=clip_rect)
                    print(f"  wrote {tb_target.relative_to(ROOT)}")
                    
                    tb_2x_target = OUT_DIR / "topbar_hud_2x.png"
                    page.screenshot(path=str(tb_2x_target), clip=clip_rect, scale="device")
                    print(f"  wrote {tb_2x_target.relative_to(ROOT)}")

                # 6. Multi-Track View: Between the Buried and Me - White Walls
                if wanted("multitrack"):
                    if has_backup:
                        load_stored_tab(page, base_url, "8 White Walls.gp", "continuous")
                    else:
                        load_file(page, base_url, GP_FILE, "continuous")
                    save("multitrack")

                # 7. YouTube Player Drawer: Dream Theater - The Mirror with embed loaded
                if wanted("youtube_player"):
                    if has_backup:
                        load_stored_tab(page, base_url, "7 The Mirror.gp", "continuous")
                    else:
                        load_file(page, base_url, GP_FILE, "continuous")
                    page.click("#ytToggleBtn")
                    page.wait_for_timeout(1000)
                    page.evaluate("""() => {
                        const vid = 'SA5q9KL7XGA';
                        const ifr = document.getElementById('ytIframe');
                        if (ifr) {
                            ifr.src = `https://www.youtube.com/embed/${vid}`;
                            ifr.style.display = 'block';
                        }
                        const loadInd = document.getElementById('ytLoadingIndicator');
                        if (loadInd) loadInd.style.setProperty('display', 'none', 'important');
                        const prompt = document.getElementById('ytPlaceholderPrompt');
                        if (prompt) prompt.style.setProperty('display', 'none', 'important');
                        const title = document.getElementById('ytPanelTitle');
                        if (title) title.textContent = 'Dream Theater - The Mirror (Backing Track)';
                        const inp = document.getElementById('ytSearchInput');
                        if (inp) inp.value = `https://www.youtube.com/watch?v=${vid}`;
                        const backingRadio = document.getElementById('ytTrackBacking');
                        if (backingRadio) backingRadio.checked = true;
                    }""")
                    page.wait_for_timeout(4000)
                    save("youtube_player")

                # 8. Game Controller Modal: Haken - 1985
                if wanted("controller_modal"):
                    if has_backup:
                        load_stored_tab(page, base_url, "Haken - 1985.gp5", "continuous")
                    else:
                        load_file(page, base_url, GP_FILE, "continuous")
                    page.evaluate("document.getElementById('controllerHelpModal').style.display = 'flex'")
                    page.wait_for_timeout(1000)
                    save("controller_modal")

                # 9. Tracks & Notation Panel (desktop only)
                if wanted("notation_options") and not is_mobile:
                    if has_backup:
                        load_stored_tab(page, base_url, "Megadeth - Hangar 18.gp", "continuous")
                    else:
                        load_file(page, base_url, GP_FILE, "continuous")
                    page.click("#topBarSongTitleBtn")
                    page.wait_for_timeout(1000)
                    save("notation_options")

                # 10. PDF, page view
                if wanted("pdf_page"):
                    load_file(page, base_url, PDF_FILE, "page")
                    save("pdf_page")

                # 11. PDF condensed
                if wanted("pdf_condensed"):
                    load_file(page, base_url, PDF_FILE, "page", condense=True)
                    save("pdf_condensed")

                # 12. Settings drawer
                if wanted("menu"):
                    load_file(page, base_url, GP_FILE, "continuous")
                    page.evaluate("document.querySelector('#menuToggleBtn').click()")
                    page.wait_for_timeout(1000)
                    save("menu")

                # 13. Theme selector modal
                if wanted("theme_palettes"):
                    load_file(page, base_url, GP_FILE, "continuous")
                    page.evaluate("import('/app/themeEngine.js').then(m => m.openThemeModal())")
                    page.wait_for_timeout(1000)
                    save("theme_palettes")

                # 14. GP Themed
                if wanted("gp_themed"):
                    load_file(page, base_url, GP_FILE, "continuous")
                    page.evaluate("import('/app/themeEngine.js').then(m => { m.setTheme('Ember Glow'); m.setSheetMode('theme'); })")
                    page.wait_for_timeout(1500)
                    save("gp_themed")

                context.close()
            browser.close()
    finally:
        httpd.shutdown()


if __name__ == "__main__":
    main()
