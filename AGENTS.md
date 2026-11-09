# MajesticTab — Development Guide

## Re-imagined UI (requirements)

MajesticTab's interface follows the "MajesticTab Reimagined" design: the app recedes and the score leads. These rules are requirements for every new or changed screen, on all five targets (Windows, macOS, Linux, Android, iOS). Where they conflict with the older rules below, these win. All redesign CSS lives in `src/design.css`; it loads after `src/style.css` and overrides it. Put new redesign styles there, not in `style.css`.

**Look**
- **Flat only.** No gradients, glass, `backdrop-filter`, glow or shadows on things at rest. Shadows are for what truly floats (menus, dialogs). Scrims dim; they do not blur.
- **Tone steps, not outlines.** Separate surfaces with the ground ladder (`--ground`, `--s1`, `--s2`, `--s3`), never with 1px borders, dashed boxes, hairline dividers or outlined cards. A selected or hovered row takes one tone step. Boxed toolbars and bordered cards are not allowed.
- **Color sits on three things only:** the one primary action, the playhead (and loop band), and the active-item inlay dot. Everything else is ink (`--ink`, `--ink2`) on the ground ladder. Use the theme tokens; never hard-code hex values.
- **No pills.** Counts, tunings, years, page ranges and statuses are plain grey text beside what they describe, separated by a middle dot. A filled shape is only for a real control (a filter, a switch) or a key cap. Do not add `badge`, `chip` or `rounded-pill` for metadata.
- **No decorative glyphs.** An icon appears only where it carries meaning that the label does not (navigation, play, pin, status dot). No icon beside a text button, no tinted icon squares, no emoji.
- **Type.** System font for UI text. Barlow Condensed (`--font-display`) only for song titles, section titles and big numerals. Sentence case for labels, headings and actions. No small uppercase tracked labels, no eyebrows above headings, no index numbering unless the content is a sequence.
- **Radius follows the platform** through `--r-control` and `--r-card` (set per platform at the top of `design.css`: rounder on macOS and iOS, tighter on Windows and Linux). Do not hard-code radii. Press feedback follows the platform too: a tonal layer on Android, scale-on-press on iOS, a 1px nudge on desktop.
- **The notation is never restyled.** AlphaTab output is drawn as it is. The redesign only supplies the paper behind it, the zoom and the playhead layer.

