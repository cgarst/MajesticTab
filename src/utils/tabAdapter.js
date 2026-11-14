// tabAdapter.js
// Re-fingers a tab written for one tuning so it can be played on another instrument tuning
// (optionally with a capo) while every note keeps its sounding pitch.
// Three layers, strongest first: a temporary choice for the open song (the Guitar panel; resets when the song closes),
// a fit you saved for this song on purpose ("Save for this song"), and your usual guitar (Settings, Defaults).
import { KNOWN_TUNINGS, getActiveInstrumentTracks, isTrackPercussion, getInstrumentMode } from './tuningUtils.js';
import { getOverride, setOverride, getTabStorageId } from './sessionOverrides.js';
import { planFingering } from './fingeringPlanner.js';

const MAX_FRET = 24;
const MAX_CAPO = 9;
const MISSING_STRING_PENALTY = 12;
const MY_INSTRUMENT_KEY = 'majestictab_my_instrument';

export function getAdaptTuningOptions(instrumentMode = getInstrumentMode()) {
    const wantBass = instrumentMode === 'bass';
    return KNOWN_TUNINGS.filter(t => /\bbass\b/i.test(t.name) === wantBass);
}

export function findAdaptTuning(shortName) {
    return KNOWN_TUNINGS.find(t => t.shortName === shortName) || null;
}

/** Last tuning/method the user picked; used as the starting point when opting a new tab in. */
export function getMyInstrument() {
    try {
        const raw = localStorage.getItem(MY_INSTRUMENT_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed && findAdaptTuning(parsed.tuningName)) return parsed;
    } catch { /* fall through */ }
    return { tuningName: 'D Standard', method: 'shift', capo: 'auto' };
}

export function setMyInstrument({ tuningName, method, capo }) {
    try {
        localStorage.setItem(MY_INSTRUMENT_KEY, JSON.stringify({ tuningName, method, capo }));
    } catch (e) {
        console.warn('Could not save instrument preference:', e);
    }
}

const USUAL_GUITAR_KEY = 'majestictab_usual_guitar';

/** Your usual guitar for new songs, or null when songs open as written. */
export function getUsualGuitar() {
    try {
        const raw = localStorage.getItem(USUAL_GUITAR_KEY);
        const pref = raw ? JSON.parse(raw) : null;
        if (pref?.enabled && findAdaptTuning(pref.tuningName)) return pref;
    } catch { /* fall through */ }
    return null;
}

function songKey(file) {
    const id = getTabStorageId(file);
    return id ? `gp_tab_adapt_${String(id).toLowerCase().replace(/[^a-z0-9_-]/g, '_')}` : null;
}

/** The fit saved for this song on purpose: undefined (nothing saved), null (saved "as written") or a pref. */
export function getSongGuitar(file) {
    const key = songKey(file);
    if (!key) return undefined;
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return undefined;
        const pref = JSON.parse(raw);
        if (!pref?.enabled) return null;
        return findAdaptTuning(pref.tuningName) ? pref : undefined;
    } catch { return undefined; }
}

/** Pass undefined to forget it, null to save "as written", or a pref. */
export function setSongGuitar(file, pref) {
    const key = songKey(file);
    if (!key) return;
    try {
        if (pref === undefined) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify(pref && pref.enabled ? pref : { enabled: false }));
    } catch (e) {
        console.warn('Could not save the guitar fit for this song:', e);
    }
}

/**
 * How this tab is fitted to the guitar in your hands: the temporary choice for the open song (null means "as written"),
 * else the fit saved for this song, else your usual guitar, else null.
 */
export function getTabAdaptPref(file) {
    const temporary = getOverride(file, 'adapt');
    if (temporary !== undefined) return temporary && temporary.enabled && findAdaptTuning(temporary.tuningName) ? temporary : null;
    const saved = getSongGuitar(file);
    if (saved !== undefined) return saved;
    return getUsualGuitar();
}

/** Temporary only: never written to storage. Pass null for "as written". */
export function setTabAdaptPref(file, pref) {
    setOverride(file, 'adapt', pref && pref.enabled ? pref : null);
}

