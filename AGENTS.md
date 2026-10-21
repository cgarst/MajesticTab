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

## UI Spacing & Layout Consistency

- **Never Use Non-Existent or Tailwind-Style Spacing Classes:** Bootstrap 5 only supports standard integer spacing utility steps (`0`, `1`, `2`, `3`, `4`, `5`). Do **NOT** use Tailwind-like fractional or decimal spacing classes (such as `px-3.5`, `py-2.5`, `gap-3.5`, `m-1.5`, etc.). Browsers silently ignore unrecognized classes, resetting paddings/gaps to `0` and causing buttons, text, and badges to collide directly against outer borders.
- **Explicit CSS Padding for Cards & Rows:** Always define proper explicit padding in `app/style.css` for reusable card and row containers (e.g. `.library-song-row`, `.library-track-row`, `.library-card`, `.library-album-banner`) rather than relying solely on inline utility classes.
- **Prevent Edge & Sibling Collisions:**
  - **Leading Badges & Numbers:** Always assign fixed dimensions and `flex-shrink: 0` (e.g. `.badge-track-num { min-width: 28px; width: 28px; height: 28px; flex-shrink: 0; }`) with adequate gap (`gap-2.5` or `gap-3`) to song titles.
  - **Trailing Action Buttons & Dropdowns:** Always mark trailing action button groups with `flex-shrink: 0` and provide left separation (e.g. `ms-2`, `gap-2`) so buttons like `+ Tab`, edit, or delete never crash into the right card border or overlap titles.
  - **Sub-Containers & Chip Lists:** Structure sub-sections (e.g. `.tab-options-container`) with full-width alignment, top separation, and subtle divider borders (`pt-2.5 mt-1 border-top border-secondary-subtle d-flex flex-wrap align-items-center gap-2`) rather than arbitrary left padding offsets (`ps-4`) that break grid alignment.
  - **Vertical Text & Pill Rhythm:** Maintain comfortable vertical spacing between song titles and subtitle badge rows (`mt-1.5` / `mt-2` or `gap-2.5`) to prevent text and badges from visually bunching together.
  - **Top Bar Centering (`#centerSection`):** The middle section (`#centerSection` containing the Page/Scroll mode selector and library navigation buttons) must remain perfectly centered horizontally across all screen sizes and viewport widths. `#topBar` uses a symmetric 3-column grid (`grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr)`). Side containers (`#brandSection` and `#rightSection`) must retain `min-width: 0` so that differing content lengths on the left (e.g. song breadcrumbs) vs right (audio pills) do not distort the `1fr` track distributions and push the center controls off-center.

## Typography & Casing Consistency

To ensure high visual polish, scannability, and consistency across marketing pages and product interfaces, follow these casing and punctuation standards:

- **Section Headlines & Titles (Sentence case):** All major section headlines (e.g., `<h1>`, `<h2>`, hero titles, section value propositions) must use **Sentence case**. Capitalize only the first word and proper nouns/branded names (e.g., *MajesticTab*, *YouTube*, *SoundFont*, *Bluetooth*, *Google Drive*, *PDF*).
  - *Correct:* `Continuous scroll or book-like pages`, `YouTube audio and backing tracks`, `Gamepad and Bluetooth page turner support`
  - *Incorrect:* `Continuous Scroll or Book-Like Pages`, `YouTube Audio & Backing Tracks`
- **Eyebrows & Category Kickers (Title Case):** Sub-headings and kickers positioned above section headlines (often styled with `text-xs font-bold uppercase tracking-widest`) must use **Title Case** in raw HTML text (2–4 words max).
  - *Correct:* `Two Ways to Read`, `Multi-Track Focus`, `Practice in Sync`, `Hands-Free Control`, `Visual Finishes`
  - *Incorrect:* `Two ways to read`, `Practice In Sync`
