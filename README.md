# MajesticTab

MajesticTab is a browser-based Guitar Pro and PDF guitar tab viewer designed for practice, learning, and focused reading on desktop and tablet screens. It lets you open Guitar Pro files directly or load tab PDFs, then view them in clean page or continuous scroll modes with minimal distractions.

 - [See more about MajesticTab here](https://cgarst.github.io/MajesticTab/)
 - [Try MajesticTab here](https://cgarst.github.io/MajesticTab/app/)

---

## What MajesticTab does

MajesticTab is built for guitarists who want a clean way to read tablature without the clutter of a full DAW or score editor. It combines:

- Guitar Pro viewing for `.gp`, `.gp3`, `.gp4`, `.gp5`, and `.gpx` files
- PDF tab viewing for multi-track tablature exports and other tab PDFs
- Responsive layout for desktop, tablet, and mobile devices
- Page and continuous reading modes
- Dark mode, finish-inspired themes, and adjustable sheet sizing
- SoundFont playback for Guitar Pro files with speed control, metronome, and count-in
- YouTube audio support for original-song and backing-track practice
- Google Drive import for tabs stored in the cloud
- PDF cleanup tools for condensing and simplifying tab layouts

---

## Current feature set

### Guitar Pro viewer

- Opens Guitar Pro files directly in the browser
- Supports standard Guitar Pro formats: `.gp`, `.gp3`, `.gp4`, `.gp5`, `.gpx`
- Renders notation and tablature using AlphaTab
- Supports page mode and continuous scroll mode
- Adjustable sheet size for legibility and layout control
- Mouse, touch, and keyboard navigation
- SoundFont playback for practicing along with the tab
- Speed controls, timeline scrubbing, metronome, and count-in options
- YouTube integration for original-song or backing-track practice audio
- Compatible with Bluetooth page-turner pedals and keyboard shortcuts

### PDF tab viewer

- Loads PDF guitar tabs and other sheet-style tab documents
- Handles multi-track tab layouts and tab-only exports from Guitar Pro
- Offers page and continuous-view modes
- Cleans up empty staves, trims unnecessary whitespace, and re-groups visible content
- Lets you compare the original PDF with the optimized view
- Exports a condensed PDF for easier printing or reading on the go
- Includes beta PDF condensation and debug overlay tools in the settings menu

### Reading experience and UI

- Dark mode and theme-aware presentation with guitar-finish inspired colorways
- Responsive layout that adapts to screen size and orientation
- One-page or two-page viewing in page mode depending on the layout
- Smooth navigation with previous/next controls, scroll, and keyboard shortcuts
- Local file loading and Google Drive access for tab libraries
- Fullscreen support and top-bar playback controls for focused practice sessions
- Local-first app flow: everything runs in the browser and stays on your device

---

## Getting started

### Prerequisites

- A modern web browser such as Chrome, Edge, Firefox, or Safari

### Run locally

Clone the repo and start a local static server:

```bash
git clone https://github.com/cgarst/MajesticTab.git
cd MajesticTab
python3 -m http.server 8000
```

Then open:

- `http://localhost:8000/` for the landing page
- `http://localhost:8000/app/` for the app

### Run through GitHub Pages

The app is fully client-side and can be hosted through GitHub Pages at:

- https://cgarst.github.io/MajesticTab/app/

---

## Usage

1. Open the app in your browser.
2. Load a local Guitar Pro or PDF tab, or pick a file from Google Drive.
3. Choose your preferred reading mode:
   - Page mode for traditional page-by-page reading
   - Continuous mode for vertical scrolling
4. Navigate with mouse, touch, keyboard, or a page-turner pedal.
5. For Guitar Pro files, use the SoundFont player or YouTube audio panel to play along while you read.
6. Adjust theme, sheet size, and playback controls in the settings menu for your preferred practice workflow.
7. For PDF tabs, enable the condensed/optimized view and export a cleaned PDF when needed.

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
```

Build macOS and Windows installers on their respective operating systems. The Linux target builds a Flatpak and requires `flatpak` and `flatpak-builder`. Android requires Android Studio's SDK Platform, Platform-Tools, Command-line Tools, NDK (Side by side), a supported JDK, and `ANDROID_HOME`, `NDK_HOME`, and `JAVA_HOME` configured per the Tauri guide. Android produces a debug APK for testing; release distribution needs signing. All generated bundles and Cargo output go under the git-ignored `dist/` directory. Desktop builds are unsigned unless signing credentials are configured.

---

## Contributing

Contributions are welcome.

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/awesome-feature`)
3. Commit your changes (`git commit -m 'Add awesome feature'`)
4. Push the branch (`git push origin feature/awesome-feature`)
5. Open a pull request

Please include screenshots or a description of the UI change when relevant.

---

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.

---

## Acknowledgments

- [AlphaTab](https://github.com/CoderLine/alphaTab) for Guitar Pro rendering and playback support
- [PDF.js](https://mozilla.github.io/pdf.js/) for PDF rendering
- [Bootstrap](https://getbootstrap.com/) for UI components
- [jsPDF](https://github.com/parallax/jsPDF) for export functionality

---

## Landing page screenshots

The landing page uses screenshots generated from the demo tab in `tests/Keystone.gp` and `tests/Keystone.pdf`.

To regenerate them:

```bash
pip install playwright && playwright install chromium
python3 tools/generate_screenshots.py
python3 tools/generate_screenshots.py --only gp_scroll theme_palettes
```

Shot names include `gp_scroll`, `gp_page`, `pdf_page`, `pdf_condensed`, `menu`, `theme_palettes`, and `gp_themed`.
