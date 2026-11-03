#!/usr/bin/env python3
"""Interactive & automated test harness for the Tab Downloader content shim.

Usage:
  # 1. Interactive testing on any live URL (opens visible browser):
  python3 tests/test_downloader_shim.py "https://example.com/search?q=metallica"

  # 2. Automated regression tests against local mock fixtures:
  python3 tests/test_downloader_shim.py --test
"""

import argparse
import base64
import os
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path
from playwright.sync_api import sync_playwright

REPO_ROOT = Path(__file__).resolve().parent.parent

def load_shim_from_app_code() -> str:
    path = REPO_ROOT / "build" / "tauri" / "src-tauri" / "src" / "tab_downloader_native.rs"
    content = path.read_text(encoding="utf-8")
    start_marker = "pub const CORE_DOWNLOADER_SHIM: &str = r#\""
    end_marker = "\"#;"
    start = content.find(start_marker)
    if start == -1:
        raise RuntimeError("Failed to find CORE_DOWNLOADER_SHIM in tab_downloader_native.rs")
    start += len(start_marker)
    end = content.find(end_marker, start)
    if end == -1:
        raise RuntimeError("Failed to find end of CORE_DOWNLOADER_SHIM in tab_downloader_native.rs")
    return content[start:end]

# Load dynamically from application code: build/tauri/src-tauri/src/tab_downloader_native.rs
SHIM_CODE = load_shim_from_app_code()

MOCK_FIXTURE_HTML = """<!DOCTYPE html>
<html>
<head><title>Score View Test</title></head>
<body>
    <div id="pro-player-scroll-container">
        <div class="is_sticky_player">Player Controls</div>
    </div>
    <div class="song-header">
        <h1>Metropolis Part 1</h1>
        <p>Tuning: Standard (E A D G B E)</p>
    </div>
    <div class="download-section">
        <button id="download-gp-btn">Download Guitar Pro</button>
    </div>
</body>
</html>"""

def run_automated_test():
    print("Running automated assertions against mock DOM...")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        context.add_init_script(SHIM_CODE)
        page = context.new_page()

        data_url = 'data:text/html;charset=utf-8,' + urllib.parse.quote(MOCK_FIXTURE_HTML)
        page.goto(data_url)
        page.wait_for_timeout(300)

        # 1. Sticky player and pro-player-scroll-container should be hidden by cosmetic CSS
        player_visible = page.is_visible('.is_sticky_player') or page.is_visible('#pro-player-scroll-container')
        assert not player_visible, "Expected sticky player elements to be hidden"

        # 2. Style rule should be active
        style_active = page.evaluate("() => Boolean(document.getElementById('majestic-adblock-cosmetic'))")
        assert style_active, "Expected cosmetic adblock style rule to be active"

        # 3. Legitimate song content and download button must stay intact
        btn_exists = page.evaluate("() => Boolean(document.getElementById('download-gp-btn'))")
        assert btn_exists, "Expected download button to stay intact"

        browser.close()
    print("All tests passed! Sticky player suppression works cleanly.")

def resolve_target_url(raw: str, use_google: bool = False) -> str:
    raw = (raw or "").strip()
    if not raw:
        return "https://duckduckgo.com/"
    if raw.startswith("http://") or raw.startswith("https://") or raw.startswith("data:") or raw.startswith("file://"):
        return raw
    if "." in raw and " " not in raw and not raw.startswith("?"):
        return "https://" + raw
    if use_google:
        return f"https://www.google.com/search?q={urllib.parse.quote_plus(raw)}"
    return f"https://duckduckgo.com/?q={urllib.parse.quote_plus(raw)}"

def run_interactive(raw_input: str, mobile: bool = False, use_google: bool = False):
    url = resolve_target_url(raw_input, use_google=use_google)
    print(f"\nLaunching Playwright with Tab Downloader Shim...")
    print(f"Target: '{raw_input}' -> {url}")
    print(f"Mode: {'Mobile (390x844)' if mobile else 'Desktop (1280x800)'}")
    print("Mock Native Bridge listening for tab downloads. Press Ctrl+C in terminal to exit.\n")

    with sync_playwright() as p:
        import os
        has_edge = os.path.exists("/Applications/Microsoft Edge.app")
        launch_kwargs = {
            "headless": False,
            "args": ["--disable-blink-features=AutomationControlled"]
        }
        if has_edge:
            launch_kwargs["channel"] = "msedge"
        browser = p.chromium.launch(**launch_kwargs)

        if mobile:
            context = browser.new_context(
                viewport={"width": 390, "height": 844},
                user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
            )
        else:
            context = browser.new_context(
                viewport={"width": 1280, "height": 800},
                user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            )

        context.add_init_script("Object.defineProperty(navigator, 'webdriver', { get: () => undefined });")
        context.add_init_script(SHIM_CODE)

        context.add_init_script("""
            window.MajesticDownloaderNative = {
                onTabDownloaded: function(name, b64) {
                    console.log('>>> [NATIVE INTAKE CAPTURED TAB] Filename: ' + name + ' (Base64 length: ' + b64.length + ')');
                },
                close: function() {
                    console.log('>>> [NATIVE INTAKE] Downloader close requested');
                }
            };
        """)

        page = context.new_page()

        def attach_page(p_obj):
            p_obj.on("console", lambda msg: print(f"[Browser Console] {msg.type}: {msg.text}"))
        context.on("page", attach_page)
        attach_page(page)

        page.goto(url)

        try:
            while not page.is_closed():
                time.sleep(0.5)
        except KeyboardInterrupt:
            print("\nExiting Playwright...")
        finally:
            browser.close()

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="Test Tab Downloader content shim")
    parser.add_argument("query", nargs="*", help="URL or search query to navigate to")
    parser.add_argument("--test", action="store_true", help="Run automated fixture tests")
    parser.add_argument("--mobile", action="store_true", help="Emulate mobile viewport")
    parser.add_argument("--google", action="store_true", help="Use Google instead of DuckDuckGo for search queries")
    args = parser.parse_args()

    if args.test:
        run_automated_test()
    else:
        raw_query = " ".join(args.query).strip() if args.query else ""
        run_interactive(raw_query, mobile=args.mobile, use_google=args.google)
