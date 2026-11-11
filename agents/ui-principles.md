# UI principles

Read before adding or changing any screen. Companions: `ui-layout.md`, `ui-themes.md`, `ui-copy.md`; for the reader see `reader.md`.

MajesticTab's look: the app recedes and the score leads. These rules are requirements for every new or changed screen, on all five targets (Windows, macOS, Linux, Android, iOS). All look CSS lives in `src/design.css`; it loads after `src/style.css` and overrides it. Put new styles there, not in `style.css`.

**Look**
- **Flat only.** No gradients, glass, `backdrop-filter`, glow or shadows on things at rest. Shadows are for what truly floats (menus, dialogs). Scrims dim; they do not blur.
- **Tone steps, not outlines.** Separate surfaces with the ground ladder (`--ground`, `--s1`, `--s2`, `--s3`), never with 1px borders, dashed boxes, hairline dividers or outlined cards. A selected or hovered row takes one tone step. Boxed toolbars and bordered cards are not allowed.
- **Color sits on three things only:** the one primary action, the playhead (and loop band), and the active-item inlay dot. Everything else is ink (`--ink`, `--ink2`) on the ground ladder. Use the theme tokens; never hard-code hex values. The one deliberate exception is the six section families on the bar ruler (see `reader.md`): a hue at low chroma on the block's own surface, so a chorus looks like a chorus in every song. Nothing else may take a hue.
- **No pills.** Counts, tunings, years, page ranges and statuses are plain grey text beside what they describe, separated by a middle dot. A filled shape is only for a real control (a filter, a switch) or a key cap. Do not add `badge`, `chip` or `rounded-pill` for metadata.
- **No decorative glyphs.** An icon appears only where it carries meaning that the label does not (navigation, play, pin, status dot). No icon beside a text button, no tinted icon squares, no emoji.
- **Type.** System font for UI text. Barlow Condensed (`--font-display`) only for song titles, section titles and big numerals. Sentence case for labels, headings and actions. No small uppercase tracked labels, no eyebrows above headings, no index numbering unless the content is a sequence.
- **Radius follows the platform** through `--r-control` and `--r-card` (set per platform at the top of `design.css`: rounder on macOS and iOS, tighter on Windows and Linux). Do not hard-code radii. Press feedback follows the platform too: a tonal layer on Android, scale-on-press on iOS, a 1px nudge on desktop.
- **The notation is never restyled.** AlphaTab output is drawn as it is. The app only supplies the paper behind it, the zoom and the playhead layer.

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
