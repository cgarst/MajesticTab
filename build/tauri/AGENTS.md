# Native App (Tauri) Troubleshooting

Use this only for native-shell issues (window, titlebar, plugins, Rust commands, YouTube native player, OAuth). For generic web/UI issues, use the browser procedures above.

- Run dev mode from `build/tauri`: `npm run tauri:dev -- --features debug-tools`. The `debug-tools` feature enables devtools and auto-opens them on the `main` window. This prepares the Tauri-only local-asset frontend first.
- CDN assets used by `src/` must remain available to the web implementation, and must also be vendored into the Tauri frontend. When adding or changing a CDN asset, pin its package version in `build/tauri/package.json`, update `build/tauri/prepare-tauri-frontend.mjs` to copy and rewrite it, and run `npm run prepare:frontend` from `build/tauri` to verify no unapproved external URLs remain.
- Native app icons are generated from `icons/icon_v2_mystic.svg` by `build/tauri/generate-icons.mjs` (`npm run generate:icons [-- windows|macos|linux|android|ios]`, defaulting to the host platform), with per-platform margins/backgrounds, into the gitignored `src-tauri/icons/<platform>/`. Adjust sizing in that script, not in generated files.
- Keep `build/tauri/frontend-dist/` generated; do not edit it directly. Distributable builds created through `node build/build-tauri.mjs <target>` prepare it automatically.
- Redirect output to a file and read it, e.g. `... > /tmp/tauri-dev.log 2>&1` (async terminal). Do not pipe through `tail`; it buffers until exit.
- The dev watcher rebuilds and relaunches automatically when files under `build/tauri/src-tauri` change; no manual restart needed. Check `pgrep -fl majestictab` to confirm the process is running.
- Rust-side logs (`eprintln!`) appear in that log; JS console output appears in the devtools console, not the terminal.
- To inspect an installed macOS app build (e.g. `/Applications/MajesticTab.app`), enable WebKit developer extras with `defaults write net.zathu.majestictab WebKitDeveloperExtras -bool true`, then attach via Safari menu: **Develop** -> *<Mac name>* -> **MajesticTab**.
- **Debug bridge (`debug-tools` builds only):** WebKitGTK/WKWebView have no CDP, so `tests/cdp.py` can't attach. `src-tauri/src/debug_bridge.rs` listens on `127.0.0.1:9555` (`MAJESTICTAB_DEBUG_BRIDGE_PORT` to change) and evaluates a POSTed JS expression in the main webview (awaited, so `await` works), returning `{"ok":true,"value":...}`: `curl -s --data-binary 'document.title' http://127.0.0.1:9555/eval`. Wrap statements in an IIFE. It is compiled out of release builds. `run.sh` also exposes the WebKit remote inspector (`inspector://127.0.0.1:9222`) and sets `GST_DEBUG`.
- **Start with real data:** `./run.sh --restore-backup` restores the newest `.mtbackup` in `~/Downloads` (`MAJESTICTAB_BACKUP_DIR` to look elsewhere; `=FILE` for a specific one) into the dev build before the library opens, adding what is missing; add `--wipe` to replace everything instead. `debug-tools` builds only (`debug_restore.rs` reads `MAJESTICTAB_RESTORE_BACKUP` / `_MODE` / `_TOKEN`, `src/debugRestore.js` runs the normal restore). It runs once per `run.sh` invocation, tracked by a marker file in the temp dir, so the dev watcher's relaunches don't repeat it. On macOS the dev build keeps its data in `~/Library/WebKit/majestictab`, apart from the installed app's `~/Library/WebKit/net.zathu.majestictab`.
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
  npx tauri ios build --target aarch64-sim --debug --no-sign --features debug-tools
  # Install the built app bundle into the booted simulator:
  xcrun simctl install booted src-tauri/gen/apple/build/majestictab_iOS.xcarchive/Products/Applications/MajesticTab.app
  # Launch installed app:
  xcrun simctl launch booted net.zathu.majestictab
  # Or run interactive dev mode:
  npx tauri ios dev "iPhone 17" --features debug-tools
  ```
- **Inspect Simulator WebViews via Safari Web Inspector** (needs the `debug-tools` feature above; release and App Store builds ship without devtools):
  1. In Safari preferences/settings, ensure **Advanced -> Show features for web developers** (or Develop menu) is enabled.
  2. Open Safari and go to menu **Develop -> iPhone 17 (Simulator) -> MajesticTab** (or the target page title/URL, such as `localhost`).
  3. Once Web Inspector opens, inspect elements, evaluate scripts in the console, view CSS rules, and monitor network requests inside the simulator's WKWebViews.

## iPhone Duo fold (`plugins/ios-fold`)

- The plugin (`start`, `stop`) streams `{type: "fold", pose, hinge, angle, x, y, w, h, winW, winH}` over a channel to `src/foldState.js`, which owns the layout side (see the iPhone Duo bullet in the root `AGENTS.md`). Poses: `none` (no fold, or iOS before 27.1), `flat` (inactive fold region), `tabletop` (active region wider than tall), `book` (taller than wide). Frames are window points, which are CSS pixels. Needs the iOS 27.1 SDK and a Duo runtime (Xcode 27.2 has `iPhone Duo` simulators).
- Hinge status is the system's: never derive it from the angle. A flat device's fold region is inactive, so the query passes `.includeInactive`. The plugin sends nothing for a repeat, and an angle change alone is not sent.
- Build and install as in iOS Simulator above, on the Duo device (`xcrun simctl list devices | grep Duo`). `simctl` cannot move the hinge: fold the device from Simulator.app, then read the state through the debug bridge: `curl -s --data-binary '(() => ({pose: document.documentElement.dataset.foldPose, top: getComputedStyle(document.documentElement).getPropertyValue("--fold-top"), h: getComputedStyle(document.documentElement).getPropertyValue("--fold-h")}))()' http://127.0.0.1:9555/eval`. The pose appears about 300ms after the fold stops. It is `undefined` until the first change from `none`.
- Without the device, drive the same layouts in a browser with `?fold=tabletop` or `?fold=book` (see `src/foldState.js`).
- The iOS build may rewrite `plugins/apple-nav/ios/Sources/AppleNavPlugin.swift` in the working tree; check `git status` after a simulator build and do not commit that change by accident.

