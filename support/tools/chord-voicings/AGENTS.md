# Chord voicings (reference library)

Read before changing chord data or the rules.

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