- **Feature Cards & Sub-Headers (Sentence case):** Card headlines (`<h3>`) and item summaries should use **Sentence case** (e.g., `Export to PDF`, `Fills your screen`, `Easy on the eyes`).
- **Ampersands vs. "and":** Write out **"and"** in editorial headlines and body copy (e.g., *"Gamepad and Bluetooth page turner support"*, *"PDF export and condensing"*). Reserve the ampersand (`&`) only for compact badges, pill groups, or tight navigation links where space is strictly constrained.
- **Navigation & CTA Buttons (Title Case):** Navigation links, standalone call-to-action buttons, and modal action triggers should use **Title Case** (e.g., `Download MajesticTab`, `Open App`, `Tab Library`).

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

### Efficient Debugging Workflow

- **Reproduce first:** For interaction bugs, script the user's literal steps (e.g. scroll, then click, then read cursor/tick state) and confirm it fails before editing code. Re-run the same script after the fix. Do not ship speculative fixes.
- **Use the helper, not one-off scripts:** `tests/cdp.py` wraps the DevTools protocol (`eval`, `reload`, `screenshot`, `targets`). Do not write a new websocket script per question; batch several probes into one `eval` call.
  ```bash
  python3 tests/cdp.py reload
  python3 tests/cdp.py eval "(() => ({ tick: window.gpState.canvases[0].api.tickPosition }))()"
  python3 tests/cdp.py screenshot /tmp/shot.png
  ```
  Set `CDP_PORT` if not using 9333.
- **Launch a debug Edge on port 9333:** Ports 9222/9223 are often held by `adb` forwards to an Android WebView (check `lsof -i :<port>`), and Edge silently fails to bind them. If a normal Edge is already running, the flags are ignored, so quit it first.
  ```bash
  /Applications/Microsoft\ Edge.app/Contents/MacOS/Microsoft\ Edge \
    --remote-debugging-port=9333 --user-data-dir=/tmp/edge-debug \
    "http://localhost:8000/app/?test=Keystone.gp" >/dev/null 2>&1 &
  ```
  Stop it with `pkill -f /tmp/edge-debug`.
- **Pick the right fixture:** `Keystone.gp` has repeats and multiple tracks (repeat/tick bugs only show here); `Haken - 1985.gp5` and `nightterror.gp5` are larger GP5 files; `octavarium.gp3` covers GP3.
- **Do not grep `build/`:** it holds Rust/Android binaries and large artifacts. Restrict searches to `app/`.
- **Stop after two failed approaches:** re-read the existing code path and compare its assumptions against the library's actual behavior instead of probing minified code.

### AlphaTab Internals (GP playback and cursor)

