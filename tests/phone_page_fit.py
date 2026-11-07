#!/usr/bin/env python3
"""Phone reader check: page fit in Normal and Reading mode, and that nothing but the Reading mode toggle moves a bar.

Needs the dev server on :8000 and Edge with --remote-debugging-port=9333 (see AGENTS.md), and `pip3 install websockets`.
Emulates a 390x844 phone with a 47px top and 34px bottom safe area, then for each fixture checks that
  - normally the page sits between the top (title row) and the bottom strip,
  - a tap anywhere on the left or right half turns the page, including the old top and bottom bands, and moves no bar,
  - the bars stay put for 6 seconds of idle (no auto-hide),
  - Reading mode (the toggle in the strip) hides the top, keeps the strip, grows the page and keeps it inside the safe area,
    and the R key does the same while Z does nothing,
  - leaving Reading mode puts the page back.
Usage: python3 tests/phone_page_fit.py [fixture ...]   (default: long-text.txt, the Duo PDF and the Duo GP5)
"""
import asyncio, json, sys, urllib.request, urllib.parse, websockets

SAFE_T, SAFE_B, W, H = 47, 34, 390, 844
FIXTURES = ["long-text.txt", "Duo No 2 In G Major.pdf", "Duo No 2 In G Major.gp5"]
STATE = """(()=>{const w=document.querySelector('.pageWrapper,.gp-page-wrapper'),b=w&&w.getBoundingClientRect(),
 t=document.getElementById('topBar').getBoundingClientRect(),d=document.getElementById('mobilePlaybackDock').getBoundingClientRect();
 return {reading:document.body.classList.contains('reading-mode'),away:document.body.classList.contains('top-away'),
 topBottom:Math.round(t.bottom),dockTop:Math.round(d.top),ind:(document.getElementById('pageIndicator')||{}).textContent,
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

        await ev("localStorage.removeItem('majestictab.readingMode')")
        if (await ev(STATE))["reading"]:  # restored from an earlier run
            await ev("document.getElementById('readingDockBtn').click()")
            await asyncio.sleep(1.5)
        normal = await ev(STATE)
        if normal["reading"] or normal["away"]: problems.append("started with the bars away")
        if normal["topBottom"] <= SAFE_T + 30: problems.append(f"top is only {normal['topBottom']}px tall: expected the title row")
        top, bottom = normal["page"]
        if top < normal["topBottom"] - 1 or bottom > normal["dockTop"] + 1:
            problems.append(f"page {top}-{bottom} is not between the top ({normal['topBottom']}) and the strip ({normal['dockTop']})")
        await asyncio.sleep(6)  # no idle hide
        idle = await ev(STATE)
        if idle["reading"] or idle["away"] or idle["page"] != normal["page"]: problems.append("the bars or the page moved while idle")
        before = (idle["ind"], idle["first"])
        await tap(W - 40, 420)
        s = await ev(STATE)
        if (s["ind"], s["first"]) == before: problems.append("right tap did not turn the page")
        if s["page"] != normal["page"]: problems.append("a tap moved the page area")
        await tap(40, 420)
        s = await ev(STATE)
        if (s["ind"], s["first"]) != before: problems.append("left tap did not turn back")
        for y, name in ((SAFE_T + 8, "top"), (H - SAFE_B - 8, "bottom")):
            if y > normal["topBottom"] and y < normal["dockTop"]:
                await tap(W - 40, y)
                s = await ev(STATE)
                if (s["ind"], s["first"]) == before: problems.append(f"right tap in the {name} band did not turn the page")
                if s["reading"] or s["away"]: problems.append(f"a tap in the {name} band moved a bar")
                await tap(40, y)
        await ev("document.getElementById('readingDockBtn').click()")
        await asyncio.sleep(1.5)
        r = await ev(STATE)
        if not r["reading"]: problems.append("the Reading mode toggle did not turn it on")
        if r["topBottom"] > 0: problems.append("the top did not leave in Reading mode")
        top, bottom = r["page"]
        if top < SAFE_T or bottom > r["dockTop"] + 1: problems.append(f"Reading page {top}-{bottom} outside the safe area {SAFE_T}-{r['dockTop']}")
        if r["page"][1] - r["page"][0] <= normal["page"][1] - normal["page"][0] and fixture.endswith(".gp5"):
            problems.append("page did not grow in Reading mode")
        await asyncio.sleep(6)
        if (await ev(STATE))["topBottom"] > 0: problems.append("the top came back by itself in Reading mode")
        await tap(W // 2, 20)
        if (await ev(STATE))["topBottom"] > 0: problems.append("a tap at the screen's top brought the top back")
        await ev("document.getElementById('readingDockBtn').click()")
        await asyncio.sleep(1.5)
        if (await ev(STATE))["page"] != normal["page"]: problems.append("leaving Reading mode did not restore the page")
        await ev("document.dispatchEvent(new KeyboardEvent('keydown',{key:'z',bubbles:true}))")
        if (await ev(STATE))["reading"]: problems.append("Z still toggles a mode")
        await ev("document.dispatchEvent(new KeyboardEvent('keydown',{key:'r',bubbles:true}))")
        await asyncio.sleep(1)
        if not (await ev(STATE))["reading"]: problems.append("R did not toggle Reading mode")
        await ev("document.dispatchEvent(new KeyboardEvent('keydown',{key:'r',bubbles:true}))")
        await ev("localStorage.removeItem('majestictab.readingMode')")
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
