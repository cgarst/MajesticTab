# MajesticTab — Development Guide

## UI Theme Consistency

- **Never Use Bootstrap Default Button Classes:** Do NOT use Bootstrap's color button classes (`btn-primary`, `btn-outline-primary`, `btn-secondary`, `btn-outline-secondary`, `btn-danger`, `btn-outline-danger`, `btn-success`, `btn-outline-success`, `btn-info`, `btn-outline-info`, `btn-warning`, `btn-outline-warning`, `btn-light`, `btn-outline-light`, `btn-dark`, `btn-outline-dark`). These apply hard-coded Bootstrap colors (e.g., `#0d6efd` blue) that ignore and break MajesticTab's dynamic finish themes (`data-theme`).
- **Use MajesticTab Themed Button Classes:** Always use the standard themed button classes defined in `app/style.css`:
  - `btn-theme-primary`: Primary call-to-action buttons. Applies `--accent-gradient`, `--accent-glow`, white text, and themed hover elevation.
  - `btn-theme-outline`: Secondary / neutral action buttons. Applies `--bg-card-solid`, `--border-subtle`, and accent-glow on hover.
  - `btn-theme-danger`: Destructive / delete actions. Applies themed red tint, border, and hover contrast.
  - `btn-theme-success`: Affirmative actions. Applies themed green tint and border.
  - `btn-theme-icon`: Compact icon-only toolbar buttons.
  - `theme-control-btn`: Standard offcanvas settings / toolbar control buttons.
- **Modal & Dialog Consistency:** Modals must use themed containers (`.theme-modal-backdrop`, `.theme-modal-card`, `.theme-modal-header`, `.theme-modal-body`, `.theme-modal-footer`, `.brand-btn.theme-modal-close-btn`). Modal action buttons must strictly use `btn-theme-primary` for the confirm/submit action and `btn-theme-outline` or `theme-control-btn` for cancel/dismiss.
- **Form Controls & Inputs:** Inputs, dropdowns, and switches must reuse theme styles (`.form-control`, `.form-select` with theme background/borders, `.form-check-input.theme-switch`, `.hud-pill-group`).
- **Multi-Theme Verification:** Match existing controls' themed active, inactive, hover, and disabled states. Verify new UI in at least two finish themes (e.g., Mystic Dream, Blue Pearl, Ember Glow) to ensure colors, contrast, and selected states remain legible and consistent across all themes.

## Test Procedures

### Local Dev Server

Start a static HTTP server from the project root before testing:

```bash
python3 -m http.server 8000
```

### URL-Based Test Automation

The app supports a `?test=<filename>` URL parameter that auto-loads a file from the `tests/` directory on startup, bypassing the file picker. Use this to test specific files without manual interaction.

```
http://localhost:8000/app/?test=Keystone.gp
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

## Native App (Tauri) Troubleshooting

Use this only for native-shell issues (window, titlebar, plugins, Rust commands, YouTube native player, OAuth). For generic web/UI issues, use the browser procedures above.

- Run dev mode from `build/tauri`: `npm run tauri:dev -- --features debug-tools`. The `debug-tools` feature enables devtools and auto-opens them on the `main` window. This prepares the Tauri-only local-asset frontend first.
- CDN assets used by `app/` must remain available to the web implementation, and must also be vendored into the Tauri frontend. When adding or changing a CDN asset, pin its package version in `build/tauri/package.json`, update `build/tauri/prepare-tauri-frontend.mjs` to copy and rewrite it, and run `npm run prepare:frontend` from `build/tauri` to verify no unapproved external URLs remain.
- Native app icons are generated from `icons/icon_v2_mystic.svg` by `build/tauri/generate-icons.mjs` (`npm run generate:icons [-- windows|macos|linux|android|ios]`, defaulting to the host platform), with per-platform margins/backgrounds, into the gitignored `src-tauri/icons/<platform>/`. Adjust sizing in that script, not in generated files.
- Keep `build/tauri/frontend-dist/` generated; do not edit it directly. Distributable builds created through `node build/build-tauri.mjs <target>` prepare it automatically.
- Redirect output to a file and read it, e.g. `... > /tmp/tauri-dev.log 2>&1` (async terminal). Do not pipe through `tail`; it buffers until exit.
- The dev watcher rebuilds and relaunches automatically when files under `build/tauri/src-tauri` change; no manual restart needed. Check `pgrep -fl majestictab` to confirm the process is running.
- Rust-side logs (`eprintln!`) appear in that log; JS console output appears in the devtools console, not the terminal.
- To inspect an installed macOS app build (e.g. `/Applications/MajesticTab.app`), enable WebKit developer extras with `defaults write net.zathu.majestictab WebKitDeveloperExtras -bool true`, then attach via Safari menu: **Develop** -> *<Mac name>* -> **MajesticTab**.
- Before a direct Cargo check, prepare the generated frontend from `build/tauri`: `npm run prepare:frontend`.
- Compile-only check: `cargo check --manifest-path build/tauri/src-tauri/Cargo.toml`.
- macOS-only config lives in `src-tauri/tauri.macos.conf.json` (merged over `tauri.conf.json`). Plugins that don't exist on other platforms must stay in macOS-only deps/capabilities.