/** True when the open song differs from your usual guitar because of a temporary choice. */
export function hasTemporaryAdapt(file) {
    return getOverride(file, 'adapt') !== undefined;
}

function forEachNote(staff, fn) {
    for (const bar of (staff.bars || [])) {
        for (const voice of (bar.voices || [])) {
            for (const beat of (voice.beats || [])) {
                fn(beat, beat.notes || []);
            }
        }
    }
}

/** Calls fn with the notes of every moment of the staff; voices that sound together in a bar arrive as one moment. */
function forEachMoment(staff, fn) {
    for (const bar of (staff.bars || [])) {
        const moments = [];
        const byStart = new Map();
        (bar.voices || []).forEach((voice, vi) => {
            (voice.beats || []).forEach((beat, bi) => {
                const t = Number.isFinite(beat.playbackStart) ? beat.playbackStart : null;
                const key = t === null ? `v${vi}:${bi}` : t;
                let m = byStart.get(key);
                if (!m) { m = { t, notes: [] }; byStart.set(key, m); moments.push(m); }
                m.notes.push(...(beat.notes || []));
            });
        });
        if (moments.every(x => x.t !== null)) moments.sort((a, b) => a.t - b.t);
        for (const mo of moments) fn(mo.notes);
    }
}

function isStringedNote(note) {
    return note.isStringed !== undefined ? note.isStringed : (note.string > 0 && note.fret >= 0);
}

function getPitchedStaves(score, instrumentMode) {
    const out = [];
    for (const { track } of getActiveInstrumentTracks(score, instrumentMode)) {
        if (isTrackPercussion(track)) continue;
        for (const staff of (track.staves || [])) {
            if (staff.isPercussion || !staff.stringTuning) continue;
            out.push({ track, staff });
        }
    }
    return out;
}

/** Puts every adapted staff back to the tuning, capo and note positions it was loaded with. */
export function restoreScoreAdaptation(score, instrumentMode = getInstrumentMode()) {
    if (!score || !Array.isArray(score.tracks)) return;
    for (const { track, staff } of getPitchedStaves(score, instrumentMode)) {
        const orig = staff._adaptOrig;
        if (!orig) continue;
        staff.stringTuning.tunings = [...orig.tunings];
        staff.stringTuning.name = orig.name;
        if (typeof staff.stringTuning.finish === 'function') staff.stringTuning.finish();
        staff.capo = orig.capo;
        if (Array.isArray(track.tuning)) track.tuning = [...orig.tunings];
        forEachNote(staff, (beat, notes) => {
            for (const note of notes) {
                if (!note._adaptOrig) continue;
                note.string = note._adaptOrig.string;
                note.fret = note._adaptOrig.fret;
                if (note._adaptOrig.style !== undefined) note.style = note._adaptOrig.style;
                delete note._adaptOrig;
                delete note._adaptNew;
            }
        });
        delete staff._adaptOrig;
    }
    // Staves that were transposed at the synth level (non-guitar tracks) go back to their loaded pitch
    for (const track of score.tracks) {
        for (const staff of (track.staves || [])) {
            if (staff._adaptOrigTransposition === undefined) continue;
            staff.transpositionPitch = staff._adaptOrigTransposition;
            delete staff._adaptOrigTransposition;
        }
    }
}

function pickAlignment(tab, player, pitches) {
    const n = tab.length;
    const m = player.length;
    let best = null;
    for (let k = -(n - 1); k <= m - 1; k++) {
        let playable = 0;
        for (const { i, pitch } of pitches) {
            const j = i + k;
            if (j < 0 || j >= m) continue;
            const fret = pitch - player[j];
            if (fret >= 0 && fret <= MAX_FRET) playable++;
        }
        let offsetCost = 0;
        for (let i = 0; i < n; i++) {
            const j = i + k;
            offsetCost += (j < 0 || j >= m) ? MISSING_STRING_PENALTY : Math.abs(tab[i] - player[j]);
        }
        const better = !best
            || playable > best.playable
            || (playable === best.playable && (offsetCost < best.offsetCost
                || (offsetCost === best.offsetCost && Math.abs(k) < Math.abs(best.k))));
        if (better) best = { k, playable, offsetCost };
    }
    return best.k;
}

