// classtab/txtMidiAlign.js
// Zero-tap alignment between a parsed classical .txt tab (systems + visual bars) and either an attached .mid file
// (Tier A symbolic pitch-class alignment / Tier B bar-number mapping) or a steady Bar-Paced Clock (Tier C).

const NOTE_SEMITONES = {
    C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5,
    'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11
};

// Default standard guitar open-string MIDI pitches, ordered high string (1st) to low string (6th)
const DEFAULT_HIGH_TO_LOW_MIDI = [64, 59, 55, 50, 45, 40];

/**
 * Converts a tuning string (low-to-high like "D A D G B E" or "Drop D") and optional capo fret
 * into an array of 6 open-string pitch classes (0..11) ordered high string (1st) to low string (6th).
 */
export function openStringPitchClasses(tuning, capoFret = 0) {
    const capo = Number.isFinite(capoFret) ? Math.max(0, Math.round(capoFret)) : 0;
    let lowToHigh = ['E', 'A', 'D', 'G', 'B', 'E'];
    if (typeof tuning === 'string' && tuning.trim()) {
        const t = tuning.trim();
        if (/^drop\s*d$/i.test(t)) {
            lowToHigh = ['D', 'A', 'D', 'G', 'B', 'E'];
        } else if (/^dadgad$/i.test(t)) {
            lowToHigh = ['D', 'A', 'D', 'G', 'A', 'D'];
        } else {
            const tokens = t.match(/[A-G][#b]?/g);
            if (tokens && tokens.length >= 6) lowToHigh = tokens.slice(0, 6);
        }
    }
    const highToLow = lowToHigh.slice().reverse();
    return highToLow.map((n, idx) => {
        const base = NOTE_SEMITONES[n] ?? (DEFAULT_HIGH_TO_LOW_MIDI[idx] % 12);
        return (base + capo) % 12;
    });
}

/**
 * Computes a 12-bit pitch-class bitmask (bits 0..11) for a bar's noteOnsets.
 */
function barPitchMask(noteOnsets, stringPcs) {
    let mask = 0;
    if (!Array.isArray(noteOnsets)) return 0;
    for (const onset of noteOnsets) {
        for (const f of onset.frets || []) {
            const sIdx = (f.string - 1) % stringPcs.length;
            const pc = (stringPcs[sIdx] + f.fret) % 12;
            mask |= (1 << pc);
        }
    }
    return mask;
}

function rotateMask12(mask, shift) {
    const s = ((shift % 12) + 12) % 12;
    if (s === 0) return mask;
    return ((mask << s) | (mask >>> (12 - s))) & 0xfff;
}

function popcount12(x) {
    let c = 0;
    let v = x & 0xfff;
    while (v) {
        v &= v - 1;
        c++;
    }
    return c;
}

function maskSimilarity(m1, m2) {
    if (m1 === 0 && m2 === 0) return 0.5;
    if (m1 === 0 || m2 === 0) return 0.05;
    const inter = popcount12(m1 & m2);
    const union = popcount12(m1 | m2);
    return union > 0 ? inter / union : 0;
}

/**
 * Extracts all visual bars from the playable systems of `blocks` (for the given `version`)
 * and unfolds repeats (`||* ... *||`, `1.`/`2.` endings, `D.C.`/`Fine`).
 */
export function unfoldVisualBars(blocks, { version = 1, tuning = null, capoFret = 0 } = {}) {
    const stringPcs = openStringPitchClasses(tuning, capoFret);
    const visualBars = [];

    let sysOrdinal = 0;
    let pendingPlayTwiceStart = false;
    let inPlayTwiceSection = false;

    for (let bIdx = 0; bIdx < blocks.length; bIdx++) {
        const blk = blocks[bIdx];
        if (blk.kind === 'line') {
            if (/\bplay\s+twice\b/i.test(blk.text || '')) {
                if (inPlayTwiceSection && visualBars.length > 0) {
                    visualBars[visualBars.length - 1].repeatEnd = true;
                }
                pendingPlayTwiceStart = true;
                inPlayTwiceSection = true;
            }
            continue;
        }
        if (blk.kind !== 'system') continue;
        if (blk.version && blk.version !== version) continue;

        if (!pendingPlayTwiceStart && Array.isArray(blk.above) && blk.above.some(l => /\bplay\s+twice\b/i.test(l))) {
            if (inPlayTwiceSection && visualBars.length > 0) {
                visualBars[visualBars.length - 1].repeatEnd = true;
            }
            pendingPlayTwiceStart = true;
            inPlayTwiceSection = true;
        }

        const bars = blk.bars || [];
        const trimCols = blk.trimCols || 0;
        const maxCol = bars.length ? bars[bars.length - 1].colEnd : 1;
        const totalSpan = Math.max(1, maxCol - trimCols);

        // Compute median bar width on the system to detect narrow pickup bars
        let sysMedianWidth = totalSpan / Math.max(1, bars.length);
        if (bars.length >= 2) {
            const widths = bars.map(b => b.colEnd - b.colStart).slice().sort((a, b) => a - b);
            sysMedianWidth = widths[Math.floor(widths.length / 2)] || sysMedianWidth;
        }

        for (let k = 0; k < bars.length; k++) {
            const bar = bars[k];
            const prevBarInSys = k > 0 ? bars[k - 1] : null;
            const prevVisualBar = visualBars.length > 0 ? visualBars[visualBars.length - 1] : null;
            const width = Math.max(1, bar.colEnd - bar.colStart);
            const widthRatio = width / Math.max(1, sysMedianWidth);
            const repeatStart = Boolean(bar.repeatStart) || (k === 0 && pendingPlayTwiceStart);
            if (k === 0 && pendingPlayTwiceStart) pendingPlayTwiceStart = false;

            const isSectionStart = (sysOrdinal === 0 && k === 0)
                || repeatStart
                || Boolean(prevBarInSys?.repeatEnd)
                || Boolean(prevVisualBar?.repeatEnd);
            const isPickup = (sysOrdinal === 0 && k === 0 && (bar.barNumber === 0 || (bars.length >= 2 && widthRatio < 0.6)))
                || (isSectionStart && bars.length >= 2 && widthRatio < 0.48);
            const colStartFrac = Math.max(0, Math.min(1, (bar.colStart - trimCols) / totalSpan));
            const colEndFrac = Math.max(colStartFrac, Math.min(1, (bar.colEnd - trimCols) / totalSpan));
            const vIdx = visualBars.length;

            visualBars.push({
                visualIndex: vIdx,
                systemIndex: sysOrdinal,
                blockId: String(bIdx),
                barOffset: k,
                barCountInSystem: bars.length,
                colStart: bar.colStart,
                colEnd: bar.colEnd,
                colStartFrac,
                colEndFrac,
                widthRatio,
                isPickup,
                barNumber: bar.barNumber !== null && bar.barNumber !== undefined ? bar.barNumber : (vIdx + 1),
                repeatStart,
                repeatEnd: Boolean(bar.repeatEnd),
                doubleBar: Boolean(bar.doubleBar),
                ending: bar.ending || null,
                noteOnsets: bar.noteOnsets || [],
                pitchMask: barPitchMask(bar.noteOnsets, stringPcs),
                directives: k === bars.length - 1 ? (blk.directives || {}) : {}
            });
        }
        sysOrdinal++;
    }

    if (inPlayTwiceSection && visualBars.length > 0) {
        visualBars[visualBars.length - 1].repeatEnd = true;
    }

    // Assign monotonic 1-based display bar numbers while keeping pickup flag
    for (let i = 0; i < visualBars.length; i++) {
        visualBars[i].displayBarNumber = i + 1;
    }

    // Unfold repeats (`||* ... *||`, 1st/2nd endings, and D.C. al Fine)
    const unfoldedBars = [];
    const maxUnfolded = Math.max(64, visualBars.length * 4);
    let repeatAnchor = 0;
    let firstEndingIdx = -1;
    const takenRepeatEnds = new Set();
    let inRepeatPass = false;
    let i = 0;

    while (i < visualBars.length && unfoldedBars.length < maxUnfolded) {
        const vb = visualBars[i];
        if (vb.repeatStart && !inRepeatPass) {
            repeatAnchor = i;
            firstEndingIdx = -1;
        }
        if (vb.ending === 1 && !inRepeatPass) {
            firstEndingIdx = i;
        }
        if (inRepeatPass && firstEndingIdx !== -1 && i === firstEndingIdx) {
            // Skip 1st ending bars on the repeat pass; jump to 2nd ending
            let nextIdx = i + 1;
            while (nextIdx < visualBars.length && visualBars[nextIdx].ending !== 2 && !visualBars[nextIdx].repeatStart) {
                if (visualBars[nextIdx - 1]?.repeatEnd) break;
                nextIdx++;
            }
            inRepeatPass = false;
            firstEndingIdx = -1;
            if (nextIdx < visualBars.length) {
                repeatAnchor = nextIdx + 1;
                i = nextIdx;
                continue;
            }
        }

        unfoldedBars.push({
            playIndex: unfoldedBars.length,
            visualBar: vb
        });

        if (vb.repeatEnd && !takenRepeatEnds.has(i)) {
            takenRepeatEnds.add(i);
            inRepeatPass = true;
            i = repeatAnchor;
            continue;
        }
        if (vb.repeatEnd && inRepeatPass) {
            inRepeatPass = false;
            repeatAnchor = i + 1;
            firstEndingIdx = -1;
        }
        i++;
    }

    // Handle D.C. (Da Capo) at the end of the piece if present
    if (visualBars.length > 0 && visualBars[visualBars.length - 1].directives?.dc) {
        const fineIdx = visualBars.findIndex(b => b.directives?.fine);
        const stopAt = fineIdx >= 0 ? fineIdx : Math.min(visualBars.length - 1, Math.floor(visualBars.length / 2));
        for (let k = 0; k <= stopAt && unfoldedBars.length < maxUnfolded; k++) {
            unfoldedBars.push({
                playIndex: unfoldedBars.length,
                visualBar: visualBars[k]
            });
        }
    }

    return { visualBars, unfoldedBars };
}

/**
 * Aligns a sequence of tab bars (`seqBars`, each with `.visualBar.pitchMask`) against `midiBars`
 * using transposition-invariant pitch-class similarity and monotone dynamic programming (DTW).
 */
function alignBarSequences(seqBars, midiBars, midiNotes) {
    const P = seqBars.length;
    const M = midiBars.length;
    if (P === 0 || M === 0) return [];

    // Build pitch-class bitmasks for each MIDI bar
    const midiMasks = new Array(M).fill(0);
    let nIdx = 0;
    for (let m = 0; m < M; m++) {
        const sTick = midiBars[m].startTick;
        const eTick = midiBars[m].endTick;
        while (nIdx < midiNotes.length && midiNotes[nIdx].tick < sTick) nIdx++;
        let k = nIdx;
        let mask = 0;
        while (k < midiNotes.length && midiNotes[k].tick < eTick) {
            mask |= (1 << (midiNotes[k].pitch % 12));
            k++;
        }
        midiMasks[m] = mask;
    }

    // Find best transposition shift (0..11), slightly favoring shift = 0
    let bestShift = 0;
    let bestShiftScore = -1;
    const sampleLen = Math.min(P, M, 32);
    for (let shift = 0; shift < 12; shift++) {
        let sc = shift === 0 ? 0.15 : 0;
        for (let i = 0; i < sampleLen; i++) {
            const pMask = rotateMask12(seqBars[i].visualBar.pitchMask, shift);
            sc += maskSimilarity(pMask, midiMasks[i]);
        }
        if (sc > bestShiftScore) {
            bestShiftScore = sc;
            bestShift = shift;
        }
    }

    // If bar counts match within 1 bar or P * M is large, use banded DTW to find monotone mapping p -> [mStart, mEnd]
    if (P === M) {
        let totalSim = 0;
        const mapped = seqBars.map((item, idx) => {
            const pMask = rotateMask12(item.visualBar.pitchMask, bestShift);
            totalSim += maskSimilarity(pMask, midiMasks[idx]);
            return {
                ...item,
                startMs: midiBars[idx].startMs,
                endMs: midiBars[idx].endMs,
                beats: midiBars[idx].beats || 4,
                sim: maskSimilarity(pMask, midiMasks[idx])
            };
        });
        return { mapped, avgSim: totalSim / P, tier: 'A' };
    }

    // Banded DTW between P tab bars and M MIDI bars
    const dp = Array.from({ length: P }, () => new Float32Array(M).fill(-1e9));
    const prev = Array.from({ length: P }, () => new Int16Array(M).fill(0));
    const band = Math.max(12, Math.abs(P - M) + 8);

    for (let m = 0; m < Math.min(M, band); m++) {
        const pMask = rotateMask12(seqBars[0].visualBar.pitchMask, bestShift);
        dp[0][m] = maskSimilarity(pMask, midiMasks[m]) - m * 0.08;
    }

    for (let p = 1; p < P; p++) {
        const expectedM = Math.round((p * (M - 1)) / Math.max(1, P - 1));
        const mMin = Math.max(0, expectedM - band);
        const mMax = Math.min(M - 1, expectedM + band);
        const pMask = rotateMask12(seqBars[p].visualBar.pitchMask, bestShift);

        for (let m = mMin; m <= mMax; m++) {
            const sim = maskSimilarity(pMask, midiMasks[m]);
            // Transitions from p - 1: m (2 tab bars in 1 MIDI bar), m - 1 (1:1 step), m - 2 (skip 1 MIDI bar)
            let bestPrevVal = dp[p - 1][m] - 0.25;
            let bestPrevM = m;

            if (m >= 1 && dp[p - 1][m - 1] + 0.15 > bestPrevVal) {
                bestPrevVal = dp[p - 1][m - 1] + 0.15;
                bestPrevM = m - 1;
            }
            if (m >= 2 && dp[p - 1][m - 2] - 0.2 > bestPrevVal) {
                bestPrevVal = dp[p - 1][m - 2] - 0.2;
                bestPrevM = m - 2;
            }
            dp[p][m] = bestPrevVal + sim;
            prev[p][m] = bestPrevM;
        }
    }

    // Backtrack from best ending m near M - 1
    let curM = M - 1;
    let bestEndVal = dp[P - 1][M - 1];
    for (let m = Math.max(0, M - 4); m < M; m++) {
        if (dp[P - 1][m] > bestEndVal) {
            bestEndVal = dp[P - 1][m];
            curM = m;
        }
    }

    const assignedM = new Array(P);
    for (let p = P - 1; p >= 0; p--) {
        assignedM[p] = curM;
        curM = prev[p][curM];
    }

    // Convert assignedM into monotonic [startMs, endMs] spans, subdividing evenly when consecutive p share the same m
    const mapped = [];
    let totalSim = 0;
    let p = 0;
    while (p < P) {
        let q = p;
        while (q + 1 < P && assignedM[q + 1] === assignedM[p]) q++;
        const mIdx = Math.max(0, Math.min(M - 1, assignedM[p]));
        const nextMIdx = q + 1 < P ? Math.max(mIdx, Math.min(M - 1, assignedM[q + 1] - 1)) : (p === P - 1 ? M - 1 : mIdx);
        const spanStartMs = midiBars[mIdx].startMs;
        const spanEndMs = midiBars[Math.max(mIdx, nextMIdx)].endMs;
        const count = q - p + 1;
        const sliceDur = (spanEndMs - spanStartMs) / count;

        for (let k = 0; k < count; k++) {
            const item = seqBars[p + k];
            const pMask = rotateMask12(item.visualBar.pitchMask, bestShift);
            const sim = maskSimilarity(pMask, midiMasks[mIdx]);
            totalSim += sim;
            mapped.push({
                ...item,
                startMs: spanStartMs + k * sliceDur,
                endMs: spanStartMs + (k + 1) * sliceDur,
                beats: midiBars[mIdx].beats || 4,
                sim
            });
        }
        p = q + 1;
    }

    const avgSim = totalSim / P;
    return { mapped, avgSim, tier: avgSim >= 0.2 ? 'A' : 'B' };
}

/**
 * Builds the aligned bar timeline and `textSync` points for a parsed `.txt` tab.
 *
 * @param {{
 *   blocks: Array<any>,
 *   midiData?: { bars?: Array<any>, notes?: Array<any>, primaryBpm?: number, initialTimeSig?: { num: number, den: number } } | null,
 *   tuning?: string | null,
 *   capoFret?: number,
 *   baseBpm?: number,
 *   beatUnit?: string,
 *   timeSig?: { num: number, den: number },
 *   mode?: 'midi' | 'silent',
 *   version?: number
 * }} input
 */
export function alignTxtAndMidi({
    blocks = [],
    midiData = null,
    tuning = null,
    capoFret = 0,
    baseBpm = 100,
    beatUnit = 'quarter',
    timeSig = { num: 4, den: 4 },
    mode = 'midi',
    version = 1
} = {}) {
    const { visualBars, unfoldedBars } = unfoldVisualBars(blocks, { version, tuning, capoFret });
    if (visualBars.length === 0) {
        return {
            points: [],
            barTimeline: [],
            visualBars: [],
            tier: 'C',
            hasRepeats: false,
            totalDurationMs: 0
        };
    }

    const hasMidi = Boolean(midiData && Array.isArray(midiData.bars) && midiData.bars.length > 0 && mode !== 'silent');
    let alignedSeq = [];
    let tier = 'C';
    let hasRepeats = unfoldedBars.length > visualBars.length;

    if (hasMidi) {
        const midiNotes = midiData.notes || [];
        const effTimeSig = midiData.initialTimeSig || timeSig || { num: 4, den: 4 };
        let midiBars = midiData.bars;
        let pickupBar0 = null;
        let fullMidiBars = midiBars;

        // If the MIDI file omitted a 0x58 Time Signature event (so midiData.bars defaulted to 4/4) or starts with a pickup
        // lead-in while the tab has a narrow initial pickup bar, build a time-signature-accurate MIDI bar grid.
        const hasInitialPickup = Boolean(visualBars[0]?.isPickup);
        const needCustomGrid = Boolean(
            midiData.division &&
            typeof midiData.millis === 'function' &&
            (!midiData.initialTimeSig || (hasInitialPickup && midiNotes.length > 0 && midiNotes[0].tick > 0))
        );

        if (needCustomGrid) {
            const beatTicks = Math.max(1, Math.round((midiData.division * 4) / (effTimeSig.den || 4)));
            const beatsPerBar = Math.max(1, effTimeSig.num || 4);
            const barTicks = beatTicks * beatsPerBar;
            const firstNoteTick = midiNotes[0]?.tick ?? 0;
            const lastNoteTick = midiNotes[midiNotes.length - 1]?.tick ?? midiData.lastTick ?? 0;

            let bar1Tick = 0;
            if (hasInitialPickup && firstNoteTick > 0) {
                const candBeat = Math.ceil((firstNoteTick + 1) / beatTicks) * beatTicks;
                const candBar = Math.ceil((firstNoteTick + 1) / barTicks) * barTicks;
                const tol = Math.max(1, Math.round(beatTicks / 6));
                const scoreCandidate = (startT) => {
                    let hits = 0;
                    let total = 0;
                    for (let t = startT; t <= lastNoteTick && total < 32; t += barTicks) {
                        total++;
                        if (midiNotes.some(n => Math.abs(n.tick - t) <= tol)) hits++;
                    }
                    return total > 0 ? hits / total : 0;
                };
                bar1Tick = scoreCandidate(candBeat) >= scoreCandidate(candBar) ? candBeat : candBar;
                pickupBar0 = {
                    index: 0,
                    startTick: firstNoteTick,
                    endTick: bar1Tick,
                    startMs: midiData.millis(0, firstNoteTick),
                    endMs: midiData.millis(0, bar1Tick),
                    beats: Math.max(0.5, (bar1Tick - firstNoteTick) / beatTicks),
                    num: beatsPerBar,
                    den: effTimeSig.den || 4,
                    isPickup: true
                };
            }

            const rebuiltFull = [];
            for (let t = bar1Tick; t <= lastNoteTick; t += barTicks) {
                const endT = t + barTicks;
                rebuiltFull.push({
                    index: (pickupBar0 ? 1 : 0) + rebuiltFull.length,
                    startTick: t,
                    endTick: endT,
                    startMs: midiData.millis(0, t),
                    endMs: midiData.millis(0, endT),
                    beats: beatsPerBar,
                    num: beatsPerBar,
                    den: effTimeSig.den || 4
                });
            }
            if (rebuiltFull.length > 0) {
                fullMidiBars = rebuiltFull;
                midiBars = pickupBar0 ? [pickupBar0, ...rebuiltFull] : rebuiltFull;
            }
        }

        // Compare whether the MIDI file follows the unfolded repeat sequence or the straight written bars
        const unfoldedNonPickup = unfoldedBars.filter(u => !u.visualBar.isPickup);
        const writtenSeq = visualBars.map((vb, idx) => ({ playIndex: idx, visualBar: vb }));
        const writtenNonPickup = writtenSeq.filter(u => !u.visualBar.isPickup);

        const diffUnfolded = Math.min(
            Math.abs(unfoldedBars.length - midiBars.length),
            Math.abs(unfoldedNonPickup.length - fullMidiBars.length)
        );
        const diffWritten = Math.min(
            Math.abs(writtenSeq.length - midiBars.length),
            Math.abs(writtenNonPickup.length - fullMidiBars.length)
        );

        const chosenSeq = (hasRepeats && diffUnfolded <= diffWritten + 2) ? unfoldedBars : writtenSeq;
        hasRepeats = chosenSeq === unfoldedBars && unfoldedBars.length > visualBars.length;

        const chosenNonPickup = chosenSeq.filter(u => !u.visualBar.isPickup);
        const hasInternalPickups = chosenSeq.some((u, idx) => idx > 0 && u.visualBar.isPickup);

        if ((pickupBar0 || hasInternalPickups) && Math.abs(chosenNonPickup.length - fullMidiBars.length) <= 1) {
            const fullRes = alignBarSequences(chosenNonPickup, fullMidiBars, midiNotes);
            const fullMapped = fullRes.mapped;
            const defaultPickupMs = pickupBar0
                ? Math.max(100, pickupBar0.endMs - pickupBar0.startMs)
                : Math.max(150, ((fullMidiBars[0]?.endMs - fullMidiBars[0]?.startMs) || 2000) * 0.15);

            let fullCursor = 0;
            const combined = [];
            for (let idx = 0; idx < chosenSeq.length; idx++) {
                const item = chosenSeq[idx];
                if (idx === 0 && item.visualBar.isPickup && pickupBar0) {
                    combined.push({
                        ...item,
                        startMs: pickupBar0.startMs,
                        endMs: pickupBar0.endMs,
                        beats: pickupBar0.beats || 1,
                        sim: 1
                    });
                } else if (item.visualBar.isPickup && combined.length > 0) {
                    // Internal section pickup (or repeated initial pickup): carve its duration from the end of the preceding bar
                    const prev = combined[combined.length - 1];
                    const prevDur = Math.max(200, prev.endMs - prev.startMs);
                    const stealMs = Math.min(defaultPickupMs, prevDur * 0.35);
                    const pickupStartMs = prev.endMs - stealMs;
                    const pickupEndMs = prev.endMs;
                    prev.endMs = pickupStartMs;
                    combined.push({
                        ...item,
                        startMs: pickupStartMs,
                        endMs: pickupEndMs,
                        beats: pickupBar0?.beats || 0.5,
                        sim: 1
                    });
                } else {
                    const fm = fullMapped[Math.min(fullCursor, fullMapped.length - 1)];
                    fullCursor++;
                    if (fm) {
                        combined.push({
                            ...item,
                            startMs: fm.startMs,
                            endMs: fm.endMs,
                            beats: fm.beats,
                            sim: fm.sim
                        });
                    }
                }
            }
            alignedSeq = combined;
            tier = fullRes.tier;
        } else {
            const res = alignBarSequences(chosenSeq, midiBars, midiNotes);
            alignedSeq = res.mapped;
            tier = res.tier;
        }
    } else {
        // Tier C: Steady Bar-Paced Clock
        const num = Math.max(1, timeSig?.num || 4);
        const den = Math.max(1, timeSig?.den || 4);
        const bpm = Math.max(20, Math.min(320, baseBpm || 100));
        let beatMs = (60000 / bpm) * (4 / den);
        if (beatUnit === 'dotted-quarter' && den === 8) {
            beatMs = (60000 / bpm) / 3;
        } else if (beatUnit === 'half' && den === 4) {
            beatMs = (60000 / (bpm * 2));
        }

        let curMs = 0;
        alignedSeq = unfoldedBars.map((item, idx) => {
            const vb = item.visualBar;
            const beatsInBar = vb.isPickup
                ? Math.max(1, Math.round(num * Math.max(0.25, Math.min(0.75, vb.widthRatio))))
                : num;
            const durMs = beatsInBar * beatMs;
            const startMs = curMs;
            const endMs = curMs + durMs;
            curMs = endMs;
            return {
                ...item,
                startMs,
                endMs,
                beats: beatsInBar
            };
        });
        tier = 'C';
    }

    // Populate first-pass startMs/endMs on each visualBar (for bar clicking & Practice -> Loop bars)
    for (const vb of visualBars) {
        vb.startMs = null;
        vb.endMs = null;
    }
    for (const item of alignedSeq) {
        const vb = item.visualBar;
        if (vb.startMs === null) {
            vb.startMs = item.startMs;
            vb.endMs = item.endMs;
        }
    }

    const barTimeline = alignedSeq.map((item, idx) => {
        const vb = item.visualBar;
        return {
            playIndex: idx,
            visualBarIndex: vb.visualIndex,
            barNumber: vb.displayBarNumber,
            blockId: vb.blockId,
            systemIndex: vb.systemIndex,
            barOffset: vb.barOffset,
            barCount: vb.barCountInSystem,
            colStart: vb.colStart,
            colEnd: vb.colEnd,
            colStartFrac: vb.colStartFrac,
            colEndFrac: vb.colEndFrac,
            startMs: item.startMs,
            endMs: item.endMs,
            beats: item.beats
        };
    });

    const points = barTimeline.map((bt, idx) => ({
        id: `auto-${idx}`,
        barIndex: bt.blockId,
        barOffset: bt.barOffset,
        barCount: bt.barCount,
        colStartFrac: bt.colStartFrac,
        colEndFrac: bt.colEndFrac,
        visualBarIndex: bt.visualBarIndex,
        barNumber: bt.barNumber,
        timeMs: bt.startMs,
        endTimeMs: bt.endMs,
        source: 'auto'
    }));

    const totalDurationMs = barTimeline.length > 0 ? barTimeline[barTimeline.length - 1].endMs : 0;

    return {
        points,
        barTimeline,
        visualBars,
        tier,
        hasRepeats,
        totalDurationMs
    };
}
