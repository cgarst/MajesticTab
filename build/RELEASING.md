# Releasing

Read when cutting a release, writing release notes or maintaining the F-Droid recipe. Build details: `AGENTS.md` in this directory.

## Cutting a release

"Cut a release" (optionally with a version; default is the next patch) means the steps below, on `main` with a clean tree. Pushing a `v*` tag is what triggers `.github/workflows/release.yml` (GitHub release, updater manifest, Play and Microsoft Store publishing), so it is the one outward-facing step.

1. Pick the version: next patch unless told otherwise, and confirm the previous tag is an ancestor of HEAD.
2. Draft the notes from `git log <previous tag>..HEAD` per Release Notes below and **wait for the user's approval of the text**.
3. The version is already bumped: `bump-next` in `release.yml` bumps main to the next patch after every release, so main carries the version being released, with `support/listing/changelogs/<version>.txt` holding the default line "- Bug fixes and stability improvements" and its fastlane symlink. For a minor or major release (or the very first bump), run `node build/bump-version.mjs <version>` first; it updates `version`, `bundle.android.versionCode`, the versionCode example in `build/AGENTS.md`, and creates the changelog file and symlink. The F-Droid recipe lives in F-Droid's `fdroiddata` repo (`metadata/net.zathu.majestictab.yml`), not here, and F-Droid's auto-update adds each new tag.
4. Overwrite `support/listing/changelogs/<version>.txt` with the approved notes and commit as `Release notes for <version>` (or `Bump to <version>` when step 3 ran the script).
5. Once the user has approved the notes, tag and push without asking again: asking to cut a release is the authorization. `git tag v<version>` on that commit, then `git push origin main v<version>`. Do not tag or push if the notes were never approved, and never move or delete a pushed tag.
6. The `publish-fdroid` job in `.github/workflows/release.yml` automatically updates and pushes `metadata/net.zathu.majestictab.yml` on branch `net.zathu.majestictab` of `corey.garst/fdroiddata` (via `build/update-fdroid-recipe.py` and `FDROID_GITLAB_PAT`) after `publish` uploads the signed `no-gms` APKs. (If `FDROID_GITLAB_PAT` is missing or a manual catch-up is needed, update `~/code/fdroiddata` per Maintaining the F-Droid recipe below.)

## After a release, and TestFlight betas

