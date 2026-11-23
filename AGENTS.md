# MajesticTab — Development Guide

This file holds only what applies to every task. Domain guides hold the rest: **before you work in an area, read its guide.** Nested guides sit next to the code; the UI and reader guides are in `agents/` so that logic, build and test work does not load them.

## Where to look

| You are touching | Read first |
|---|---|
| Any screen, list, control, spacing, animation | `agents/ui-principles.md`, then `agents/ui-layout.md` |
| A theme, its colours, a themed button, modal or form control | `agents/ui-themes.md` |
| UI text, headings, website or store copy | `agents/ui-copy.md` |
| Reader chrome: the five words, dock, bar ruler, phone layout, Reading mode | `agents/reader.md` |
| The YouTube video sheet, the Original sound, the player | `agents/reader-video-sheet.md` |
| Folding iPhone: tabletop, book, `foldState.js` | `agents/reader-duo-fold.md` |
| Playback ticks, cursors, AlphaTab bounds (`src/gpProcessor/`) | `src/gpProcessor/AGENTS.md` |
| Chord library data (`referenceLibrary.js`, `extendedRangeChords.js`) | `support/tools/chord-voicings/AGENTS.md` |
| Jam mode (`src/jam/`) | `src/jam/AGENTS.md` |
| Build scripts, toolchain pins, Cargo, lockfiles, Flatpak, F-Droid | `build/AGENTS.md` |
| Cutting a release, release notes, the F-Droid recipe | `build/RELEASING.md` |
| Native Tauri shell, iOS simulator | `build/tauri/AGENTS.md` |
| `docs/` website, the user guide in `docs/guide/`, store listing, screenshots, branding | `support/AGENTS.md` |
| Running the app, CDP, fixtures, debugging | `tests/AGENTS.md` |

## Always true

### Repository content

- **Never commit tabs to the repo:** Agents must not add, commit, or push Guitar Pro files (`.gp`, `.gp3`, `.gp4`, `.gp5`, `.gpx`) or tab PDFs anywhere in the repository. These are copyrighted. The only exception is the `Duo No 2 In G Major.gp5` fixture in `tests/`. Use local, untracked copies for ad-hoc testing and keep them out of commits.
- **Never distribute iOS or iPadOS builds outside Apple's channels:** The Apple Developer Program License Agreement (section 7.6) allows only the App Store, Custom App Distribution, Ad Hoc to registered devices and TestFlight. Do not attach an `.ipa` to a GitHub release or workflow artifact, build a SideStore, AltStore or LiveContainer source, or write sideloading instructions. The alternatives we offer are build-it-yourself (`CONTRIBUTING.md`) and the web app at `majestictab.zathu.net/app`. Do not link to TestFlight. macOS `.dmg` downloads are not affected.
- **Never name tab sites in the code:** Do not identify any tab site or tab service by name anywhere in the repository: not in UI text, defaults, seeds, comments, tests, docs or commit messages. Describe it generically ("tab sites", "search the web"). General search engines (DuckDuckGo, Google) are not tab sites and may be named.

### The mpak standard

The mpak format is specified in the [MusicPackSpec repository](https://github.com/cgarst/MusicPackSpec) (`SPEC.md`, `schema/`, `CHANGELOG.md`), which we maintain. Read it before changing how `src/mpak.js` reads or writes a pack. **Never change anything in that repository, or in a local checkout of it, without the user's explicit approval**: not the spec text, the schema, the examples, the conformance files or the changelog. That includes a new optional field. When a feature needs a format change, describe the change and ask first. Until it is approved, keep the data in app-internal storage and do not write it into exported packs.

### Settings: persist on the device, do not sync

- **Settings never sync.** A preference (pace, view, size, Reading mode, SoundFont choice, instrument mode and the like) lives on the device only.
- **Per-song settings persist on the device**, keyed by the song or tab, so they are still there the next time it opens. Sound off is the exception by design: it is a session toggle and ends when another file opens.
- **The one exception is what the mpak spec already carries**: media selection such as which YouTube video or which stem or file is chosen over another, recordings and sync points. These travel in the pack, and only because the spec has a place for them. Do not add a field to the pack for anything else; a format change needs the user's approval (see the mpak standard above).
- **Pins are library data, not settings, and all of them persist and sync:** pinned songs (on the song record), pinned artists and pinned Classical tab composers and pieces. They stay in the backup and the sync store.
- **Search providers sync:** the list in Settings → Search providers (`majestictab_tab_sources`, with its deleted markers) is where web search opens, in the system browser (there is no in-app browser), and stays synced with its own merge.
- A new preference is therefore local by default: do not add its key to `BACKUP_SETTINGS_KEYS` or to the song record in `library.json`.

### Attribution

When code, data or design is ported or adapted from another project (not merely used as a dependency you didn't modify), credit it in all three places in the same change:

- **Source header:** a comment at the top of the ported file naming the project, author, URL and license, and saying what was taken and what was left out.
- **README:** a line in the Acknowledgments section of `README.md`, with a link and what it was used for.
- **About page:** a line in the "Third-party software" list of the About and licenses modal in `src/index.html` (`#aboutModal`), with a link and the license.

Check the upstream license first. Only port code whose license allows it, and keep its copyright notice where the license requires it.

### URLs in `src/`

`build/tauri/prepare-tauri-frontend.mjs` fails every Tauri build (CI only, not the dev server) on an `http(s)://` host under `src/` that is not in `allowedRemoteHosts`, comments and placeholders included. Never write a full URL in a comment, JSDoc or placeholder unless the host is really used and approved; describe it in words instead. A new host goes into `allowedRemoteHosts` in the same change. Details: `build/AGENTS.md`.

### The look in one paragraph

On all five targets the UI is: flat, tone steps instead of outlines, colour only on the primary action, the playhead and the active-item dot, rows not cards, no pills or decorative glyphs, one primary action and one title per screen, sentence case. Look CSS goes in `src/design.css`, never `style.css`. The notation is never restyled. The full rules are in `agents/ui-principles.md`.

### Debugging

Reproduce first, with the user's literal steps, before editing. Stop after two failed approaches: re-read the code path and compare its assumptions with the library's actual behavior. Use `tests/cdp.py`, not one-off websocket scripts. Do not grep `build/`; restrict searches to `src/`. Details: `tests/AGENTS.md`.
