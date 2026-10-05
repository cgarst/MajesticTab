# MajesticTab — Development Guide

## UI Theme Consistency

- New UI elements must follow the active theme. Reuse the CSS variables and themed component classes in `app/style.css` instead of hard-coded colors or default Bootstrap styling that bypasses the theme.
- Match existing controls' themed active, inactive, hover, and disabled states; extend shared styles when needed rather than styling one element in isolation.
- Verify new UI in at least two themes to ensure colors, contrast, and selected states remain legible and consistent.

## Test Procedures

### Local Dev Server

Start a static HTTP server from the project root before testing:

```bash
python3 -m http.server 8000
```

### URL-Based Test Automation

The app supports a `?test=<filename>` URL parameter that auto-loads a file from the `tests/` directory on startup, bypassing the file picker. Use this to test specific files without manual interaction.

```
http://localhost:8000/?test=Keystone.gp
```

Test files live in `tests/`. Add new test cases there.

### Remote Debugging with Edge DevTools

Launch Edge with remote debugging enabled:

```bash
/Applications/Microsoft\ Edge.app/Contents/MacOS/Microsoft\ Edge \
  --remote-debugging-port=9222 \
  http://localhost:8000/?test=Keystone.gp
```

Verify the target is reachable:

```bash
curl -s http://127.0.0.1:9222/json | python3 -m json.tool
```

The MajesticTab page will appear as a target with `"url": "http://localhost:8000/..."`.

### Collecting Console Logs via DevTools Protocol

Use a Python script to connect to the page's WebSocket debugger URL and collect console output, warnings, and errors:

```python
import asyncio, json, websockets

PAGE_WS = "ws://127.0.0.1:9222/devtools/page/<PAGE_ID>"

async def run():
    async with websockets.connect(PAGE_WS) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
        await ws.send(json.dumps({"id": 2, "method": "Log.enable"}))
        await ws.send(json.dumps({"id": 3, "method": "Page.enable"}))
        await ws.send(json.dumps({"id": 4, "method": "Page.reload", "params": {"ignoreCache": True}}))

        try:
            async with asyncio.timeout(12):
                while True:
                    msg = await ws.recv()
                    data = json.loads(msg)
                    method = data.get('method', '')
                    if method == 'Runtime.consoleAPICalled':
                        t = data['params']['type']
                        text = ' '.join(a.get('value', str(a.get('description',''))) for a in data['params']['args'])
                        print(f"[{t}] {text}")
                    elif method == 'Log.entryAdded':
                        e = data['params']['entry']
                        print(f"[LOG:{e['level']}] {e['text']}")
                    elif method == 'Runtime.exceptionThrown':
                        exc = data['params']['exceptionDetails']
                        print(f"[EXCEPTION] {exc.get('text','')} {exc.get('exception',{}).get('description','')}")
        except asyncio.TimeoutError:
            pass

asyncio.run(run())
```

Replace `<PAGE_ID>` with the `id` from the `/json` endpoint. Requires `pip3 install websockets`.

### Capturing Screenshots via DevTools Protocol

Use `Page.captureScreenshot` to grab a PNG of the current page state for visual inspection. Useful for verifying rendering changes without switching to a browser window.

```python
import asyncio, json, base64, websockets

PAGE_WS = "ws://127.0.0.1:9222/devtools/page/<PAGE_ID>"

async def screenshot(path="/tmp/screenshot.png"):
    async with websockets.connect(PAGE_WS) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Page.enable"}))
        await ws.recv()
        await ws.send(json.dumps({
            "id": 2,
            "method": "Page.captureScreenshot",
            "params": {"format": "png", "captureBeyondViewport": False}
        }))
        while True:
            msg = await ws.recv()
            data = json.loads(msg)
            if data.get("id") == 2:
                with open(path, "wb") as f:
                    f.write(base64.b64decode(data["result"]["data"]))
                print(f"Saved to {path}")
                break

asyncio.run(screenshot())
```

To reload first, then screenshot after rendering completes, wait for the `[GP Mode Switch] Page mode rendered` console log before capturing (see log collection script above).

Note: screenshots are captured at the device pixel ratio of the display (2× on Retina). A 1702×988 logical viewport produces a 3404×1976px PNG.

### Known Noise to Ignore

- `Unchecked runtime.lastError: The message port closed...` — browser extension issue, not app code
- `Tracking Prevention blocked access to storage for cdn.jsdelivr.net / cdnjs.cloudflare.com` — Edge privacy feature blocking CDN cookie/localStorage access, harmless
- `[AlphaTab][Rendering] AlphaTab container was invisible while autosizing` — warning only; AlphaTab recovers on its own
