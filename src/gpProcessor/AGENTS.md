# AlphaTab internals (GP playback and cursor)

Read when touching playback ticks, cursors or bounds lookups.

- `api.tickPosition` is on the **MIDI timeline, which expands repeats**. `masterBar.start + beat.playbackStart` is the **notation timeline** and is wrong after any repeat. Always convert with `getPlaybackTickForBeat(beat, api)` in `src/gpProcessor/gpPlayer.js` (wraps the MidiTickLookup's `getBeatStart`).
- Setting `api.tickPosition` makes AlphaTab re-place its own cursor (calling our `customCursorHandler.placeBeatCursor`). If the tick is wrong, AlphaTab overwrites any manual cursor placement; fix the tick rather than the cursor.
- `renderer.boundsLookup.staffSystems[].findBarAtPos(x)` returns a master-bar bounds object. Its per-track bars are in `.bars` (each with `.beats`), not `.beats`. `masterBar.findBeatAtPos(x)` returns a model beat.
- `boundsLookup.getBeatAtPos(x, y)` returns null in gaps, margins and headers; fall back to the nearest system, then the vertically closest track bar, then the nearest beat by x.
- `boundsLookup.findBeat(beat)` only resolves beats for tracks currently rendered.
- The `.at-cursors` layer and `.gp-reader-cursor` show from load, as in AlphaTab, with the cursor at the start of the score.
- Public AlphaTab fields are minified (`Qw`, `vy`, `Ny`); avoid depending on them, and if unavoidable, route through a single helper such as `getMidiTickLookup()`.