**Layout**
- **Rows, not cards.** Lists of artists, songs, setlists, recents, tunings and settings are flat rows on a 56px pitch with the same left edge. No card grids.
- **One title per screen and one back control.** Do not repeat a title in a pane header, a breadcrumb bar and a back button. A breadcrumb appears only when the user is at least two levels deep.
- **One primary action per screen.** Everything else is a text action ("Add tab", "Rename", "Edit"): ghost style, `--ink2`, one tone step on hover. Do not stack several filled buttons in one row.
- **Redundancy is a defect.** The same control, readout or setting must not live in two places on one screen (for example position shown in both the ruler and a percentage, or a setting reachable from both a menu and a page). Remove the weaker copy.
- **The reader has five labelled buttons, the Song menu and one dock, the same words on every platform:** **View** (layout, notation, size, paper, pages shown), **Practice** (speed, parts, loop range, metronome and count-in), **Tracks** (which tracks to show and hear, levels and color), **Guitar** (strings, tuning and capo for the guitar in your hands: temporary, it resets when the song closes, and is saved only for the song or as the usual guitar when the player asks) and **Tools** (Chord library, Scales, Circle of fifths, Tuner, Metronome, Audio latency, Jam). The song's name in the top bar opens the **Song** menu (section marks, PDF options, save and share). The dock holds the transport, the Synth | Original switch and volume (on phones the volume lives in the sound panel); pressing the selected sound opens its panel (Synth: what you hear and the SoundFont; Original: the source, with Recording | Backing, then Add a video (one field: a pasted link or video ID is added as it is, anything else is a search whose first match is added), the list of videos remembered for this recording (switch with one press, each keeps its own sync points, copy sync points between videos, Remove videos…) and sync points; the video itself is in the video sheet below). The list is `src/audioSync/videoHistory.js` (10 per slot, a video with sync points is never dropped, included in backups as `yt_videos_*`); a video found by search is remembered when played, one the person adds when added. With Original selected, a recording bar (time, track, sync state and "Add points") sits above the bar ruler on Guitar Pro songs, and above the page strip on PDF and text tabs; audio latency applies to every sound and lives in Tools; The fretboard sits above the dock on Guitar Pro songs, with no entry in Tools: a button in the dock (or the F key) toggles it. PDF and text tabs get a page strip in place of the bar ruler. Settings is the set-once place and holds the defaults that View (notation) and Guitar (usual guitar) override for one song. On phones see **Phone reader chrome** below. Do not add another place, and do not put the same control in two of them.
- **The video sheet** (`src/ytSheet.js`, `#ytSheet`): the YouTube player is not in the Original panel. YouTube's developer policies forbid a background player (III.I.9: content played from a player "not displayed in the page, tab, or screen that the user is viewing") and its player docs set a 200 x 200 minimum viewport, so the player stays on the screen while it plays.
  - **When it exists.** While Original is the selected sound and its source is YouTube with a video known (a saved or synced one): it opens as soon as Original is selected, such as when a song with a recording opens, and does not wait for play (`scheduleOriginalVideo()`, called from `setActiveAudioMode` and when the reader comes back; opening a tab changes the sound several times, so the changes settle for 250ms and the sheet follows the last one, popping in once). It also opens when playback starts by any path (a press on play, Jam, a sync-started video). The Original panel and the video are never on the screen together: opening the Original panel pauses the audio and closes the sheet, and pressing play closes the panel and, for YouTube, opens the sheet again (a video picked or pasted while the panel is open only loads). A local file, the Synth, a new song, or leaving the reader closes it, and closing pauses. `closeSheet()` is the only way out and it pauses first. Never hide, shrink, move off-screen or cover a playing player: not with `display`, `visibility`, `opacity`, a 1px size, a position past the window edge, or any of our own controls or panels. The guard in `youtubePlayer.js` restores the sheet if anything left a playing video hidden, and warns when the player is under 200 x 200 or covered.
  - **Layout.** Rows: grabber (and in tabletop the Video | Fretboard switch), then the video; no caption or Close button. Nothing is drawn over the video. The sheet overlaps the page: the score never reflows or shifts for it. Portrait phone: full width above the fretboard and the five words, and every sheet that opens (View, Practice, Tracks, Guitar, Tools, Song, Original) ends above it (`--yt-sheet-h` is the visible height). Desktop: at the right, above the dock, with the panels ending above it. Short landscape phone: a 356px column on the right with the right-hand panels beside it. The player is kept at YouTube's minimum viewport as a 16:9 player, 356 x 200, on every layout (never full width on a phone, never larger); the width falls to the screen's only if the screen is narrower. YouTube gives no way to read a video's real shape (oEmbed reports 200 x 113 for every video), so the player is not matched to the content, and album-art videos keep their bars. Do not crop the player to hide them.
  - **The peek.** The person (and only the person, by swiping the grabber down or pressing it, or arrow keys) pushes the sheet down to a peek: the top slice of the video (about 56px, its title and the YouTube mark) stays on the screen, over the page. This is a deliberate, accepted risk: the slice is smaller than the player docs' minimum, so nothing in the app may do it for the person (no timer, playback event or panel), and a new video or song opens the sheet fully again. The player keeps its full size inside the clip (the sheet is moved down and clipped at the bottom on web; `window.ytFit` anchors the player to the top of the native view), so its own viewport never shrinks.
  - **Native players (macOS, iOS).** The native view covers only the visible slice of the sheet (`visibleVideoRect()`); it is never parked off-screen or shrunk to a dot: when the sheet is not shown the player is paused and hidden. Because a native view draws above the page, nothing may open over the sheet's rect; panels end above it. The other shells embed in the page (Windows, Android: direct iframe; Linux: the relay page `docs/youtube-player.html`) and need no special handling here. Check macOS, iOS, tabletop and the peek in the real app, since the browser cannot show the native view.
  - **Tabletop.** The sheet takes the fretboard's band. With Video chosen the fretboard steps aside; the Fretboard choice (the switch in the sheet's bar, shown only on Guitar Pro songs) lowers the sheet to its peek and brings the fretboard back above it. Panels end above the sheet. The same 356 x 200 player, centered.
  - **The sound panels on a portrait phone** (Synth, Original) open from their button in the strip, as the five words' sheets open from theirs (`--src-top`, set where `--dock-h` is): the open button takes the panel's tone and square top corners and the rest of the switch is left flat, so the two read as one piece. When the video sheet is up they stack above it instead.
  - **Reading mode** leaves the video where it is: the sheet is part of playback, not chrome.