## In-app updates

- `src/updater.js` decides whether a newer build exists (GitHub Releases, `stable` or `canary` channel). Windows and macOS then install it with `tauri-plugin-updater` (`src-tauri/src/self_update.rs`, command `install_update`); Android downloads the APK and opens the system installer (`AndroidUpdater` in `android-MainActivity.kt`); Flatpak and iOS fall back to opening the download page.
- Update bundles are signed with a minisign key. The public key is the `TAURI_UPDATER_PUBKEY` env var / GitHub secret, merged over the placeholder `plugins.updater.pubkey` in `tauri.conf.json` at build time; the private key is the `TAURI_SIGNING_PRIVATE_KEY` (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) secret. Generate a pair with `npx tauri signer generate -w ~/.tauri/majestictab-updater.key` from `build/tauri`. Never commit the private key.
- `build/build-tauri.mjs` only emits `.sig` files and the macOS `.app.tar.gz` when the private key env var is set and `TAURI_UPDATER_PUBKEY` is set. The publish jobs then run `build/make-update-manifest.mjs` to attach `latest.json` to the release (the manifest `version` must equal the version the bundle was signed with (the plugin rejects a mismatch as tampering), so canary manifests announce the plain app version and newness is decided by the JS side).
- GitHub release assets are named `MajesticTab-<version>-<platform>[-<arch>].<ext>` (e.g. `MajesticTab-1.0.14-windows-x64-setup.exe`, `-macos-apple-silicon.dmg`, `-android.apk`, `-android-no-gms-no-update.apk`, `-linux-x86_64.flatpak`); only `latest.json` and `source.json` keep fixed names. Builds emit Tauri's own names; `build/name-release-assets.mjs` renames them in the publish jobs before the manifests are generated, so add a rule there for any new asset. The landing page (`docs/index.html`) resolves its download buttons from the latest release by `data-asset` suffix.

## Distribution channels

`node build/build-tauri.mjs <target> --channel=<id>` selects a store channel (default `direct`, identical to the existing full-featured builds). `build/channels.mjs` is the source of truth for each channel's capabilities. `prepare-tauri-frontend.mjs` writes them to `frontend-dist/channel.json`, and `src/channel.js` exposes `hasFeature()` and `getFeature()`. With no `channel.json` (web, `?test=`) everything is on. This is separate from `MAJESTICTAB_CHANNEL` (CI stable/nightly, `build-info.js`); the store channel travels as `MAJESTICTAB_STORE_CHANNEL`. Native gating (Cargo features, Android flavors) and the purchase bridges are not wired yet.

Store channels build in CI through `.github/workflows/store-build.yml` (manual dispatch). It uploads artifacts named `MajesticTab-<channel>-<version>.<ext>` and never publishes a release or `latest.json`; `release.yml` and `canary.yml` still build only `direct`. Every channel ships the Tab Downloader with default search engines. Arbitrary userscripts and userscript injection are removed; the webview relies strictly on the native content shim for containment and ad suppression.
- The release version is set only in `src-tauri/tauri.conf.json` (`version`), and the git tag must match it. Everything else derives from it: Android `versionCode`/`versionName` (Tauri), Rust `MAJESTICTAB_VERSION` (`build.rs`), and the iOS plist/project and Flatpak metainfo `__APP_VERSION__` placeholders (substituted by `build/build-tauri.mjs`). `Cargo.toml`, `package.json` and their lockfiles are deliberately `0.0.0`; never put a real version there.

## Disk usage and pruning

`build/tauri` grows to tens of GB, almost all of it gitignored Cargo output that rebuilds on demand. All Cargo output goes to one dir, `build/tauri/target/`: `src-tauri/.cargo/config.toml` sets `target-dir` for direct `tauri dev`/`tauri ios` runs and `build/build-tauri.mjs` sets `CARGO_TARGET_DIR` to the same place. Do not create a second target dir; dependencies would compile twice. `[profile.dev]` in `Cargo.toml` keeps debug info to line tables to hold the dev dir down. `src-tauri/gen/` (Gradle output, iOS `Externals`) is also regenerable.

- Check sizes with `du -sh target src-tauri/gen`, then one level down.
- Only build Android for `aarch64-linux-android` here. Delete `armv7-linux-androideabi`, `x86_64-linux-android` and other unused ABI dirs when they appear.
- Prune about monthly, or when the folder passes about 60 GB. Delete stale target subdirs (`release`, `doc`, old platform dirs, and unused platform dirs), or run `cargo sweep --time 14` on `target/` (`cargo install cargo-sweep` first). Never prune while cargo, gradle or xcodebuild is running.
- Never delete `src-tauri/gen/apple/Externals` casually: iOS builds need it.