- `api.tickPosition` is on the **MIDI timeline, which expands repeats**. `masterBar.start + beat.playbackStart` is the **notation timeline** and is wrong after any repeat. Always convert with `getPlaybackTickForBeat(beat, api)` in `app/gpProcessor/gpPlayer.js` (wraps the MidiTickLookup's `getBeatStart`).
- Setting `api.tickPosition` makes AlphaTab re-place its own cursor (calling our `customCursorHandler.placeBeatCursor`). If the tick is wrong, AlphaTab overwrites any manual cursor placement; fix the tick rather than the cursor.
- `renderer.boundsLookup.staffSystems[].findBarAtPos(x)` returns a master-bar bounds object. Its per-track bars are in `.bars` (each with `.beats`), not `.beats`. `masterBar.findBeatAtPos(x)` returns a model beat.
- `boundsLookup.getBeatAtPos(x, y)` returns null in gaps, margins and headers; fall back to the nearest system, then the vertically closest track bar, then the nearest beat by x.
- `boundsLookup.findBeat(beat)` only resolves beats for tracks currently rendered.
- The `.at-cursors` layer and `.gp-reader-cursor` are hidden by CSS until `body.synth-playback-started` is set.
- Public AlphaTab fields are minified (`Qw`, `vy`, `Ny`); avoid depending on them, and if unavoidable, route through a single helper such as `getMidiTickLookup()`.

### Jam Mode (host / client sync) Testing

- Code lives in `app/jam/` (JS) and `build/tauri/src-tauri/src/jam*.rs` (WebSocket transport; discovery via Bonjour `dns_sd` on Apple platforms, `mdns-sd` elsewhere). It is native-only; the web build hides the Jam pill.
- Positions are speed-independent song ms (`jamPlayerControl.timeMs()` = AlphaTab `timePosition` x `playbackSpeed`). AlphaTab's raw `timePosition` scales with speed; never sync on it directly.
- Debug-tools builds read `MAJESTICTAB_JAM_AUTOSTART=host[:policy]` or `join:<addr>[:port]` to start a session on launch (iOS simulator: `SIMCTL_CHILD_MAJESTICTAB_JAM_AUTOSTART=... xcrun simctl launch ...`).
- Scripted peers measure sync without a second device: `python3 tests/jam/fake_host.py tests/Keystone.gp 47900` logs a client's reported drift; `node tests/jam/probeHost.mjs <host:port> tests/Keystone.gp` drives a host started with `host:anyone` and prints its heartbeats. Steady drift should stay under 20 ms.
- Unit tests: `node --test tests/jam/jamClock.test.mjs`; Bonjour round trip: `cargo test --manifest-path build/tauri/src-tauri/Cargo.toml --lib jam` (macOS).
- Android WebView CDP: `adb forward tcp:9444 localabstract:webview_devtools_remote_$(adb shell pidof net.zathu.majestictab)`, then `CDP_PORT=9444 python3 tests/cdp.py eval ...`. The tablet must be awake and unlocked or the socket hangs.

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

### iOS Simulator Dev, Troubleshooting & Screenshots

- **Boot Simulator & Run App:**
  ```bash
  xcrun simctl boot "iPhone 17"
  # From build/tauri:
  npm run prepare:frontend
  # Build for Apple Silicon simulator (fast, unoptimized debug):
  npx tauri ios build --target aarch64-sim --debug --no-sign
  # Install the built app bundle into the booted simulator:
  xcrun simctl install booted src-tauri/gen/apple/build/majestictab_iOS.xcarchive/Products/Applications/MajesticTab.app
  # Launch installed app:
  xcrun simctl launch booted net.zathu.majestictab
  # Or run interactive dev mode:
  npx tauri ios dev "iPhone 17"
  ```
- **Lifecycle & Process Control:**
  ```bash
  # Terminate running app:
  xcrun simctl terminate booted net.zathu.majestictab
  # Re-launch app:
  xcrun simctl launch booted net.zathu.majestictab
  ```
- **Capture Simulator Screenshots for Visual Context:**
  Capture PNGs directly from the booted simulator to visually inspect rendering and layout changes:
  ```bash
  xcrun simctl io booted screenshot /tmp/ios_screenshot.png
  ```
- **Retrieve Simulator Logs (Console, Warnings & Errors):**
  Stream live app logs or dump recent output directly from the simulator daemon:
  ```bash
  # Stream live app logs:
  xcrun simctl spawn booted log stream --level debug --predicate 'subsystem == "net.zathu.majestictab" || processImagePath contains "MajesticTab"'
  # Show past 5 minutes of app logs:
  xcrun simctl spawn booted log show --predicate 'processImagePath contains "MajesticTab"' --last 5m
  ```
- **Inspect Simulator WebViews via Safari Web Inspector:**
  1. In Safari preferences/settings, ensure **Advanced -> Show features for web developers** (or Develop menu) is enabled.
  2. Open Safari and go to menu **Develop -> iPhone 17 (Simulator) -> MajesticTab** (or the target page title/URL, such as `localhost` or `www.ultimate-guitar.com`).
  3. Once Web Inspector opens, inspect elements, evaluate scripts in the console, view CSS rules, and monitor network requests inside the simulator's WKWebViews.