- **Phone reader chrome** (`body.phone-reader`, set from `PHONE_READER_QUERY`: narrow screens and short landscape phones). The sheet never changes size on its own; it changes only when the player presses **Reading mode**. No timer, tap zone or playback event moves a bar.
  - **Top, one slim row over the score:** back, the song name (opens Song) and the page buttons. It overlays the score (in Scroll mode the score scrolls under it), so hiding it resizes nothing.
  - **Bottom, for the thumb (portrait):** the strip, then the five words (View, Practice, Tracks, Guitar, Tools) as the last row above the home indicator. The strip has the progress track on top (bar ruler on Guitar Pro songs, page strip on PDF and text tabs, the recording bar under Original), then restart, play/pause, Synth | Original, the fretboard toggle (Guitar Pro only) and the Reading mode toggle. The fretboard sits above the strip. Sheets rise from the bottom above the strip and the five words, short enough to leave the tab visible. Practice keeps speed, loop, metronome, count-in and parts. The five words are moved out of the top bar by `readerViewMenu.js` (a transformed bar would carry a fixed child with it).
  - **The top never hides on scroll.** Scrolling, timers, taps and playback leave every bar where it is; only Reading mode hides the top. A tap anywhere on the page turns it (left half back, right half forward).
  - **Reading mode** (the toggle in the bottom bar, on every platform, `R`, gamepad Y; `aria-pressed`; remembered on phones): hides the top, the five words, restart, Sound, the fretboard button and the fretboard; keeps play/pause, the progress track and the toggle. One deliberate refit when it turns on and one when it turns off. Desktop works the same way (top bar away, bottom bar narrowed to play, progress and the toggle, no edge peek), but is not remembered. The toggle lives only in the bottom bar (View does not repeat it). `Z` is unused.
  - **Short landscape phone:** the five words stay in the top, which becomes a left rail (back, song name, the five words); Reading mode removes it and leaves the slim strip.
- **iPhone Duo folded** (`src/foldState.js`; native side `build/tauri/plugins/ios-fold`). WKWebView hides Device Posture and Viewport Segments, so the Swift plugin reads the division region (`reservedRegions`, with `.includeInactive`) and `UIHingeInteraction` and sends the pose; the layout never branches on a device name. The pose is applied once the fold has stopped moving (300ms), with one refit, never per hinge update. It sets `html.duo-tabletop` or `html.duo-book` and `--fold-top`/`--fold-h` or `--fold-left`/`--fold-w`, and fires `foldchange`. Reader only: the library keeps its normal layout. Nothing interactive sits in the crease. In a plain browser, `?fold=tabletop` or `?fold=book` (optional `fold_size`) drives the same layouts.
  - **Tabletop** (crease across, inner display upright): the phone reader chrome, with the score in the top half (`#mainContent` is `--fold-top` tall) and everything you touch in the bottom half, top down: one row with back, the song name and the page buttons (the top bar moved down to the top of this half, under the crease; the top half has nothing over the score), then the fretboard, always shown on Guitar Pro songs (it fills the band under the song row, its strings spaced wider, no toggle: `fretboardController.js` pins it open in this pose), the strip (progress, transport, Synth | Original) and the five words. Every press target is 56px (`--dt-target`). A sheet is activated by one of the five words: it covers the bottom half from the crease down to the five words, which stay visible (the selected word closes it), the same height and top edge for every sheet, scrolling inside. Nothing is open by default. A tap on the score does not close a panel (`outsideTapCloses()` in `readerPanels.js`). **Reading mode** is the existing phone Reading mode, with no tabletop variant: the open-book button ends the transport row, and while it is on every tabletop rule steps aside (`body.reading-mode`, `isTabletopLayout()` in `foldState.js`) so the ordinary phone reading view shows, full screen, and turning it off brings the tabletop layout back. A tall PDF page is read in bands at the full width of the score half (`layoutPages()` in `renderUtils.js` cuts it at blank rows; one page turn moves one band) instead of being shrunk to fit the height. The phone rules sit in `@media (max-width: 640px)` blocks and the inner display is wider, so `narrowAlias.js` restates them under `html.duo-tabletop` with CSS nesting; do not copy those blocks by hand. The short-landscape-phone rail rules are wrapped in `:where(html:not(.duo-tabletop))` so they do not match. `isPhoneReader()` is true in tabletop.
  - **Book** (crease up and down, inner display landscape): Page mode with two pages, one on each half, with the crease as the gap (`pageGapPx()`, `getPagesPerView()` returns 2). It is temporary: `bookMode.js` goes back to Scroll when the fold opens flat unless the player picked a mode meanwhile, and it never touches the saved defaults.
  - Check the Duo pose in the Xcode simulator (Simulator.app drives the hinge, not `simctl`) and read `html[data-fold-pose]` and the CSS variables through the debug bridge.
