#!/usr/bin/env python3
"""Phone reader check: page fit with the bars hidden, and the tap zones, for text, PDF and Guitar Pro tabs.

Needs the dev server on :8000 and Edge with --remote-debugging-port=9333 (see AGENTS.md), and `pip3 install websockets`.
Emulates a 390x844 phone with a 47px top and 34px bottom safe area, then for each fixture checks that
  - with the bars hidden the page sits inside the safe area and the pages are laid out again for the taller area,
  - a tap on the left or right half of the page turns it and leaves the bars hidden,
  - a tap in the top or bottom band brings the bars back.
Usage: python3 tests/phone_page_fit.py [fixture ...]   (default: long-text.txt, the Duo PDF and the Duo GP5)
"""
import asyncio, json, sys, urllib.request, urllib.parse, websockets

SAFE_T, SAFE_B, W, H = 47, 34, 390, 844
FIXTURES = ["long-text.txt", "Duo No 2 In G Major.pdf", "Duo No 2 In G Major.gp5"]
STATE = """(()=>{const w=document.querySelector('.pageWrapper,.gp-page-wrapper'),b=w&&w.getBoundingClientRect();
 return {hidden:document.body.classList.contains('chrome-hidden'),ind:(document.getElementById('pageIndicator')||{}).textContent,
 first:w?(w.textContent||'').trim().slice(0,24):null,page:b&&[Math.round(b.top),Math.round(b.bottom)]}})()"""


async def run(fixture):
    targets = json.load(urllib.request.urlopen("http://127.0.0.1:9333/json"))
    t = next(x for x in targets if x["type"] == "page" and "localhost" in x["url"])
    problems = []
    async with websockets.connect(t["webSocketDebuggerUrl"], max_size=None) as ws:
        n = [0]

        async def c(method, params=None):
            n[0] += 1
            await ws.send(json.dumps({"id": n[0], "method": method, "params": params or {}}))
            while True:
                r = json.loads(await ws.recv())
                if r.get("id") == n[0]:
                    return r.get("result", {})

        async def ev(js):
            return (await c("Runtime.evaluate", {"expression": js, "returnByValue": True}))["result"].get("value")

        async def tap(x, y):
            await c("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
            await c("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
            await asyncio.sleep(1.5)

        await c("Network.enable"); await c("Network.setCacheDisabled", {"cacheDisabled": True})
        await c("Emulation.setDeviceMetricsOverride", {"width": W, "height": H, "deviceScaleFactor": 2, "mobile": True})
        await c("Emulation.setTouchEmulationEnabled", {"enabled": True})
        await c("Emulation.setSafeAreaInsetsOverride", {"insets": {"top": SAFE_T, "bottom": SAFE_B, "left": 0, "right": 0}})
        await c("Page.navigate", {"url": "http://localhost:8000/src/?test=" + urllib.parse.quote(fixture)})
        await asyncio.sleep(9)
        await ev("(()=>{const p=document.getElementById('pageModeRadio'); if(p&&!p.checked) p.click()})()")
        await asyncio.sleep(2)

        await tap(W // 2, 60)
        shown = await ev(STATE)
        if shown["hidden"]: problems.append("top tap did not show the bars")
        await asyncio.sleep(6)  # idle hide
        hid = await ev(STATE)
        if not hid["hidden"]: problems.append("bars did not auto-hide")
        top, bottom = hid["page"]
        if top < SAFE_T or bottom > H - SAFE_B: problems.append(f"hidden page {top}-{bottom} outside the safe area {SAFE_T}-{H - SAFE_B}")
        if hid["page"][1] - hid["page"][0] <= shown["page"][1] - shown["page"][0]:
            problems.append("page did not grow when the bars hid")
        before = (hid["ind"], hid["first"])
        await tap(W - 40, 420)
        s = await ev(STATE)
        if (s["ind"], s["first"]) == before: problems.append("right tap did not turn the page")
        if not s["hidden"]: problems.append("right tap brought the bars back")
        await tap(40, 420)
        s = await ev(STATE)
        if (s["ind"], s["first"]) != before: problems.append("left tap did not turn back")
        if not s["hidden"]: problems.append("left tap brought the bars back")
        await tap(W // 2, H - 60)
        s = await ev(STATE)
        if s["hidden"]: problems.append("bottom tap did not bring the bars back")
        await c("Emulation.clearDeviceMetricsOverride")
    return problems


async def main():
    bad = 0
    for f in sys.argv[1:] or FIXTURES:
        p = await run(f)
        print(("FAIL " if p else "ok   ") + f + ("" if not p else " :: " + "; ".join(p)))
        bad += bool(p)
    sys.exit(1 if bad else 0)

asyncio.run(main())
