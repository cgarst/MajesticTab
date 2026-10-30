#!/usr/bin/env python3
"""
Automated Viewport Screenshot Capture Tool for MajesticTab.
Uses Chrome/Edge DevTools Protocol (CDP) to emulate mobile, tablet,
and desktop devices and capture baseline and comparison screenshots.
"""

import asyncio
import base64
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
import websockets

HTTP_PORT = 8000
CDP_PORT = 9333
EDGE_BIN = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "screenshots")

VIEWPORTS = [
    {
        "id": "iphone_se",
        "name": "iPhone SE",
        "width": 375,
        "height": 667,
        "dpr": 2.0,
        "mobile": True
    },
    {
        "id": "iphone_14",
        "name": "iPhone 14/15/16",
        "width": 390,
        "height": 844,
        "dpr": 2.0,
        "mobile": True
    },
    {
        "id": "android_standard",
        "name": "Android Pixel/Galaxy",
        "width": 412,
        "height": 915,
        "dpr": 2.0,
        "mobile": True
    },
    {
        "id": "tablet",
        "name": "iPad / Tablet",
        "width": 768,
        "height": 1024,
        "dpr": 2.0,
        "mobile": True
    },
    {
        "id": "desktop",
        "name": "Desktop Display",
        "width": 1440,
        "height": 900,
        "dpr": 2.0,
        "mobile": False
    }
]

