# Themes and themed controls

Read when adding or changing a theme, a button, a modal or a form control. Visual rules: `ui-principles.md`.

## Theme grounds

A dark theme's surfaces are a deep tint of its own hue, not near-black: the ground sits at about 8-16% lightness with visible chroma (Slate Blue, Ember Glow). Only Dark Side is neutral black. Build the ladder from the ground: elevated darker than the ground, then card, then hover with the biggest step, since tone steps carry all separation and must stay visible. Keep the accent and secondary colours from the theme's identity, and tint `--text-muted` and `--text-dim` toward the hue so they stay at 4.5:1 or better on the lighter ground. Define the tokens in `src/style.css` and keep `bg` in `THEMES` (`src/themeEngine.js`) equal to `--bg-body`: it feeds the browser theme colour, the Android system bars and the picker swatch. Do not use pastel accents on dark grounds unless the button labels switch to dark ink.

Verify every new or changed screen in at least two themes, one of them Snow White, and check that active, inactive, hover and disabled states stay legible in each.

## Themed controls

Button colors live in `src/design.css` (tone steps, no borders, no gradient or glow). The classes keep the Bootstrap-era names.

- **Never use Bootstrap's color button classes** (`btn-primary`, `btn-secondary`, `btn-danger`, `btn-success`, `btn-info`, `btn-warning`, `btn-light`, `btn-dark` and every `btn-outline-*`). They hard-code colors (e.g. `#0d6efd`) that ignore `data-theme`.
- **Use the themed classes:**
  - `btn-theme-primary`: the one primary action on a screen (`--action` ground, `--on-action` label).
  - `btn-theme-outline` and `theme-control-btn`: secondary actions, one tone step up (`--s3`). The name is historical: there is no outline.
  - `btn-theme-icon`: compact icon-only control, bare until hover. Needs an accessible name.
  - `btn-theme-danger`: destructive actions, in a Danger zone, with a second press (`.is-confirming`) or a confirmation.
  - `btn-theme-success`: affirmative actions (rare; there is only one primary).
- **Modals** use the themed containers (`.theme-modal-backdrop`, `.theme-modal-card`, `.theme-modal-header`, `.theme-modal-body`, `.theme-modal-footer`, `.brand-btn.theme-modal-close-btn`). Confirm is `btn-theme-primary`; cancel is a text or `btn-theme-outline` action. A scrim dims, it never blurs.
- **Form controls** reuse the theme styles: `.form-control`, `.form-select`, `.form-check-input.theme-switch`.