- **Settings is a page in the navigation**, reached only from the library rail or tab bar. It is not a drawer, and there is no hamburger or edge swipe for it. It is a library view like Tools (`activeView = 'settings'`, route `#settings`, the same back history), drawn in the library's content area; no key, URL parameter, gesture or controller button opens it. `#fileMenu` only parks the built page while another view shows. The rail highlights Settings while it is open and any other destination closes it. Settings pages have one row per setting with the label and a short description; the whole row is the target.
- **Library order:** Pinned songs (its own group, selected by default when anything is pinned), then Custom Music, then the Artists list. Album shelves show artwork only, since the album header already names the album.
- **The rail has four destinations:** Library, Setlists, Tools and Settings (Settings last, aligned to the bottom). Tools is a page of flat rows, one per tool (Chord library, Scales, Circle of fifths, Tuner, Metronome, Audio latency, Jam); the reader's Tools button keeps a small menu with the same tools. Tunings and Recents are "Browse by" choices inside Library, next to Artists; they are not rail items.
- **The navigation shell is chosen by container width, not user agent:** a sidebar rail (76px from 577px wide, full width from 1000px), a bottom tab bar below that (phone), at most five items, always with labels. The library has no reader controls on phones; the reader has no library chrome.
- **Destructive actions** sit in a Danger zone, use the danger color, and need a second press or confirmation.

**Interaction and accessibility**
- Touch targets are at least 44px on coarse pointers (and 24px minimum anywhere); keep 8px between neighbours. Every icon-only control has an accessible name; every control works from the keyboard with a visible focus ring.
- Text contrast is at least 4.5:1 (3:1 for large text and non-text UI) in every theme, light and dark. Color is never the only signal.
- Motion uses the shared tokens in `design.css` (`--dur-fast` 150ms, `--dur-base` 250ms, `--dur-slow` 350ms, `--dur-slower` 400ms; `--ease-out`), animates `transform` and `opacity` only, makes exits faster than entries, and is switched off under `prefers-reduced-motion`. Every modal and menu needs a close transition, not only an open one.
- Long lists use `content-visibility: auto`; no layout-shifting animations.

**Process**
- Check every changed screen at desktop (1440 wide) and phone (390 wide), and in at least two themes, one of them Snow White.
- Real data first: restore a full backup before judging density, truncation and empty states.
- Phone click-through: run `python3 tests/mobile_validate.py --channel msedge` (dev server on :8000) after any change to navigation, the library, Settings, Tools or the reader chrome. It samples every frame and fails on a flash, pop-in or sideways overflow. iPhone safe areas need the CSS served with `env(safe-area-inset-*)` replaced by pixels; check the reader's bottom rows that way, not only in a plain emulator.
- Do not reintroduce a removed pattern by copying an older screen. If an older screen still uses pills, cards or outlines, fix it as part of the change that touches it.

## UI Theme Consistency

- **Never Use Bootstrap Default Button Classes:** Do NOT use Bootstrap's color button classes (`btn-primary`, `btn-outline-primary`, `btn-secondary`, `btn-outline-secondary`, `btn-danger`, `btn-outline-danger`, `btn-success`, `btn-outline-success`, `btn-info`, `btn-outline-info`, `btn-warning`, `btn-outline-warning`, `btn-light`, `btn-outline-light`, `btn-dark`, `btn-outline-dark`). These apply hard-coded Bootstrap colors (e.g., `#0d6efd` blue) that ignore and break MajesticTab's dynamic themes (`data-theme`).
- **Use MajesticTab Themed Button Classes:** Always use the standard themed button classes defined in `src/style.css`:
  - `btn-theme-primary`: Primary call-to-action buttons. Applies `--accent-gradient`, `--accent-glow`, white text, and themed hover elevation.
  - `btn-theme-outline`: Secondary / neutral action buttons. Applies `--bg-card-solid`, `--border-subtle`, and accent-glow on hover.
  - `btn-theme-danger`: Destructive / delete actions. Applies themed red tint, border, and hover contrast.
  - `btn-theme-success`: Affirmative actions. Applies themed green tint and border.
  - `btn-theme-icon`: Compact icon-only toolbar buttons.
  - `theme-control-btn`: Standard offcanvas settings / toolbar control buttons.
