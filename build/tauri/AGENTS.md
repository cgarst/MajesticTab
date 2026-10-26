# Native App (Tauri) Troubleshooting

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

## iOS Simulator

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
- **Inspect Simulator WebViews via Safari Web Inspector:**
  1. In Safari preferences/settings, ensure **Advanced -> Show features for web developers** (or Develop menu) is enabled.
  2. Open Safari and go to menu **Develop -> iPhone 17 (Simulator) -> MajesticTab** (or the target page title/URL, such as `localhost` or `www.ultimate-guitar.com`).
  3. Once Web Inspector opens, inspect elements, evaluate scripts in the console, view CSS rules, and monitor network requests inside the simulator's WKWebViews.

## In-app updates

- `app/updater.js` decides whether a newer build exists (GitHub Releases, `stable` or `canary` channel). Windows and macOS then install it with `tauri-plugin-updater` (`src-tauri/src/self_update.rs`, command `install_update`); Android downloads the APK and opens the system installer (`AndroidUpdater` in `android-MainActivity.kt`); Flatpak and iOS fall back to opening the download page.
- Update bundles are signed with a minisign key. The public key is the `TAURI_UPDATER_PUBKEY` env var / GitHub secret, merged over the placeholder `plugins.updater.pubkey` in `tauri.conf.json` at build time; the private key is the `TAURI_SIGNING_PRIVATE_KEY` (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) secret. Generate a pair with `npx tauri signer generate -w ~/.tauri/majestictab-updater.key` from `build/tauri`. Never commit the private key.
- `build/build-tauri.mjs` only emits `.sig` files and the macOS `.app.tar.gz` when the private key env var is set and `TAURI_UPDATER_PUBKEY` is set. The publish jobs then run `build/make-update-manifest.mjs` to attach `latest.json` to the release (the manifest `version` must equal the version the bundle was signed with (the plugin rejects a mismatch as tampering), so canary manifests announce the plain app version and newness is decided by the JS side).
