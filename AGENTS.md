# MajesticTab — Development Guide

## UI Theme Consistency

- **Never Use Bootstrap Default Button Classes:** Do NOT use Bootstrap's color button classes (`btn-primary`, `btn-outline-primary`, `btn-secondary`, `btn-outline-secondary`, `btn-danger`, `btn-outline-danger`, `btn-success`, `btn-outline-success`, `btn-info`, `btn-outline-info`, `btn-warning`, `btn-outline-warning`, `btn-light`, `btn-outline-light`, `btn-dark`, `btn-outline-dark`). These apply hard-coded Bootstrap colors (e.g., `#0d6efd` blue) that ignore and break MajesticTab's dynamic finish themes (`data-theme`).
- **Use MajesticTab Themed Button Classes:** Always use the standard themed button classes defined in `src/style.css`:
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
- **Explicit CSS Padding for Cards & Rows:** Always define proper explicit padding in `src/style.css` for reusable card and row containers (e.g. `.library-song-row`, `.library-track-row`, `.library-card`, `.library-album-banner`) rather than relying solely on inline utility classes.
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

## Support and Marketing Assets (`support/`)

All website, store listing, and branding material lives under `support/`:

- `support/site/`: the public website (`index.html`, `privacy.html`, `landing.css`, `CNAME`, `img/`, `icons/`), the deploy root for `majestictab.zathu.net`.
- `support/store/`: Microsoft Store and Google Play listing assets (`description.txt`, `msstore/`, `play/`).
- `support/branding/`: source icon SVGs and `generate_icons.py`, which writes the web PNG/ICO icons to both `src/icons/` and `support/site/icons/`.
- `support/tools/`: generators (`generate_screenshots.py`, `store_screenshots.py`, `store_logos.py`, `generate-steam-artwork.mjs`, `generate-msstore-artwork.mjs`) and `landing/build.sh` (rebuilds `support/site/landing.css` after changing classes in `index.html`).

Runtime app icons are in `src/icons/` (referenced as `icons/...` from `src/`).

## Repository Content Rules

- **Never commit tabs to the repo:** Agents must not add, commit, or push Guitar Pro files (`.gp`, `.gp3`, `.gp4`, `.gp5`, `.gpx`) or tab PDFs anywhere in the repository. These are copyrighted. The only exception is the `Duo No 2 In G Major.gp5` fixture in `tests/`. Use local, untracked copies for ad-hoc testing and keep them out of commits.

## Test Procedures

### Local Dev Server and Debug Edge

Serve from the project root, then open the app with a fixture via `?test=<filename>` (auto-loads from `tests/`, bypassing the file picker):

```bash
python3 -m http.server 8000
/Applications/Microsoft\ Edge.app/Contents/MacOS/Microsoft\ Edge \
  --remote-debugging-port=9333 --user-data-dir=/tmp/edge-debug \
  "http://localhost:8000/src/?test=Duo%20No%202%20In%20G%20Major.gp5" >/dev/null 2>&1 &
```

Ports 9222/9223 are often held by `adb` forwards (`lsof -i :<port>`), and if a normal Edge is already running the flags are ignored, so quit it first. Stop with `pkill -f /tmp/edge-debug`.

Fixtures: `Duo No 2 In G Major.gp5`, `Haken - 1985.gp5` and `nightterror.gp5` (large GP5), `octavarium.gp3` (GP3). Add new cases to `tests/`.

### Debugging Workflow

- **Reproduce first:** script the user's literal steps (e.g. scroll, then click, then read cursor/tick state) and confirm it fails before editing. Re-run after the fix. No speculative fixes.
- **Use `tests/cdp.py`, not one-off websocket scripts.** Batch several probes into one `eval`. Set `CDP_PORT` if not 9333.
  ```bash
  python3 tests/cdp.py reload
  python3 tests/cdp.py logs                # reload and print console output/exceptions
  python3 tests/cdp.py eval "(() => ({ tick: window.gpState.canvases[0].api.tickPosition }))()"
  python3 tests/cdp.py screenshot /tmp/shot.png
  ```
  Wait for the `[GP Mode Switch] Page mode rendered` log before screenshotting. Screenshots are at device pixel ratio (2x on Retina).
- **Do not grep `build/`** (Rust/Android binaries and large artifacts); restrict searches to `src/`.
- **Stop after two failed approaches:** re-read the code path and compare its assumptions against the library's actual behavior instead of probing minified code.
- **Ignore known noise:** `Unchecked runtime.lastError`, `Tracking Prevention blocked access to storage for cdn.*`, and `AlphaTab container was invisible while autosizing`.

### AlphaTab Internals (GP playback and cursor)

- `api.tickPosition` is on the **MIDI timeline, which expands repeats**. `masterBar.start + beat.playbackStart` is the **notation timeline** and is wrong after any repeat. Always convert with `getPlaybackTickForBeat(beat, api)` in `src/gpProcessor/gpPlayer.js` (wraps the MidiTickLookup's `getBeatStart`).
- Setting `api.tickPosition` makes AlphaTab re-place its own cursor (calling our `customCursorHandler.placeBeatCursor`). If the tick is wrong, AlphaTab overwrites any manual cursor placement; fix the tick rather than the cursor.
- `renderer.boundsLookup.staffSystems[].findBarAtPos(x)` returns a master-bar bounds object. Its per-track bars are in `.bars` (each with `.beats`), not `.beats`. `masterBar.findBeatAtPos(x)` returns a model beat.
- `boundsLookup.getBeatAtPos(x, y)` returns null in gaps, margins and headers; fall back to the nearest system, then the vertically closest track bar, then the nearest beat by x.
- `boundsLookup.findBeat(beat)` only resolves beats for tracks currently rendered.
- The `.at-cursors` layer and `.gp-reader-cursor` are hidden by CSS until `body.synth-playback-started` is set.
- Public AlphaTab fields are minified (`Qw`, `vy`, `Ny`); avoid depending on them, and if unavoidable, route through a single helper such as `getMidiTickLookup()`.

### Local Store Builds

Release signing secrets live in the gitignored `.env` at the repo root (`ANDROID_KEYSTORE_FILE`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, etc.). `build/build-tauri.mjs` loads it automatically, but only for variables not already set in the environment. Do not export, override, or generate substitute keystores. Just run, e.g., the Play build:

```bash
node build/build-tauri.mjs android --channel=play > /tmp/play-build.log 2>&1
```

Outputs land in `dist/` (`MajesticTab-android.aab`, `.apk`, `-symbols.zip`). Never print `.env` values.

When bumping `version` in `build/tauri/src-tauri/tauri.conf.json`, also set `bundle.android.versionCode` in `tauri.android.conf.json` to `major * 1000000 + minor * 1000 + patch` (1.0.5 is 1000005). F-Droid reads it with a regex and cannot run that formula; Android builds fail if the two disagree. The `fdroid` channel builds one unsigned universal release APK (arm64-v8a, armeabi-v7a and x86_64) into `dist/MajesticTab-android-unsigned.apk`.

### Area-specific guides

- Jam mode (`src/jam/`, host/client sync): see `src/jam/AGENTS.md`.
- Native Tauri shell and iOS simulator: see `build/tauri/AGENTS.md`.