- **Modal & Dialog Consistency:** Modals must use themed containers (`.theme-modal-backdrop`, `.theme-modal-card`, `.theme-modal-header`, `.theme-modal-body`, `.theme-modal-footer`, `.brand-btn.theme-modal-close-btn`). Modal action buttons must strictly use `btn-theme-primary` for the confirm/submit action and `btn-theme-outline` or `theme-control-btn` for cancel/dismiss.
- **Form Controls & Inputs:** Inputs, dropdowns, and switches must reuse theme styles (`.form-control`, `.form-select` with theme background/borders, `.form-check-input.theme-switch`, `.hud-pill-group`).
- **Multi-Theme Verification:** Match existing controls' themed active, inactive, hover, and disabled states. Verify new UI in at least two themes (e.g., Mystic Dream, Blue Pearl, Ember Glow) to ensure colors, contrast, and selected states remain legible and consistent across all themes.

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

The website (`docs/`) follows the Reimagined rules above, not the eyebrow and Title Case conventions below: sentence case for headings, labels and actions, and no eyebrows. The rest of this section is older guidance.

To ensure high visual polish, scannability, and consistency across marketing pages and product interfaces, follow these casing and punctuation standards:

- **Section Headlines & Titles (Sentence case):** All major section headlines (e.g., `<h1>`, `<h2>`, hero titles, section value propositions) must use **Sentence case**. Capitalize only the first word and proper nouns/branded names (e.g., *MajesticTab*, *YouTube*, *SoundFont*, *Bluetooth*, *Google Drive*, *PDF*).
  - *Correct:* `Continuous scroll or book-like pages`, `YouTube audio and backing tracks`, `Gamepad and Bluetooth page turner support`
  - *Incorrect:* `Continuous Scroll or Book-Like Pages`, `YouTube Audio & Backing Tracks`
- **Eyebrows & Category Kickers (Title Case):** Sub-headings and kickers positioned above section headlines (often styled with `text-xs font-bold uppercase tracking-widest`) must use **Title Case** in raw HTML text (2–4 words max).
  - *Correct:* `Two Ways to Read`, `Multi-Track Focus`, `Practice in Sync`, `Hands-Free Control`, `Visual Themes`
  - *Incorrect:* `Two ways to read`, `Practice In Sync`
- **Feature Cards & Sub-Headers (Sentence case):** Card headlines (`<h3>`) and item summaries should use **Sentence case** (e.g., `Export to PDF`, `Fills your screen`, `Easy on the eyes`).
- **Ampersands vs. "and":** Write out **"and"** in editorial headlines and body copy (e.g., *"Gamepad and Bluetooth page turner support"*, *"PDF export and condensing"*). Reserve the ampersand (`&`) only for compact badges, pill groups, or tight navigation links where space is strictly constrained.
- **Navigation & CTA Buttons (Title Case):** Navigation links, standalone call-to-action buttons, and modal action triggers should use **Title Case** (e.g., `Download MajesticTab`, `Open App`, `Tab Library`).

## Chord Voicings (Reference Library)

The chord library data is `chordData` in `src/referenceLibrary.js` (6 strings) and `chordData7` / `chordData8` in `src/extendedRangeChords.js`. Every change to it, by hand or generated, must pass `node support/tools/chord-voicings/check.mjs`. `node support/tools/chord-voicings/repair.mjs [--apply]` finds failing rows and searches for the closest valid, playable replacement. The rules live in `support/tools/chord-voicings/` (`rules.mjs` for the notes, `playability.mjs` for the hand); change a rule there, not just in the data, and keep `check.mjs`'s well-known shapes passing.

**Data format**

- `frets` is one fret per string, lowest string first (`x` mutes, `0` is open), so 7-string rows have 7 entries and 8-string rows 8. The top six strings of 7- and 8-string guitars are standard tuning, so every 6-string shape works on them with the extra strings muted.
- Names are root plus suffix with `♯` / `♭` glyphs (`C♯`, `E♭`, `F♯`, `A♭`, `B♭`), matching the circle of fifths. Roots, in filter order: A♭ A B♭ B C C♯ D E♭ E F F♯ G (`chordRootFilters`). Suffixes with `-11` mean ♯11 and `-13` means 13.
- Each `name` + `cat` has exactly one `default: 1` row. `barreChord: 0` is an open-position shape (it may have open strings), `barreChord: 1` is movable (no open strings). The Prefer Barre toggle shows a `barreChord: 1` row with `default: 0` only when an open default exists for the same chord, so keep `cat` identical across a chord's rows (add9, 6/9 are Major, madd9 is Minor).
- `startFret` is 1 when the row has an open string, otherwise the lowest fretted fret (or lower).
- The 3 sets list the same chords. Sharp and flat roots are the natural default row one semitone lower shifted up a fret. The library shifts data at runtime for tunings and capos (chord X in a tuning `n` semitones down shows the standard shape of the chord `n` semitones higher), so every one of the 12 roots needs rows.

