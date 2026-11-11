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
| `docs/` website, store listing, screenshots, branding | `support/AGENTS.md` |
| Running the app, CDP, fixtures, debugging | `tests/AGENTS.md` |

## Always true

### Repository content

- **Never commit tabs to the repo:** Agents must not add, commit, or push Guitar Pro files (`.gp`, `.gp3`, `.gp4`, `.gp5`, `.gpx`) or tab PDFs anywhere in the repository. These are copyrighted. The only exception is the `Duo No 2 In G Major.gp5` fixture in `tests/`. Use local, untracked copies for ad-hoc testing and keep them out of commits.
- **Never name tab sites in the code:** Do not identify any tab site or tab service by name anywhere in the repository: not in UI text, defaults, seeds, comments, tests, docs or commit messages. Describe it generically ("tab sites", "search the web"). General search engines (DuckDuckGo, Google) are not tab sites and may be named.

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
