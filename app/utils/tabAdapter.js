// tabAdapter.js
// Re-fingers a tab written for one tuning so it can be played on another instrument tuning
// (optionally with a capo) while every note keeps its sounding pitch. Opt-in per tab.
import { KNOWN_TUNINGS, getActiveInstrumentTracks, isTrackPercussion, getTabStorageId, getInstrumentMode } from './tuningUtils.js';

const MAX_FRET = 24;
const MAX_CAPO = 9;
const MISSING_STRING_PENALTY = 12;
const MY_INSTRUMENT_KEY = 'majestictab_my_instrument';

export const ADAPT_METHODS = ['shift', 'capo', 'transpose'];

export function getAdaptTuningOptions(instrumentMode = getInstrumentMode()) {
    const wantBass = instrumentMode === 'bass';
    return KNOWN_TUNINGS.filter(t => /\bbass\b/i.test(t.name) === wantBass);
}

export function findAdaptTuning(shortName) {
    return KNOWN_TUNINGS.find(t => t.shortName === shortName) || null;
}

function storageKey(file) {
    const id = getTabStorageId(file);
    return id ? `gp_tab_adapt_${String(id).toLowerCase().replace(/[^a-z0-9_-]/g, '_')}` : null;
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

/** Per-tab adaptation preference, or null when the tab has not opted in. */
export function getTabAdaptPref(file) {
    const key = storageKey(file);
    if (!key) return null;
    try {
        const raw = localStorage.getItem(key);
        const pref = raw ? JSON.parse(raw) : null;
        if (pref?.enabled && findAdaptTuning(pref.tuningName)) return pref;
    } catch { /* fall through */ }
    return null;
}

export function setTabAdaptPref(file, pref) {
    const key = storageKey(file);
    if (!key) return;
    try {
        if (!pref || !pref.enabled) {
            localStorage.removeItem(key);
        } else {
            localStorage.setItem(key, JSON.stringify(pref));
        }
    } catch (e) {
        console.warn('Could not save tab adaptation preference:', e);
    }
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
    let lastFret = capo + 5;

    forEachNote(staff, (beat, notes) => {
        const used = new Set();
        const jobs = [];
        for (const note of notes) {
            const o = note._adaptOrig;
            if (!o || !isStringedNote(note) || o.string < 1 || o.string > n) continue;
            const i = n - o.string;
            const pitch = tab[i] + o.fret + orig.capo;
            const staticJ = i + k;
            const link = note.isTieDestination ? note.tieOrigin : (note.slideOrigin || note.hammerPullOrigin);
            jobs.push({ note, i, pitch, staticJ, preferJ: link?._adaptNew?.j, tied: !!(note.isTieDestination && link?._adaptNew), link, orig: o });
        }

        const place = (job, j, fret, remapped) => {
            used.add(j);
            job.note.string = m - j;
            // AlphaTab stores frets relative to the capo
            job.note.fret = fret - capo;
            job.note._adaptNew = { j, fret };
            if (remapped) summary.remapped++;
            lastFret = fret;
            job.done = true;
        };
        const fretFor = (job, j) => job.pitch - player[j];
        const valid = (j, fret) => j >= 0 && j < m && !used.has(j) && fret >= capo && fret <= MAX_FRET;
        summary.notes += jobs.length;

        for (const job of jobs) {
            const harmonic = job.note.harmonicType && job.note.harmonicType !== 0;
            if (harmonic && job.staticJ >= 0 && job.staticJ < m && !used.has(job.staticJ)) {
                // Harmonic nodes are fret positions, so keep the position relative to the capo
                summary.harmonics++;
                place(job, job.staticJ, Math.max(0, job.orig.fret) + capo, false);
                continue;
            }
            if (job.tied) {
                const { j, fret } = job.link._adaptNew;
                if (!used.has(j)) place(job, j, fret, false);
            }
        }
        for (const job of jobs) {
            if (job.done || job.preferJ === undefined) continue;
            const fret = fretFor(job, job.preferJ);
            if (valid(job.preferJ, fret)) place(job, job.preferJ, fret, job.preferJ !== job.staticJ);
        }
        for (const job of jobs) {
            if (job.done) continue;
            const fret = fretFor(job, job.staticJ);
            if (valid(job.staticJ, fret)) place(job, job.staticJ, fret, false);
        }
        for (const job of jobs) {
            if (job.done) continue;
            let choice = null;
            for (let j = 0; j < m; j++) {
                const fret = fretFor(job, j);
                if (!valid(j, fret)) continue;
                const cost = Math.abs(fret - lastFret) * 100 + Math.abs(j - job.staticJ);
                if (!choice || cost < choice.cost) choice = { j, fret, cost };
            }
            if (choice) {
                place(job, choice.j, choice.fret, true);
                continue;
            }
            // Out of range on every string: fold by octaves so the note stays visible, and flag it
            for (const shift of [12, -12, 24, -24]) {
                for (let j = 0; j < m && !job.done; j++) {
                    const fret = fretFor(job, j) + shift;
                    if (valid(j, fret)) place(job, j, fret, false);
                }
                if (job.done) break;
            }
            if (!job.done) {
                const j = [...Array(m).keys()].find(x => !used.has(x)) ?? 0;
                place(job, j, Math.min(MAX_FRET, Math.max(capo, fretFor(job, j))), false);
            }
            summary.unplayable++;
        }
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