**Notes rules (`rules.mjs`)**: every sounded note is a tone of the chord, the root is present, so is the third (except sus chords) and the tones that define the chord type (the 7th of a maj7, the 9th of a 9, and so on). The bass note is the root, or the fifth with the root directly above it.

**Playability rules (`playability.mjs`)**: four fingers, no thumb.

- A finger can bar several strings at one fret, never over a string that is open or fretted lower (the highest fret pressed sets the pitch). A bar may pass over muted strings or strings fretted higher, which is how one finger bridges two strings.
- Each bar run needs its own finger in fret order (fingers may be skipped), at most 4. The index finger bars any width, the middle and ring fingers at most 4 strings, the pinky never.
- Fingers `k` apart sit at most `3k` strings and `k + 1` frets apart. Using all four fingers together with a stretch is rejected. The fretted notes fit in five frets.
- The same logic draws the small bars on the chord diagrams (`findFingerBars` in `src/referenceLibrary.js`): bridged frets are always barred, and with four or more notes the index finger bars the lowest fret.

**Using the extra strings (7 and 8)**: add the root, or the fifth under the root, on the extra low strings when that stays playable. An open low string is only allowed on the default row, with at most one muted string between it and the shape, and the movable shape stays as the alternate. Fretted additions must stay within the hand's reach.

## Support and Marketing Assets (`support/`)

Website, store listing, and branding material live in `docs/` and `support/`:

