# Builds, stores and F-Droid

Read when changing build scripts, toolchain pins, Cargo or lockfiles, or store packaging. Releases: `RELEASING.md`. Native shell: `tauri/AGENTS.md`.

## Hosts in `src/` (Tauri build allowlist)

`build/tauri/prepare-tauri-frontend.mjs` scans every `.html`, `.js`, `.css` and `.mjs` file under `src/` (comments and placeholder text included) for `http(s)://` URLs and fails the Android, Windows, macOS, Linux and iOS builds when a host is not in `allowedRemoteHosts`. It is not caught by dev-server testing, only by CI. So:

- Never write a full `https://host/...` URL in a comment, JSDoc example or placeholder unless the host is really used and approved. Describe it in words (`a /path/ page on host www.<name>.com`) or use a host already in `allowedRemoteHosts`.
- When code really needs a new host, add it to `allowedRemoteHosts` in the same change, with a comment saying why.
- Before pushing any change that adds a URL string under `src/`, run `cd build/tauri && npm ci && node prepare-tauri-frontend.mjs --android` (or grep the diff for `https\?://`) and confirm no "Unapproved external URLs" error.

## Local store builds

Release signing secrets live in the gitignored `.env` at the repo root (`ANDROID_KEYSTORE_FILE`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, etc.). `build/build-tauri.mjs` loads it automatically, but only for variables not already set in the environment. Do not export, override, or generate substitute keystores. Just run, e.g., the Play build:

```bash
node build/build-tauri.mjs android --channel=play > /tmp/play-build.log 2>&1
```

For a local debuggable build (WebView attachable over CDP, e.g. for the Android TV emulator), add `--debug`: `node build/build-tauri.mjs android --debug` writes `dist/MajesticTab-android-debug.apk` without signing, even with the keystore configured. It is debug-signed, so `adb uninstall net.zathu.majestictab` first when a release build is installed. Never use it in workflows. Then `adb forward tcp:9444 localabstract:webview_devtools_remote_$(adb shell pidof net.zathu.majestictab)` and `CDP_PORT=9444 python3 tests/cdp.py ...`. Fixtures load with `?test=<file>&test_base=http://localhost:8000/tests/` after `adb reverse tcp:8000 tcp:8000` (loopback bases only).

Outputs land in `dist/` (`MajesticTab-android.aab`, `.apk`, `-symbols.zip`). Never print `.env` values.

