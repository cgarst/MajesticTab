#!/usr/bin/env python3
"""Capture the website's pictures from the real app (docs/img/app/*.webp and the hero loop).

A wrapper around support/tools/landing/capture.mjs: it serves the repo root with CORS headers, starts a throwaway Edge/Chrome
with remote debugging on the app, runs capture.mjs against it, then stops both. Only the repo's own fixture
(`Duo No 2 In G Major.gp5`) is ever shown.

Needs: Node 22+, ffmpeg (hero loop only, skip with --no-video), and Microsoft Edge, Chrome or Chromium.

Usage:
    python3 support/tools/webpage_screenshots.py                       # every picture and the hero loop
    python3 support/tools/webpage_screenshots.py --only reader,practice
    python3 support/tools/webpage_screenshots.py --no-video            # stills only
    python3 support/tools/webpage_screenshots.py --headless            # no visible browser window
    python3 support/tools/webpage_screenshots.py --browser /path/to/chrome
"""
import argparse
import functools
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
CAPTURE = ROOT / "support" / "tools" / "landing" / "capture.mjs"
FIXTURE = "Duo No 2 In G Major.gp5"
BROWSERS = [
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "microsoft-edge", "microsoft-edge-stable", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
]


class _Server(http.server.ThreadingHTTPServer):
    request_queue_size = 256  # default backlog of 5 resets connections during the app's module-load burst


class _Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def find_browser(explicit):
    if explicit:
        found = shutil.which(explicit) or (explicit if Path(explicit).exists() else None)
        if not found:
            sys.exit(f"Browser not found: {explicit}")
        return found
    for cand in BROWSERS:
        found = shutil.which(cand) or (cand if Path(cand).exists() else None)
        if found:
            return found
    sys.exit("No Edge, Chrome or Chromium found; pass --browser /path/to/browser")


def wait_for_debugger(port, proc, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            sys.exit(f"The browser exited early (code {proc.returncode}). If a normal one is already running, quit it first.")
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=2) as r:
                if any(t.get("type") == "page" for t in json.load(r)):
                    return
        except OSError:
            pass
        time.sleep(0.3)
    sys.exit(f"The browser did not open its debugging port {port} in {timeout}s")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", help="Comma-separated picture ids, as capture.mjs --only (for example reader,practice,snow,hero)")
    ap.add_argument("--no-video", action="store_true", help="Skip the hero loop (no ffmpeg needed)")
    ap.add_argument("--headless", action="store_true", help="Run the browser without a window")
    ap.add_argument("--browser", help="Path or name of an Edge, Chrome or Chromium binary")
    args = ap.parse_args()

    node = shutil.which("node")
    if not node:
        sys.exit("Node 22+ is required (node not found)")
    if not args.no_video and (not args.only or "hero" in args.only.split(",")) and not shutil.which("ffmpeg"):
        sys.exit("ffmpeg is required for the hero loop; install it or pass --no-video")
    browser = find_browser(args.browser)

    web_port = free_port()
    debug_port = free_port()
    base = f"http://localhost:{web_port}"
    httpd = _Server(("127.0.0.1", web_port), functools.partial(_Handler, directory=str(ROOT)))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    profile = tempfile.mkdtemp(prefix="majestictab-landing-")
    url = f"{base}/src/?test={urllib.parse.quote(FIXTURE)}"
    cmd = [browser, f"--remote-debugging-port={debug_port}", f"--user-data-dir={profile}",
           "--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required"]
    if args.headless:
        cmd.append("--headless=new")
    cmd.append(url)
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_for_debugger(debug_port, proc)
        node_cmd = [node, str(CAPTURE), "--port", str(debug_port), "--base", base]
        if args.only:
            node_cmd += ["--only", args.only]
        if args.no_video:
            node_cmd.append("--no-video")
        rc = subprocess.run(node_cmd, cwd=ROOT).returncode
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        httpd.shutdown()
        shutil.rmtree(profile, ignore_errors=True)
    sys.exit(rc)


if __name__ == "__main__":
    main()
