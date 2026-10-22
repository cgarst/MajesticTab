#!/usr/bin/env python3
"""Minimal Chrome DevTools Protocol helper for MajesticTab debugging.

Usage:
  python3 tests/cdp.py eval "<js expression>"   # prints JSON result (awaits promises)
  python3 tests/cdp.py reload [seconds]         # hard reload, then wait (default 3s)
  python3 tests/cdp.py logs [seconds]           # reload, print console/log/exception output (default 12s)
  python3 tests/cdp.py screenshot [path]        # default /tmp/screenshot.png
  python3 tests/cdp.py targets                  # list page targets

Env: CDP_PORT (default 9333). Requires `pip3 install websockets`.
"""
import asyncio, base64, json, os, sys, urllib.request

PORT = os.environ.get("CDP_PORT", "9333")


def page_ws():
    targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json"))
    for t in targets:
        if t.get("type") == "page" and "localhost" in t.get("url", ""):
            return t["webSocketDebuggerUrl"]
    raise SystemExit("No localhost page target found; is the app open?")


async def call(ws, method, params=None, _id=[0]):
    import websockets  # noqa: F401
    _id[0] += 1
    await ws.send(json.dumps({"id": _id[0], "method": method, "params": params or {}}))
    while True:
        msg = json.loads(await ws.recv())
        if msg.get("id") == _id[0]:
            return msg.get("result", {})


async def main():
    import websockets
    cmd = sys.argv[1] if len(sys.argv) > 1 else "targets"
    if cmd == "targets":
        print(json.dumps(json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json")), indent=2))
        return
    async with websockets.connect(page_ws(), max_size=None) as ws:
        if cmd == "eval":
            r = await call(ws, "Runtime.evaluate", {
                "expression": sys.argv[2], "returnByValue": True, "awaitPromise": True})
            res = r.get("result", {})
            print(json.dumps(res.get("value", res), indent=2))
        elif cmd == "reload":
            await call(ws, "Page.enable")
            await call(ws, "Page.reload", {"ignoreCache": True})
            await asyncio.sleep(float(sys.argv[2]) if len(sys.argv) > 2 else 3)
            print("reloaded")
        elif cmd == "logs":
            for m in ("Runtime.enable", "Log.enable", "Page.enable"):
                await call(ws, m)
            await ws.send(json.dumps({"id": 999, "method": "Page.reload", "params": {"ignoreCache": True}}))
            try:
                async with asyncio.timeout(float(sys.argv[2]) if len(sys.argv) > 2 else 12):
                    while True:
                        d = json.loads(await ws.recv())
                        m, p = d.get("method", ""), d.get("params", {})
                        if m == "Runtime.consoleAPICalled":
                            print(f"[{p['type']}]", " ".join(str(a.get("value", a.get("description", ""))) for a in p["args"]))
                        elif m == "Log.entryAdded":
                            print(f"[LOG:{p['entry']['level']}] {p['entry']['text']}")
                        elif m == "Runtime.exceptionThrown":
                            e = p["exceptionDetails"]
                            print("[EXCEPTION]", e.get("text", ""), e.get("exception", {}).get("description", ""))
            except TimeoutError:
                pass
        elif cmd == "screenshot":
            path = sys.argv[2] if len(sys.argv) > 2 else "/tmp/screenshot.png"
            r = await call(ws, "Page.captureScreenshot", {"format": "png"})
            open(path, "wb").write(base64.b64decode(r["data"]))
            print(path)
        else:
            raise SystemExit(__doc__)


asyncio.run(main())
