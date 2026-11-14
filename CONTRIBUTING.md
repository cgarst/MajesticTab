# Contributing to MajesticTab

Thank you for your interest in contributing to MajesticTab. This guide covers how the project is organized, how to run and build it across platforms, and the conventions to follow when submitting changes.

---

## Project structure

- `src/` — Browser and WebView frontend (vanilla ES modules, no bundler required for web use)
  - `src/main.js` — Main UI initialization, file loading, and reader coordination
  - `src/design.css` and `src/style.css` — Visual theme tokens and layout styles
  - `src/gpProcessor/` — Guitar Pro parsing, AlphaTab rendering, SoundFont synth, and bar ruler
  - `src/pdfProcessor/` — PDF parsing, empty-stave cleanup, and page layout
  - `src/textProcessor/` and `src/textSync/` — Plain-text tab formatting and bar sync
  - `src/audioSync/` — Original recording and backing track bar-by-bar synchronization
  - `src/fretboard/` — Interactive virtual fretboard
  - `src/tuner/` and `src/metronome/` — Chromatic microphone tuner and visual metronome
  - `src/jam/` — Local-network multi-device Jam sessions
  - `src/libraryModal.js`, `src/libraryStore.js`, `src/syncEngine.js` — Song library, setlists, backups, and cloud sync (Google Drive, S3, WebDAV, iCloud)
- `build/` — Tauri v2 native wrapper (`build/tauri/`), Flatpak manifest, and cross-platform build scripts
- `docs/` — Public website and privacy policy (`https://majestictab.zathu.net/`)
- `support/` — Store metadata, branding source SVGs, and screenshot/artwork generators
- `tests/` — Test fixtures and Chrome DevTools Protocol (`tests/cdp.py`) test helpers

---

## Running locally

### Browser development

The frontend in `src/` loads its dependencies directly and needs no build step for browser development. From the repository root:

```bash
./run_web.sh
```

Then open `http://localhost:8000/src/` (or pass a custom port, e.g. `./run_web.sh 9000`). `run_web.sh` serves the repository with `Cache-Control: no-store` and CORS headers so edited ES modules reload immediately.

### Native desktop development (Tauri)

Install Node.js, Rust, and the platform prerequisites listed in the [Tauri v2 guide](https://v2.tauri.app/start/prerequisites/), then run from the repository root:

```bash
./run.sh
```

This prepares the vendored local frontend (`build/tauri/frontend-dist/`) and runs `npm run tauri:dev -- --features debug-tools` with web inspector devtools enabled.

To test with your own library data, `./run.sh --restore-backup` automatically imports the newest `.mtbackup` archive from `~/Downloads` when the dev app starts (add `--wipe` to replace existing dev data instead of merging).

---

## Building native packages

The Tauri v2 build launcher lives at `build/build-tauri.mjs`. Run your target platform from the repository root:

```bash
node build/build-tauri.mjs macos
node build/build-tauri.mjs windows
node build/build-tauri.mjs linux
node build/build-tauri.mjs android
node build/build-tauri.mjs ios
```

All generated installers, bundles, and Cargo artifacts are written to the git-ignored `dist/` directory.

### Enabling devtools in packaged builds

Release desktop builds disable the JavaScript inspector and webview devtools by default. Pass `--debug-tools` (or `--debug`) to enable devtools in both the main window and embedded child webviews:

```bash
node build/build-tauri.mjs macos --debug-tools
# or on macOS to build and install to /Applications:
./build/build-macos.sh --debug
```

### Platform requirements

- **macOS and Windows:** Build installers on their respective host operating systems. Desktop builds are unsigned unless signing credentials are configured in `.env`.
- **Linux:** Builds a Flatpak inside the GNOME SDK runtime and requires `flatpak` and `flatpak-builder`. When `Cargo.lock` or `package-lock.json` changes, regenerate the offline Flatpak dependency manifests with `build/tauri/flatpak/update-sources.sh`.
- **Android:** Requires Android Studio SDK Platform, Platform-Tools, Command-line Tools, NDK (Side by side), JDK 17–26 (JDK 17 recommended), and `ANDROID_HOME`, `NDK_HOME`, and `JAVA_HOME` set. Produces `dist/MajesticTab-android-debug.apk` (or signed release outputs when keystore variables are present).
- **iOS:** Requires macOS with Xcode and `xcodegen` (`brew install xcodegen`):
  ```bash
  rustup target add aarch64-apple-ios
  node build/build-tauri.mjs ios
  ```
  Outputs `dist/MajesticTab-ios.ipa`.

### Google Drive credentials

Google Drive works in every build with no setup. The desktop OAuth client (`src/googleDesktopClient.js`) and Picker API key (`src/googleDrive.js`) are public by design for installed applications. To use your own Google Cloud project instead, set `GOOGLE_DESKTOP_CLIENT_ID`, `GOOGLE_DESKTOP_CLIENT_KEY`, and/or `GOOGLE_PICKER_API_KEY` in a git-ignored `.env` file at the repository root before building.

---

## PDF optimizer workflow

MajesticTab's PDF optimizer is designed for multi-track, tab-only PDFs exported from Guitar Pro:

1. Open the score in Guitar Pro and switch to multitrack view.
2. Enable tablature and disable standard notation for the relevant tracks.
3. Hide non-guitar tracks if desired, then export the score as a PDF.

When opened with **Condense PDF** enabled, MajesticTab removes empty staves, trims page margins, and re-lays out the systems into a denser, readable sheet that can also be exported as a new PDF.

---

## Guidelines for contributors

- **Never commit copyrighted tabs:** Do not add, commit, or push Guitar Pro files (`.gp`, `.gp3`, `.gp4`, `.gp5`, `.gpx`), `.mtab` bundles, or tab PDFs anywhere in the repository or pull requests. Use local, untracked files for testing.
- **No third-party tab site names:** Do not name specific tab sites or tab services in UI text, code comments, defaults, documentation, tests, or commit messages. Refer to them generically ("tab sites", "search the web").
- **External URLs in `src/`:** `build/tauri/prepare-tauri-frontend.mjs` checks every `.html`, `.js`, `.css`, and `.mjs` file under `src/` (including comments) against an explicit allowlist so packaged apps only connect to approved hosts. Run `cd build/tauri && npm run prepare:frontend` to verify before opening a pull request.
- **UI copy and styling:** Use sentence case for all headings, buttons, labels, and menu items (`Continuous scroll or book-like pages`, not Title Case). Visual theme rules belong in `src/design.css`.
- **Third-party attribution:** If you port or adapt code or data from another open-source project, check that its license is compatible with MPL-2.0 and credit it in the source file header, the Acknowledgments section of `README.md`, and the `#aboutModal` third-party list in `src/index.html`.
