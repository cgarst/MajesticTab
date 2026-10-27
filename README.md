# MajesticTab

MajesticTab is a guitar tab viewer designed for practice, learning, and focused reading on desktop, mobile, and tablet screens. It lets you open Guitar Pro files directly, load tab PDFs, or view text tabs in clean page or continuous scroll modes with minimal distractions.

 - [MajesticTab website](https://majestictab.zathu.net/)
 - [Report an issue](https://github.com/cgarst/MajesticTab-Support/issues)

This is the private development repository. The public website, privacy policy, and issue tracker live in [MajesticTab-Support](https://github.com/cgarst/MajesticTab-Support).

---

## Getting started

### Prerequisites

- Native apps for iOS, iPadOS, macOS, Windows, Android, and Linux
- The app can also be served locally in a modern browser for development

### Run locally

From the repo root, start a local static server:

```bash
cd MajesticTab
python3 -m http.server 8000
```

Then open `http://localhost:8000/app/`.

---

## Usage

1. Open the app.
2. Load a local Guitar Pro or PDF tab, or pick a file from Google Drive.
3. Choose your preferred reading mode:
   - Page mode for traditional page-by-page reading
   - Continuous mode for vertical scrolling
4. Navigate with mouse, touch, keyboard, or a page-turner pedal.
5. For Guitar Pro files, use the SoundFont player or YouTube audio panel to play along while you read.
6. Adjust theme, sheet size, and playback controls in the settings menu for your preferred practice workflow.
7. For PDF tabs, enable the condensed/optimized view and export a cleaned PDF when needed.

---

## Keyboard shortcuts

Shortcuts apply while a tab is open and no text field has focus.

| Key | Action |
| --- | --- |
| `→`, `↓`, `Page Down` | Next page (or scroll down in continuous mode) |
| `←`, `↑`, `Page Up` | Previous page (or scroll up in continuous mode) |
| `Space` | Play or pause the SoundFont or YouTube audio (turns the page when no audio is loaded) |
| `B` | Rewind audio by 10 seconds |
| `G` | Toggle the SoundFont between full band and no guitars (no bass in bass mode) |
| `M` | Toggle the metronome (SoundFont) |
| `C` | Toggle the count-in (SoundFont) |
| `,`, `.` | Slow down or speed up playback by 5% (SoundFont) |
| `F` | Show or hide the fretboard (Guitar Pro files) |
| `R` | Show or hide the reference library |
| `T` | Show or hide the tuner |
| `Z` | Toggle zen mode (hide the top bar) |
| `` ` ``, `~` | Open or close the settings menu |
| `[`, `]` | Previous or next tab in the open setlist |
| `Alt+Enter` | Toggle fullscreen (Windows and Linux) |
| `Esc` | Close the open panel, modal, or dialog |
| `Cmd+[`, `Alt+←`, `Cmd+←` | Back (mouse button 4 also works) |
| `Cmd+]`, `Alt+→`, `Cmd+→` | Forward (mouse button 5 also works) |

---

## PDF workflow

MajesticTab works best with multi-track, tab-only PDFs exported from Guitar Pro. This is the format the optimizer is designed to process most effectively.

To create a good source PDF in Guitar Pro:

1. Open the tab in Guitar Pro.
2. Switch to multitrack view.
3. Enable tablature and disable standard notation for the relevant tracks.
4. Hide non-guitar tracks if needed.
5. Export the score as a PDF.

The app then removes empty staves, cleans margins, and re-renders the tab into a more readable layout.

---

## Development

### File structure

- `app/main.js` — main UI and navigation flow
- `app/gpProcessor/` — Guitar Pro parsing and rendering
- `app/pdfProcessor/` — PDF parsing, cleanup, and optimization logic
- `app/exportPdf.js` — PDF export flow
- `tools/` — screenshot generation and helper tooling

### Dependencies

The app is browser-based and loads external libraries from a CDN, so there is no app build step required for normal use.

### Desktop and Android builds

The Tauri v2 build configuration and launcher live under `build/`. Install Node.js, Rust, and the platform prerequisites listed in the [Tauri guide](https://v2.tauri.app/start/prerequisites/), then run one target from the repository root:

```bash
node build/build-tauri.mjs macos
node build/build-tauri.mjs windows
node build/build-tauri.mjs linux
node build/build-tauri.mjs android
node build/build-tauri.mjs ios
```

Desktop builds disable the JavaScript inspector and webview devtools by default for performance and security. Pass `--debug-tools` (or `--debug`) to a macOS, Windows, or Linux build command, or use `./build/build-macos.sh --debug`, to enable devtools in both the main window and embedded child webviews (e.g. the native tab downloader browser):

```bash
node build/build-tauri.mjs macos --debug-tools
# or for macOS build & auto-install:
./build/build-macos.sh --debug
```

For live local development with devtools enabled, run:

```bash
cd build/tauri
npm run tauri:dev -- --features debug-tools
```

This compiles the Rust backend with the `debug-tools` feature (`tauri/devtools`), permitting web inspector inspection and devtools console logging.

Build macOS and Windows installers on their respective operating systems. The Linux target builds a Flatpak and requires `flatpak` and `flatpak-builder`. Android requires Android Studio's SDK Platform, Platform-Tools, Command-line Tools, NDK (Side by side), JDK 17-26 (JDK 17 recommended), and `ANDROID_HOME`, `NDK_HOME`, and `JAVA_HOME` configured per the Tauri guide. The build script checks the selected JDK before running Gradle. Android produces a debug APK for testing; release distribution needs signing. All generated bundles and Cargo output go under the git-ignored `dist/` directory. Desktop builds are unsigned unless signing credentials are configured.

To enable Google Drive in a Tauri build, set the `GOOGLE_CLIENT_SECRET` environment variable (e.g., in a git-ignored `.env` file in the project root, via `export GOOGLE_CLIENT_SECRET="your-client-secret"`) before building, or configure it as a GitHub Actions secret. The build process automatically embeds the secret into the generated frontend bundle. Note that the secret is embedded in the packaged client app and can be extracted from it; do not treat it as confidential.

The Google Drive picker also needs `GOOGLE_PICKER_API_KEY` (a Google Cloud browser API key), set the same way in `.env` or as a GitHub Actions secret. The build writes it to the git-ignored `app/pickerKey.local.js`; without it, the app falls back to the key in `app/googleDrive.js`.

### Building for iOS

To build the iOS IPA locally from macOS:

```bash
rustup target add aarch64-apple-ios
node build/build-tauri.mjs ios
```

The output will be saved to `dist/MajesticTab-ios.ipa`.

---

## Extensions

Extensions let you teach MajesticTab to open files it doesn't read on its own. An extension is a single `.js` file that converts a file you open (`.gp`, `.gp3`, `.gp4`, `.gp5`, `.gpx`, `.pdf` or `.txt`) into contents MajesticTab can read. Add one from the menu: **Extensions**, then **Add .js File**.

### Safety

Extensions run in an isolated sandbox. They have no network access and can't read your library, settings, accounts or backups. They only see the file you are opening, and the only thing they can do is hand back a converted file. MajesticTab ships with none, and you should still only add files you trust or wrote yourself.

### Writing an extension

Call `registerFileAdapter` with an `id`, a `matches(file)` function and a `transform(file)` function. Both can be `async`.

- `file` is a standard `File` (use `file.name`, `file.arrayBuffer()`, `file.text()`).
- `matches` returns `true` when the extension wants to handle the file.
- `transform` returns a `File` or `Blob` with the converted contents, or `null` to leave the file as it is.
- Several extensions can be loaded together and run in order, each receiving the previous result.
- [fflate](https://github.com/101arrowz/fflate) is available as `fflate` for zip and gzip work.

```js
// Opens text tabs saved in an older encoding (Windows-1252) with accents intact.
registerFileAdapter({
  id: 'windows-1252-to-utf8',
  async matches(file) {
    if (!file.name.toLowerCase().endsWith('.txt')) return false;
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      return false; // already valid UTF-8
    } catch {
      return true;
    }
  },
  async transform(file) {
    const text = new TextDecoder('windows-1252').decode(await file.arrayBuffer());
    return new File([text], file.name, { type: 'text/plain' });
  }
});
```

### Ideas for extensions

- Convert text tabs saved in other encodings, like the example above.
- Tidy your own text tabs: strip stray HTML tags, normalize line endings, or replace tabs with spaces so the columns line up.
- Turn a simple format you export from your own tools (a JSON or CSV list of chords and lyrics, for example) into a formatted `.txt` chord sheet. Keep the `.txt` name on the file you hand back.
- Clean up the view of a Guitar Pro 7 or newer file: strip lyrics, text annotations or chord diagrams so the sheet shows only the notation.

### Jam mode

Extensions don't travel over Jam. If the host has an extension that converts a file, the host shares the converted file, so everyone in the session can open it without having the extension installed.

## Acknowledgments

- [AlphaTab](https://github.com/CoderLine/alphaTab) for Guitar Pro rendering and playback support
- [PitchCraft](https://github.com/indjoov/pitchcraft) for chromatic tuner and pitch detection implementation
- [PDF.js](https://mozilla.github.io/pdf.js/) for PDF rendering
- [Bootstrap](https://getbootstrap.com/) for UI components
- [jsPDF](https://github.com/parallax/jsPDF) for export functionality

---

## Screenshots

The website screenshots live in the MajesticTab-Support repo. The generator writes straight into `../MajesticTab-Support/img/screenshots/` (clone that repo next to this one, or pass `--out-dir`):

```bash
pip install playwright && playwright install chromium
python3 tools/generate_screenshots.py
python3 tools/generate_screenshots.py --only gp_scroll theme_palettes
```

Shot names include `gp_scroll`, `gp_page`, `pdf_page`, `pdf_condensed`, `menu`, `theme_palettes`, `gp_themed`, `fretboard`, `tuner`, `reference_chords`, and `jam_host`. The last four use the Keystone fixture and need no backup file.