When bumping `version` in `build/tauri/src-tauri/tauri.conf.json`, also set `bundle.android.versionCode` in `tauri.android.conf.json` to `major * 1000000 + minor * 1000 + patch` (1.1.8 is 1001008). F-Droid reads it with a regex and cannot run that formula; Android builds fail if the two disagree. The `play` channel builds one APK and AAB carrying arm64-v8a, armeabi-v7a and x86_64. The `fdroid` channel (no Google Play services, no self-update) uses F-Droid's ABI split: one APK per ABI, built with `--abi=armeabi-v7a|arm64-v8a|x86_64` (required for that channel), each with versionCode `10 * <versionCode> + n` (armeabi-v7a 1, arm64-v8a 2, x86_64 4; the recipe's `VercodeOperation` computes the same, and the order makes the highest code the best ABI a device runs). Without a keystore (F-Droid's build) each is unsigned, `dist/MajesticTab-android-unsigned.apk`; the release workflow builds all three with the keystore (`android-no-gms` matrix), giving the signed `MajesticTab-<version>-android-no-gms-no-update-<abi>.apk` on the GitHub release, which F-Droid verifies its own build against (`binary:` per build in the recipe). There is no combined no-gms APK.

**The no-gms build and F-Droid's recipe must stay in lockstep.** F-Droid rebuilds the `fdroid` channel from source with the recipe at https://gitlab.com/corey.garst/fdroiddata/-/raw/net.zathu.majestictab/metadata/net.zathu.majestictab.yml (branch `net.zathu.majestictab` of our fdroiddata fork; the checkout is `~/code/fdroiddata`) and compares it against the signed no-gms APK in the GitHub release, so the two must produce an identical, deterministic build. Anything that can change the output has to match on both sides: Rust toolchain version, NDK version, JDK, Node major, lockfiles, build flags and the `build-tauri.mjs` invocation (`android --channel=fdroid --abi=<abi>`). The recipe installs Node, the JDK and `rustup` from Debian (`apt`) rather than downloading tarballs or running `curl | sh`, as F-Droid asked. `build.yml`'s `android-no-gms` job mirrors those pins, so when changing either side (a toolchain bump, a new build step, a changed build script), review and update the other in the same change. Changing the recipe needs the user's approval; propose the edit instead of pushing it. Verify with a local `fdroid build` and a diff against the CI APK.

## Apple stores (App Store Connect)

Signing material lives in the gitignored `.env`, like the Android keystore, and is never printed: `ASC_KEY_ID`, `ASC_ISSUER_ID` and `ASC_KEY_PATH` (or `ASC_KEY_CONTENT`) for the App Store Connect API key, `APPLE_DEVELOPMENT_TEAM` / `APPLE_TEAM_ID` for the team, and for the Mac `APPLE_SIGNING_IDENTITY` (an "Apple Distribution" certificate), `MACOS_INSTALLER_IDENTITY` (a "3rd Party Mac Developer Installer" certificate) and `MACOS_PROVISIONING_PROFILE` (a Mac App Store profile for net.zathu.majestictab, with the iCloud container). Do not create or export certificates for the user.

- **iOS:** `IOS_EXPORT_METHOD=app-store-connect IOS_BUILD_NUMBER=<n> node build/build-tauri.mjs ios --channel=appstore-ios` writes `dist/MajesticTab-ios.ipa` (Xcode's automatic signing for `APPLE_DEVELOPMENT_TEAM`). `CFBundleVersion` is the app version unless `IOS_BUILD_NUMBER` is set; App Store Connect refuses a second upload of the same version with the same build number, so raise it for every upload of one version. The app is universal (`TARGETED_DEVICE_FAMILY: "1,2"` in `ios-project.yml`): iPhone only is not a choice.
- **Mac:** `node build/build-tauri.mjs macos --channel=appstore-mac --appstore` signs the sandboxed `.app` and, with `MACOS_INSTALLER_IDENTITY`, writes `dist/MajesticTab-appstore.pkg` (`productbuild`). `APPLE_TEAM_ID` adds the application and team identifiers to the entitlements, and `MACOS_PROVISIONING_PROFILE` embeds the profile.
- **Upload:** `bundle exec fastlane ios beta` and `mac beta` (TestFlight), `ios listing` and `mac listing` (text, promotional text, screenshots). Neither lane submits for review; that stays a click in App Store Connect.
- Simulator builds for screenshots: `support/tools/simulator_screenshots.py` builds and drives them (see its header); `agent-device` rotates, folds the Duo and sets the iPad to Full Screen Apps.

## Keeping non-Android platform code out of the F-Droid build

F-Droid's recipe deletes `build/tauri/plugins` before building (its source scan rejects iOS crates and the Google Play services plugin), but Cargo needs every `path = "../plugins/..."` dependency in `Cargo.toml` to exist, even under a `[target.'cfg(...)'.dependencies]` section that Android never compiles. So a platform-specific plugin crate must be removed from `Cargo.toml` by `rewriteCargoToml` in `build/cargo-toml.mjs` before Cargo runs (F-Droid failed with "no matching package named `tauri-plugin-apple-nav` found" when `apple-nav` was added and only the old iOS plugin names were stripped).

- Name new Apple or iOS plugin crates `tauri-plugin-ios-*` or `tauri-plugin-apple-*`: the Android rewrite strips those by pattern. A plugin with another name needs its own rule in `cargo-toml.mjs`, and a plugin for another OS (Windows, Linux) needs one too if it is a local path crate.
- Keep the plugin's `lib.rs` registration under `#[cfg(target_os = ...)]`, and its capability file under `capabilities/` with `"platforms"` set, as `apple-nav.json` and `ios-fold.json` do.
- Before pushing a change that adds a local plugin crate or path dependency, copy `build/` to a scratch directory, delete `build/tauri/plugins` there, run `node build/cargo-toml.mjs fdroid android` and then `cargo metadata --format-version 1 --manifest-path build/tauri/src-tauri/Cargo.toml --filter-platform armv7-linux-androideabi > /dev/null`. It must resolve. `cargo-toml.mjs` rewrites the file it sits next to, so never run it in the real tree.
- F-Droid builds a tagged commit, so the fix reaches it only with a new release; the recipe's `commit:` for the failing version must point at a commit that has the fix (or the version must be re-cut).

## Flatpak sources

The Linux build (`node build/build-tauri.mjs linux`, and CI) compiles the app inside the GNOME SDK from `build/tauri/flatpak/manifest.yml`, offline, the same way Flathub does. The offline dependency lists `build/tauri/flatpak/cargo-sources.json` and `node-sources.json` are generated from `src-tauri/Cargo.lock` and `package-lock.json`. Whenever either lockfile changes, run `build/tauri/flatpak/update-sources.sh` (needs `flatpak-node-generator` on PATH and `FLATPAK_CARGO_GENERATOR` pointing at `flatpak-cargo-generator.py`, both from github.com/flatpak/flatpak-builder-tools) and commit the result; CI's Linux build fails when they are stale. The Flathub submission manifest and its copies of these two files are kept outside this repo, so refresh them from here before updating Flathub.