/** The capo that lines the most strings up with the tab, i.e. the most common pitch offset. */
function pickAutoCapo(tab, player, k) {
    const counts = new Map();
    for (let i = 0; i < tab.length; i++) {
        const j = i + k;
        if (j < 0 || j >= player.length) continue;
        const offset = tab[i] - player[j];
        counts.set(offset, (counts.get(offset) || 0) + 1);
    }
    let bestOffset = 0;
    let bestCount = -1;
    for (const [offset, count] of counts) {
        if (offset < 0 || offset > MAX_CAPO) continue;
        if (count > bestCount || (count === bestCount && offset < bestOffset)) {
            bestOffset = offset;
            bestCount = count;
        }
    }
    return bestCount > 0 ? bestOffset : 0;
}

/** How many semitones the retune moves the sound: the most common pitch difference between aligned strings. */
function pickTransposeSemitones(tab, player, shift) {
    const counts = new Map();
    for (let i = 0; i < tab.length; i++) {
        const j = i + shift;
        if (j < 0 || j >= player.length) continue;
        const diff = player[j] - tab[i];
        counts.set(diff, (counts.get(diff) || 0) + 1);
    }
    let best = 0;
    let bestCount = 0;
    for (const [diff, count] of counts) {
        if (count > bestCount || (count === bestCount && Math.abs(diff) < Math.abs(best))) {
            best = diff;
            bestCount = count;
        }
    }
    return best;
}

/** Moves every non-percussion staff the retune did not touch by the same interval, so the band stays in key. */
function transposeRemainingStaves(score, adaptedStaves, semitones) {
    if (!semitones) return;
    for (const track of score.tracks) {
        if (isTrackPercussion(track)) continue;
        for (const staff of (track.staves || [])) {
            if (staff.isPercussion || adaptedStaves.has(staff)) continue;
            if (staff._adaptOrigTransposition === undefined) staff._adaptOrigTransposition = staff.transpositionPitch || 0;
            // AlphaTab sounds a staff at the negative of its transpositionPitch
            staff.transpositionPitch = staff._adaptOrigTransposition - semitones;
        }
    }
}