def is_port_in_use(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(('127.0.0.1', port)) == 0

async def send_cdp(ws, msg_id, method, params=None):
    payload = {"id": msg_id, "method": method}
    if params:
        payload["params"] = params
    await ws.send(json.dumps(payload))
    while True:
        resp = await ws.recv()
        data = json.loads(resp)
        if data.get("id") == msg_id:
            return data

async def evaluate_js(ws, msg_id, expression, await_promise=False):
    res = await send_cdp(ws, msg_id, "Runtime.evaluate", {
        "expression": expression,
        "awaitPromise": await_promise,
        "returnByValue": True
    })
    return res.get("result", {}).get("result", {}).get("value")

async def capture_screenshot(ws, msg_id, filepath, clip=None):
    params = {"format": "png", "captureBeyondViewport": False}
    if clip:
        params["clip"] = clip
    res = await send_cdp(ws, msg_id, "Page.captureScreenshot", params)
    img_data = res.get("result", {}).get("data")
    if img_data:
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        with open(filepath, "wb") as f:
            f.write(base64.b64decode(img_data))
        print(f"  -> Captured {filepath} ({len(img_data)} bytes)")

async def capture_state(ws, msg_id, vp, state_name, output_subdir):
    filepath = os.path.join(OUTPUT_DIR, output_subdir, vp["id"], f"{state_name}.png")
    await capture_screenshot(ws, msg_id, filepath)

async def run_capture(output_subdir="baseline"):
    # 1. Start HTTP Server if needed
    http_proc = None
    if not is_port_in_use(HTTP_PORT):
        print(f"Starting python HTTP server on port {HTTP_PORT}...")
        http_proc = subprocess.Popen(
            [sys.executable, "-m", "http.server", str(HTTP_PORT)],
            cwd=os.path.abspath(os.path.join(os.path.dirname(__file__), "..")),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
        time.sleep(1)

    # 2. Start Headless Edge
    user_data_dir = f"/tmp/edge_cdp_profile_{int(time.time())}"
    print(f"Starting headless Edge on port {CDP_PORT}...")
    edge_cmd = [
        EDGE_BIN,
        "--headless=new",
        f"--remote-debugging-port={CDP_PORT}",
        "--disable-gpu",
        "--hide-scrollbars",
        f"--user-data-dir={user_data_dir}",
        "about:blank"
    ]
    edge_proc = subprocess.Popen(edge_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    
    # Wait for DevTools endpoint
    ws_url = None
    for _ in range(25):
        time.sleep(0.4)
        try:
            req = urllib.request.Request(f"http://127.0.0.1:{CDP_PORT}/json/version")
            with urllib.request.urlopen(req) as resp:
                data = json.loads(resp.read().decode())
                ws_url = data.get("webSocketDebuggerUrl")
                if ws_url:
                    break
        except Exception:
            pass

    if not ws_url:
        print("Failed to connect to Edge DevTools protocol.")
        if edge_proc: edge_proc.kill()
        if http_proc: http_proc.kill()
        return

    print(f"Connected to Edge browser WS: {ws_url}")

    try:
        # Create a new page target
        req = urllib.request.Request(f"http://127.0.0.1:{CDP_PORT}/json/new?http://127.0.0.1:{HTTP_PORT}/src/?test=Keystone.gp", method="PUT")
        with urllib.request.urlopen(req) as resp:
            page_info = json.loads(resp.read().decode())
            page_ws = page_info.get("webSocketDebuggerUrl")

        print(f"Opened target page: {page_ws}")

        async with websockets.connect(page_ws, max_size=50 * 1024 * 1024) as ws:
            msg_id = 1
            await send_cdp(ws, msg_id, "Page.enable"); msg_id += 1
            await send_cdp(ws, msg_id, "Runtime.enable"); msg_id += 1
            await send_cdp(ws, msg_id, "DOM.enable"); msg_id += 1
            await send_cdp(ws, msg_id, "CSS.enable"); msg_id += 1

            # Give page time to load and render score
            print("Waiting for score to render...")
            await asyncio.sleep(4.0)

            for vp in VIEWPORTS:
                print(f"\n--- Emulating Viewport: {vp['name']} ({vp['width']}x{vp['height']}) ---")
                
                # Set device metrics override
                await send_cdp(ws, msg_id, "Emulation.setDeviceMetricsOverride", {
                    "width": vp["width"],
                    "height": vp["height"],
                    "deviceScaleFactor": vp["dpr"],
                    "mobile": vp["mobile"]
                }); msg_id += 1
                
                await send_cdp(ws, msg_id, "Emulation.setTouchEmulationEnabled", {
                    "enabled": vp["mobile"]
                }); msg_id += 1

                # Ensure score view is showing and library is closed
                await evaluate_js(ws, msg_id, """
                    (function() {
                        const retBtn = document.getElementById('libraryReturnToSongBtn');
                        if (retBtn && retBtn.style.display !== 'none') {
                            retBtn.click();
                        } else {
                            const libPage = document.getElementById('libraryPage');
                            if (libPage) libPage.style.display = 'none';
                            const mainContent = document.getElementById('mainContent');
                            if (mainContent) mainContent.style.display = '';
                            const songBreadcrumb = document.getElementById('songBreadcrumb');
                            if (songBreadcrumb) songBreadcrumb.style.display = 'inline-flex';
                            const brandText = document.getElementById('brand-text');
                            if (brandText) brandText.style.display = 'none';
                            const modeButtons = document.getElementById('modeButtons');
                            if (modeButtons) modeButtons.style.display = 'flex';
                        }
                        const pageRadio = document.getElementById('pageModeRadio');
                        if (pageRadio && !pageRadio.checked) pageRadio.click();
                    })()
                """); msg_id += 1
                await asyncio.sleep(1.0)

                # State 1: Score View - Page Mode
                await capture_state(ws, msg_id, vp, "01_score_page_mode", output_subdir); msg_id += 1

                # State 2: Score View - Continuous Scroll Mode
                await evaluate_js(ws, msg_id, """
                    (function() {
                        const contRadio = document.getElementById('continuousModeRadio');
                        if (contRadio) contRadio.click();
                    })()
                """); msg_id += 1
                await asyncio.sleep(0.5)
                await capture_state(ws, msg_id, vp, "02_score_continuous_mode", output_subdir); msg_id += 1

                # Switch back to Page mode
                await evaluate_js(ws, msg_id, """
                    (function() {
                        const pageRadio = document.getElementById('pageModeRadio');
                        if (pageRadio) pageRadio.click();
                    })()
                """); msg_id += 1
                await asyncio.sleep(0.3)

                # State 3: Score View - Notation Options Dropdown Open
                await evaluate_js(ws, msg_id, """
                    (function() {
                        const titleBtn = document.getElementById('topBarSongTitleBtn');
                        if (titleBtn) titleBtn.click();
                    })()
                """); msg_id += 1
                await asyncio.sleep(0.5)
                await capture_state(ws, msg_id, vp, "03_score_notation_dropdown", output_subdir); msg_id += 1

                # Close dropdown
                await evaluate_js(ws, msg_id, """
                    (function() {
                        const titleBtn = document.getElementById('topBarSongTitleBtn');
                        if (titleBtn && titleBtn.getAttribute('aria-expanded') === 'true') titleBtn.click();
                    })()
                """); msg_id += 1
                await asyncio.sleep(0.3)

                # State 4: Library View - Main Catalog (with Return to Score Button)
                await evaluate_js(ws, msg_id, """
                    (function() {
                        const backBtn = document.getElementById('topBarBackToLibraryBtn');
                        if (backBtn) backBtn.click();
                        else if (window.openLibraryModal) window.openLibraryModal();
                    })()
                """); msg_id += 1
                await asyncio.sleep(1.2)
                await capture_state(ws, msg_id, vp, "04_library_browse_artists", output_subdir); msg_id += 1

                # State 5: Library View - Tunings Mode
                await evaluate_js(ws, msg_id, """
                    (function() {
                        const tuningsBtn = document.querySelector('#libBrowseModePill button[data-mode="tunings"]');
                        if (tuningsBtn) tuningsBtn.click();
                    })()
                """); msg_id += 1
                await asyncio.sleep(0.8)
                await capture_state(ws, msg_id, vp, "05_library_browse_tunings", output_subdir); msg_id += 1

                # State 6: Library View - Recents View
                await evaluate_js(ws, msg_id, """
                    (function() {
                        const recentsBtn = document.getElementById('libRecentsBtn');
                        if (recentsBtn) recentsBtn.click();
                    })()
                """); msg_id += 1
                await asyncio.sleep(0.8)
                await capture_state(ws, msg_id, vp, "06_library_recents_view", output_subdir); msg_id += 1

                # Switch back to Library tab
                await evaluate_js(ws, msg_id, """
                    (function() {
                        const libBtn = document.getElementById('recentsBackToLibraryBtn');
                        if (libBtn) libBtn.click();
                    })()
                """); msg_id += 1
                await asyncio.sleep(0.5)

            # Theme verification loop (Mystic Dream default, Blue Pearl, Ember Glow)
            print("\n--- Running Multi-Theme Verification on iPhone SE ---")
            await send_cdp(ws, msg_id, "Emulation.setDeviceMetricsOverride", {
                "width": 375,
                "height": 667,
                "deviceScaleFactor": 2.0,
                "mobile": True
            }); msg_id += 1

            for theme in ["Blue Pearl", "Ember Glow"]:
                theme_slug = theme.replace(" ", "_").lower()
                print(f"  -> Testing finish theme: {theme}")
                await evaluate_js(ws, msg_id, f"""
                    document.documentElement.setAttribute('data-theme', '{theme}');
                """); msg_id += 1
                await asyncio.sleep(0.5)

                # Return to score
                await evaluate_js(ws, msg_id, """
                    (function() {
                        const retBtn = document.getElementById('libraryReturnToSongBtn');
                        if (retBtn && retBtn.style.display !== 'none') retBtn.click();
                    })()
                """); msg_id += 1
                await asyncio.sleep(0.6)
                theme_score_path = os.path.join(OUTPUT_DIR, output_subdir, "themes", f"{theme_slug}_score.png")
                await capture_screenshot(ws, msg_id, theme_score_path); msg_id += 1

                # Open Library
                await evaluate_js(ws, msg_id, """
                    (function() {
                        const backBtn = document.getElementById('topBarBackToLibraryBtn');
                        if (backBtn) backBtn.click();
                    })()
                """); msg_id += 1
                await asyncio.sleep(0.8)
                theme_lib_path = os.path.join(OUTPUT_DIR, output_subdir, "themes", f"{theme_slug}_library.png")
                await capture_screenshot(ws, msg_id, theme_lib_path); msg_id += 1

    finally:
        if edge_proc:
            edge_proc.kill()
            edge_proc.wait()
        if http_proc:
            http_proc.kill()
            http_proc.wait()
        shutil.rmtree(user_data_dir, ignore_errors=True)
        print("Capture completed.")

if __name__ == "__main__":
    subdir = sys.argv[1] if len(sys.argv) > 1 else "baseline"
    asyncio.run(run_capture(subdir))