- `bump-next` in `release.yml` runs after every channel's job succeeds and pushes `Bump to <next patch>` to main (with the workflow token, so it does not start a canary build). It skips itself if main is already past the released version. If a channel job fails, nothing is bumped; fix it, re-run the failed jobs, and the bump follows.
- `.github/workflows/testflight-beta.yml` builds main for iOS and macOS (`appstore-ios`, `appstore-mac`) nightly and on demand (Actions > TestFlight beta > Run workflow; tick Force to build an unchanged main) and uploads them with `fastlane ios beta` / `mac beta`. It skips a night when main has not moved since the `testflight-latest` tag, which the workflow moves after both uploads succeed. No other platform or updater sees these builds. They go to App Store Connect only, uploaded without `TESTFLIGHT_GROUPS`, so nothing reaches external testers or Beta App Review. One-time setup: in App Store Connect create an internal TestFlight group (App Store Connect users only) and turn on Automatic distribution; both the iOS and macOS builds then land in it. "What to test" is the commit list since the last beta.
- Build numbers for the appstore channels default to a UTC timestamp (`yydddHHMM`, year, day of year, hour, minute: nine digits, the most `build-tauri.mjs` accepts) in `store-build.yml`, shared by betas and releases, so a release build of a version always outranks its betas. Do not pass a small `build_number` by hand.
- The beta workflow fails if `tauri.conf.json` is not ahead of the newest `v*` tag (a released version's train is closed in App Store Connect). Fix: `node build/bump-version.mjs` on main.

## Release notes

`support/listing/changelogs/<version>.txt` (e.g. `1.0.9.txt`) is the single source of release notes. `build/release-notes.mjs` prints it for the current version and fails if it is missing, still the "Bug fixes and improvements." placeholder, over 500 characters, or if the fastlane symlink is wrong. It feeds Google Play, F-Droid, Flathub metainfo, Microsoft Store (`msstore_listing.py`), the GitHub release body, and `latest.json`. `release.yml` fails the tag if the notes are not written. Canary builds have no notes. A bump leaves the default line in the file, which the check accepts, so an unedited default would ship: always overwrite it when cutting.

Play and F-Droid read `fastlane/metadata/android/en-US/changelogs/<versionCode>.txt` from the repo, so that file is a committed symlink to the canonical one (as are `short_description.txt` and `full_description.txt` one level up); never add real text files under `fastlane/metadata/android/en-US/`. After adding the new changelog, run `node build/release-notes.mjs --link` to create the symlink.

- **Agents draft, a human approves.** When bumping the version (or when asked), draft the notes from `git log <previous tag>..HEAD` and show them in chat. Do not write or change the changelog file until the user approves the text. Never reuse the placeholder.
- **Only changes users notice:** new features, UX changes, fixes to behavior they could hit, new platforms or formats. Leave out CI, build, signing, store-listing, docs, refactor, dependency and version-bump commits.
- **Brief:** 1 to 5 plain-text lines starting with `- `, sentence case, no trailing periods, under 500 characters, no markdown, no commit hashes. If nothing user-visible changed, write `- Bug fixes and stability improvements` (the check only rejects the exact placeholder sentence).
- Creating the new version's changelog file and running `--link` is part of the version bump (see `build/AGENTS.md`); leave previous versions' files in place.
- The Flatpak metainfo template (`build/tauri/flatpak/net.zathu.majestictab.metainfo.xml`) is filled in by `render-metainfo.mjs` from the version and these notes: add `fastlane/metadata/android/en-US/changelogs/<versionCode>.txt` for every version, or the Linux build fails.

## Maintaining the F-Droid recipe

The recipe is `~/code/fdroiddata/metadata/net.zathu.majestictab.yml` on branch `net.zathu.majestictab` (see the lockstep rule in `build/AGENTS.md`). Routine version bumps are automated by `publish-fdroid` in `.github/workflows/release.yml` using `build/update-fdroid-recipe.py`; manual edits here are only needed when toolchain pins or build steps change, or if `FDROID_GITLAB_PAT` is unset.

- **Keep only the current version.** `Builds` holds only the latest release, as three blocks, one per ABI (armeabi-v7a, arm64-v8a, x86_64), since F-Droid has no ABI-split support and wants one build block per APK. The blocks are identical except `versionCode` (`10 * <versionCode> + 1|2|4`), `binary:` (`...-android-no-gms-no-update-<abi>.apk`) and `--abi=<abi>`. `VercodeOperation` lists the same three codes and auto-update (`UpdateCheckMode: Tags`, `AutoUpdateMode: Version`) generates the blocks from a new tag. Do not hand-write them with YAML anchors: `fdroid rewritemeta` flattens the file into its own form.
- **After a release:** set each block's `versionName` and `commit` (the full hash of the tag's commit, from `git rev-parse v<version>^{commit}`), remove the older version's blocks, and set `CurrentVersion` and `CurrentVersionCode` (the highest ABI code, `10 * <versionCode> + 4`). Parse the file (`python3 -c "import yaml; yaml.safe_load(open(...))"`). Run `fdroid lint` and `fdroid rewritemeta net.zathu.majestictab` where `fdroidserver` is installed.
- **Push only after the release workflow has uploaded the three signed `no-gms` APKs** (`gh release view v<version> --json assets`): each block's `binary:` points at one, and F-Droid's build is compared against it.
- **Reading a failed CI job:** `curl -sL <job url>/raw`, strip colour codes with `sed 's/\x1b\[[0-9;]*m//g'`, and look for the `Building net.zathu.majestictab:<versionCode>` line and the `error:` after it, which tells you which block failed.
- **A version that fails to build is fixed by a new release, not by editing its block.** The block's `commit:` and `binary:` must stay the pair the release workflow built, so re-pointing an old block at a newer commit will not match the APK. Cut the next patch version and drop the failed one.