function adaptStaff(track, staff, pref, tuning) {
    const orig = staff._adaptOrig;
    const tab = orig.tunings;
    const player = tuning.midi;
    const n = tab.length;
    const m = player.length;

    // Collect pitches once; tab string index i is high-to-low (AlphaTab string 1 = lowest = index n-1)
    const pitches = [];
    forEachNote(staff, (beat, notes) => {
        for (const note of notes) {
            const o = note._adaptOrig;
            if (!o || !isStringedNote(note) || o.string < 1 || o.string > n) continue;
            const i = n - o.string;
            pitches.push({ i, pitch: tab[i] + o.fret + orig.capo });
        }
    });

    if (pref.method === 'transpose') {
        // Same strings and frets, new tuning: every note sounds lower (or higher) by the tuning difference
        const shift = pickAlignment(tab, player, []);
        const semitones = pickTransposeSemitones(tab, player, shift);
        let moved = 0;
        forEachNote(staff, (beat, notes) => {
            for (const note of notes) {
                const o = note._adaptOrig;
                if (!o || !isStringedNote(note) || o.string < 1 || o.string > n) continue;
                const j = Math.min(m - 1, Math.max(0, n - o.string + shift));
                note.string = m - j;
                note._adaptNew = { j, fret: o.fret + orig.capo };
                moved++;
            }
        });
        staff.stringTuning.tunings = [...player];
        staff.stringTuning.name = tuning.shortName;
        if (typeof staff.stringTuning.finish === 'function') staff.stringTuning.finish();
        if (Array.isArray(track.tuning)) track.tuning = [...player];
        return { notes: moved, remapped: 0, unplayable: 0, harmonics: 0, capo: orig.capo, from: tab, to: player, semitones };
    }

    const k = pickAlignment(tab, player, pitches);
    let capo = 0;
    if (pref.method === 'capo') {
        capo = Number.isInteger(pref.capo) ? Math.min(MAX_CAPO, Math.max(0, pref.capo)) : pickAutoCapo(tab, player, k);
    }

    const summary = { notes: 0, remapped: 0, unplayable: 0, harmonics: 0 };

    // One unit per moment in time (voices that sound together share a hand), then one plan for the whole staff
    const units = [];
    const refs = [];
    forEachMoment(staff, (notes) => {
        const unit = [];
        const ref = [];
        for (const note of notes) {
            const o = note._adaptOrig;
            if (!o || !isStringedNote(note) || o.string < 1 || o.string > n) continue;
            const i = n - o.string;
            const staticJ = i + k;
            const link = note.isTieDestination ? note.tieOrigin : (note.slideOrigin || note.hammerPullOrigin);
            const harmonic = note.harmonicType && note.harmonicType !== 0 && staticJ >= 0 && staticJ < m;
            unit.push({
                pitch: tab[i] + o.fret + orig.capo,
                staticJ,
                srcFretted: o.fret > 0,
                // Harmonic nodes are fret positions, so keep the position relative to the capo
                fixed: harmonic ? { j: staticJ, fret: Math.max(0, o.fret) } : undefined,
                id: note,
                linkId: link || undefined
            });
            ref.push({ note, staticJ, harmonic });
        }
        if (unit.length) { units.push({ notes: unit }); refs.push(ref); }
    });
    const plan = planFingering({ units, player, capo, maxFret: MAX_FRET });
    plan.units.forEach((placed, ui) => {
        placed.forEach((p, q) => {
            const { note, staticJ, harmonic } = refs[ui][q];
            note.string = m - p.j;
            // AlphaTab stores frets relative to the capo
            note.fret = p.fret;
            note._adaptNew = { j: p.j, fret: p.fret + capo };
            summary.notes++;
            if (harmonic) summary.harmonics++;
            else if (p.j !== staticJ) summary.remapped++;
            if (p.shift !== 0 || p.parked) summary.unplayable++;
        });
    });

    staff.stringTuning.tunings = [...player];
    staff.stringTuning.name = tuning.shortName;
    if (typeof staff.stringTuning.finish === 'function') staff.stringTuning.finish();
    staff.capo = capo;
    if (Array.isArray(track.tuning)) track.tuning = [...player];

    return { ...summary, capo, from: tab, to: player };
}

/**
 * Applies (or, with a null pref, removes) the adaptation on every pitched staff of the active
 * instrument. Returns a summary of what changed, or null when nothing was adapted.
 */
export function applyScoreAdaptation(score, pref, instrumentMode = getInstrumentMode()) {
    if (!score || !Array.isArray(score.tracks)) return null;
    restoreScoreAdaptation(score, instrumentMode);
    const tuning = pref?.enabled ? findAdaptTuning(pref.tuningName) : null;
    if (!tuning) return null;

    const total = { notes: 0, remapped: 0, unplayable: 0, harmonics: 0, capo: 0, from: null, to: tuning.midi };
    let adapted = false;
    let semitones = 0;
    const adaptedStaves = new Set();
    for (const { track, staff } of getPitchedStaves(score, instrumentMode)) {
        const tunings = Array.isArray(staff.stringTuning.tunings) ? [...staff.stringTuning.tunings] : [];
        if (tunings.length === 0) continue;
        staff._adaptOrig = { tunings, capo: staff.capo || 0, name: staff.stringTuning.name || '' };
        forEachNote(staff, (beat, notes) => {
            for (const note of notes) {
                if (isStringedNote(note)) note._adaptOrig = { string: note.string, fret: note.fret, style: note.style };
            }
        });
        const result = adaptStaff(track, staff, pref, tuning);
        total.notes += result.notes;
        total.remapped += result.remapped;
        total.unplayable += result.unplayable;
        total.harmonics += result.harmonics;
        total.capo = Math.max(total.capo, result.capo);
        total.from = total.from || result.from;
        if (!semitones && result.semitones) semitones = result.semitones;
        adaptedStaves.add(staff);
        adapted = true;
    }
    if (adapted && pref.method === 'transpose') transposeRemainingStaves(score, adaptedStaves, semitones);
    return adapted ? total : null;
}