- `docs/`: the public website (GitHub Pages root: `index.html`, `site.css`, `privacy.html`, `CNAME`, `fonts/`, `img/`, `icons/`), the deploy root for `majestictab.zathu.net`.
- `support/store/`: Microsoft Store screenshots and logos (`msstore/`), Play desktop screenshots (`play/desktop/`, which the Play API can't upload) and Flathub screenshots (`flathub/`). Flathub requires real window captures with native decorations, so `support/tools/flathub_screenshots.mjs` drives the installed release Flatpak on a KDE Wayland machine and captures it with Spectacle (never compose or emulate them); see the script header for how to run it.
- `support/listing/`: the single source for store listing text on every channel (`short_description.txt`, `full_description.txt`, `changelogs/<version>.txt`). `fastlane/metadata/android/en-US/` holds the Google Play and F-Droid listing images (icon, feature graphic, phone and tablet screenshots) plus symlinks to that text. `msstore_listing.py` reads the same descriptions and release notes. `fastlane android listing` syncs the listing to Play and `fastlane android release` uploads the AAB (`bundle exec`, with `PLAY_SERVICE_ACCOUNT_JSON` set).
- `support/branding/`: source icon SVGs and `generate_icons.py`, which writes the web PNG/ICO icons to both `src/icons/` and `docs/icons/`.
- `support/tools/`: generators (`store_screenshots.py`, `store_logos.py`, `generate-steam-artwork.mjs`, `generate-msstore-artwork.mjs`, `flathub_screenshots.mjs`) and `landing/capture.mjs`, which captures the website's pictures from the real app (`docs/img/app/*.webp` and the hero loop `hero.webm`/`hero.mp4`, Slate Blue, `Duo No 2` fixture only; see its header for how to run it, and re-run it before each release so the site matches the app). The website is hand-written (`docs/index.html`, `docs/site.css`), flat and built on the Reimagined rules; there is no CSS build step. `chord-voicings/` holds the chord library's note and playability rules plus its check and repair scripts (see Chord Voicings above).

Runtime app icons are in `src/icons/` (referenced as `icons/...` from `src/`).

## Attribution

When code, data or design is ported or adapted from another project (not merely used as a dependency you didn't modify), credit it in all three places in the same change:

- **Source header:** a comment at the top of the ported file naming the project, author, URL and license, and saying what was taken and what was left out.
- **README:** a line in the Acknowledgments section of `README.md`, with a link and what it was used for.
- **About page:** a line in the "Third-party software" list of the About and licenses modal in `src/index.html` (`#aboutModal`), with a link and the license.

Check the upstream license first. Only port code whose license allows it, and keep its copyright notice where the license requires it.

## Repository Content Rules

- **Never commit tabs to the repo:** Agents must not add, commit, or push Guitar Pro files (`.gp`, `.gp3`, `.gp4`, `.gp5`, `.gpx`) or tab PDFs anywhere in the repository. These are copyrighted. The only exception is the `Duo No 2 In G Major.gp5` fixture in `tests/`. Use local, untracked copies for ad-hoc testing and keep them out of commits.
- **Never name tab sites in the code:** Do not identify any tab site or tab service by name anywhere in the repository: not in UI text, defaults, seeds, comments, tests, docs or commit messages. Describe it generically ("tab sites", "search the web"). General search engines (DuckDuckGo, Google) are not tab sites and may be named.

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

Never put a `.gp*` file or tab PDF in the served repo root to test a download. Serve it from a second directory on another port (see Repository Content Rules).

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
- The `.at-cursors` layer and `.gp-reader-cursor` show from load, as in AlphaTab, with the cursor at the start of the score.
- Public AlphaTab fields are minified (`Qw`, `vy`, `Ny`); avoid depending on them, and if unavoidable, route through a single helper such as `getMidiTickLookup()`.

### Hosts in `src/` (Tauri build allowlist)

`build/tauri/prepare-tauri-frontend.mjs` scans every `.html`, `.js`, `.css` and `.mjs` file under `src/` (comments and placeholder text included) for `http(s)://` URLs and fails the Android, Windows, macOS, Linux and iOS builds when a host is not in `allowedRemoteHosts`. It is not caught by dev-server testing, only by CI. So:

- Never write a full `https://host/...` URL in a comment, JSDoc example or placeholder unless the host is really used and approved. Describe it in words (`a /path/ page on host www.<name>.com`) or use a host already in `allowedRemoteHosts`.
- When code really needs a new host, add it to `allowedRemoteHosts` in the same change, with a comment saying why.
- Before pushing any change that adds a URL string under `src/`, run `cd build/tauri && npm ci && node prepare-tauri-frontend.mjs --android` (or grep the diff for `https\?://`) and confirm no "Unapproved external URLs" error.

### Local Store Builds

Release signing secrets live in the gitignored `.env` at the repo root (`ANDROID_KEYSTORE_FILE`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, etc.). `build/build-tauri.mjs` loads it automatically, but only for variables not already set in the environment. Do not export, override, or generate substitute keystores. Just run, e.g., the Play build:

```bash
node build/build-tauri.mjs android --channel=play > /tmp/play-build.log 2>&1
```

For a local debuggable build (WebView attachable over CDP, e.g. for the Android TV emulator), add `--debug`: `node build/build-tauri.mjs android --debug` writes `dist/MajesticTab-android-debug.apk` without signing, even with the keystore configured. It is debug-signed, so `adb uninstall net.zathu.majestictab` first when a release build is installed. Never use it in workflows. Then `adb forward tcp:9444 localabstract:webview_devtools_remote_$(adb shell pidof net.zathu.majestictab)` and `CDP_PORT=9444 python3 tests/cdp.py ...`. Fixtures load with `?test=<file>&test_base=http://localhost:8000/tests/` after `adb reverse tcp:8000 tcp:8000` (loopback bases only).

Outputs land in `dist/` (`MajesticTab-android.aab`, `.apk`, `-symbols.zip`). Never print `.env` values.

When bumping `version` in `build/tauri/src-tauri/tauri.conf.json`, also set `bundle.android.versionCode` in `tauri.android.conf.json` to `major * 1000000 + minor * 1000 + patch` (1.1.0 is 1001000). F-Droid reads it with a regex and cannot run that formula; Android builds fail if the two disagree. The `fdroid` channel (no Google Play services, no self-update) builds one universal release APK (arm64-v8a, armeabi-v7a and x86_64). Without a keystore (F-Droid's build) it is unsigned, `dist/MajesticTab-android-unsigned.apk`; the release workflow builds it with the keystore, giving the signed `dist/MajesticTab-no-gms-android.apk` on the GitHub release, which F-Droid can verify its own build against (`Binaries:` in the recipe). Every Android build carries all three ABIs.

**The no-gms build and F-Droid's recipe must stay in lockstep.** F-Droid rebuilds the `fdroid` channel from source with the recipe at https://gitlab.com/corey.garst/fdroiddata/-/raw/net.zathu.majestictab/metadata/net.zathu.majestictab.yml (branch `net.zathu.majestictab` of our fdroiddata fork; the checkout is `~/code/fdroiddata`) and compares it against the signed no-gms APK in the GitHub release, so the two must produce an identical, deterministic build. Anything that can change the output has to match on both sides: Rust toolchain version, NDK version, JDK, Node major, lockfiles, build flags and the `build-tauri.mjs` invocation (`android --channel=fdroid`). The recipe installs Node, the JDK and `rustup` from Debian (`apt`) rather than downloading tarballs or running `curl | sh`, as F-Droid asked. `build.yml`'s `android-no-gms` job mirrors those pins, so when changing either side (a toolchain bump, a new build step, a changed build script), review and update the other in the same change. Changing the recipe needs the user's approval; propose the edit instead of pushing it. Verify with a local `fdroid build` and a diff against the CI APK.

### Cutting a Release

"Cut a release" (optionally with a version; default is the next patch) means the steps below, on `main` with a clean tree. Pushing a `v*` tag is what triggers `.github/workflows/release.yml` (GitHub release, updater manifest, SideStore source, Play and Microsoft Store publishing), so it is the one outward-facing step.

1. Pick the version: next patch unless told otherwise, and confirm the previous tag is an ancestor of HEAD.
2. Draft the notes from `git log <previous tag>..HEAD` per Release Notes below and **wait for the user's approval of the text**.
3. Bump `version` in `build/tauri/src-tauri/tauri.conf.json` and `bundle.android.versionCode` in `tauri.android.conf.json` and the versionCode example in Local Store Builds. The F-Droid recipe lives in F-Droid's `fdroiddata` repo (`metadata/net.zathu.majestictab.yml`), not here, and F-Droid's auto-update adds each new tag.
4. Write `support/listing/changelogs/<version>.txt`, run `node build/release-notes.mjs --link`, and commit as `Bump to <version>`.
5. Once the user has approved the notes, tag and push without asking again: asking to cut a release is the authorization. `git tag v<version>` on the bump commit, then `git push origin main v<version>`. Do not tag or push if the notes were never approved, and never move or delete a pushed tag.

### Release Notes

`support/listing/changelogs/<version>.txt` (e.g. `1.0.9.txt`) is the single source of release notes. `build/release-notes.mjs` prints it for the current version and fails if it is missing, still the "Bug fixes and improvements." placeholder, over 500 characters, or if the fastlane symlink is wrong. It feeds Google Play, F-Droid, Flathub metainfo, Microsoft Store (`msstore_listing.py`), the GitHub release body, `latest.json` and the SideStore source. `release.yml` fails the tag if the notes are not written. Canary builds have no notes.

Play and F-Droid read `fastlane/metadata/android/en-US/changelogs/<versionCode>.txt` from the repo, so that file is a committed symlink to the canonical one (as are `short_description.txt` and `full_description.txt` one level up); never add real text files under `fastlane/metadata/android/en-US/`. After adding the new changelog, run `node build/release-notes.mjs --link` to create the symlink.

- **Agents draft, a human approves.** When bumping the version (or when asked), draft the notes from `git log <previous tag>..HEAD` and show them in chat. Do not write or change the changelog file until the user approves the text. Never reuse the placeholder.
- **Only changes users notice:** new features, UX changes, fixes to behavior they could hit, new platforms or formats. Leave out CI, build, signing, store-listing, docs, refactor, dependency and version-bump commits.
- **Brief:** 1 to 5 plain-text lines starting with `- `, sentence case, no trailing periods, under 500 characters, no markdown, no commit hashes. If nothing user-visible changed, write `- Bug fixes and stability improvements` (the check only rejects the exact placeholder sentence).
- Creating the new version's changelog file and running `--link` is part of the version bump (see Local Store Builds); leave previous versions' files in place.
- The Flatpak metainfo template (`build/tauri/flatpak/net.zathu.majestictab.metainfo.xml`) is filled in by `render-metainfo.mjs` from the version and these notes: add `fastlane/metadata/android/en-US/changelogs/<versionCode>.txt` for every version, or the Linux build fails.

### Flatpak Sources

The Linux build (`node build/build-tauri.mjs linux`, and CI) compiles the app inside the GNOME SDK from `build/tauri/flatpak/manifest.yml`, offline, the same way Flathub does. The offline dependency lists `build/tauri/flatpak/cargo-sources.json` and `node-sources.json` are generated from `src-tauri/Cargo.lock` and `package-lock.json`. Whenever either lockfile changes, run `build/tauri/flatpak/update-sources.sh` (needs `flatpak-node-generator` on PATH and `FLATPAK_CARGO_GENERATOR` pointing at `flatpak-cargo-generator.py`, both from github.com/flatpak/flatpak-builder-tools) and commit the result; CI's Linux build fails when they are stale. The Flathub submission manifest and its copies of these two files are kept outside this repo, so refresh them from here before updating Flathub.

### Area-specific guides

- Jam mode (`src/jam/`, host/client sync): see `src/jam/AGENTS.md`.
- Native Tauri shell and iOS simulator: see `build/tauri/AGENTS.md`.
