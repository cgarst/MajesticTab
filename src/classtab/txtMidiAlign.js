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

    let trailingDc = false;
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
            if (visualBars.length > 0 && /\bD\.?\s*C\.?\b|\bDa\s+Capo\b/i.test(blk.text || '')) {
                trailingDc = true;
            }
            continue;
        }
        if (blk.kind !== 'system') continue;
        if (blk.version && blk.version !== version) continue;
        trailingDc = false;

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
        if (vb.ending === 1 && !inRepeatPass && i > repeatAnchor) {
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

    // Handle D.C. (Da Capo) or D.S. (Dal Segno) at or near the end of the piece
    let dcIdx = visualBars.length > 0 && (visualBars[visualBars.length - 1].directives?.dc || trailingDc)
        ? visualBars.length - 1
        : -1;
    if (dcIdx < 0 && visualBars.length > 0) {
        for (let k = visualBars.length - 1; k >= Math.max(0, visualBars.length - 8); k--) {
            if (visualBars[k].directives?.dc) { dcIdx = k; break; }
        }
    }
    if (dcIdx >= 0) {
        const fineIdx = visualBars.findIndex(b => b.directives?.fine);
        const stopAt = fineIdx >= 0 && fineIdx < dcIdx
            ? fineIdx
            : Math.min(dcIdx, Math.floor(visualBars.length / 2));
        for (let k = 0; k <= stopAt && unfoldedBars.length < maxUnfolded; k++) {
            unfoldedBars.push({
                playIndex: unfoldedBars.length,
                visualBar: visualBars[k]
            });
        }
    } else if (visualBars.length > 0) {
        let dsIdx = -1;
        for (let k = visualBars.length - 1; k >= Math.max(0, visualBars.length - 8); k--) {
            if (visualBars[k].directives?.ds) { dsIdx = k; break; }
        }
        if (dsIdx > 0) {
            const segnoIdx = Math.max(0, visualBars.findIndex((b, idx) => idx < dsIdx && b.directives?.segno));
            const fineIdx = visualBars.findIndex((b, idx) => idx >= segnoIdx && idx < dsIdx && b.directives?.fine);
            const stopAt = fineIdx >= segnoIdx ? fineIdx : Math.min(dsIdx, Math.floor((segnoIdx + dsIdx) / 2));
            for (let k = segnoIdx; k <= stopAt && unfoldedBars.length < maxUnfolded; k++) {
                unfoldedBars.push({
                    playIndex: unfoldedBars.length,
                    visualBar: visualBars[k]
                });
            }
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
    const ratio = M / Math.max(1, P);
    const maxStep = ratio > 1.6 ? Math.min(4, Math.ceil(ratio) + 1) : 2;
    const band = Math.max(12, Math.abs(P - M) + 8);

    // Transition priors adapt when MIDI has ~2x or ~0.5x as many bars as the tab (e.g. 2/2 vs 4/4)
    const stepBonus = (step) => {
        if (ratio > 1.6) {
            if (step === 2) return 0.15;
            if (step === 1) return 0.0;
            if (step === 0) return -0.35;
            return -0.1 * (step - 2);
        }
        if (ratio < 0.65) {
            if (step === 0) return 0.05;
            if (step === 1) return 0.1;
            return -0.25;
        }
        if (step === 1) return 0.15;
        if (step === 0) return -0.25;
        return -0.2;
    };

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
            let bestPrevVal = -1e9;
            let bestPrevM = m;
            for (let step = 0; step <= maxStep; step++) {
                if (m < step) break;
                const cand = dp[p - 1][m - step] + stepBonus(step);
                if (cand > bestPrevVal) {
                    bestPrevVal = cand;
                    bestPrevM = m - step;
                }
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
    return { mapped, avgSim, tier: avgSim >= 0.2 ? 'A' : 'B', bestShift };
}

/**
 * Aligns individual tab chord/note onsets (`vb.noteOnsets`) against clustered MIDI note onsets
 * using a banded monotonic DP with rolled-chord (`arp.`) absorption.
 * Returns null if there are too few onsets or match quality is below threshold.
 */
function alignNoteOnsets(alignedSeq, midiNotes, stringPcs, bestShift, totalDurationMs) {
    if (!alignedSeq.length || !midiNotes?.length) return null;

    const tabOnsets = [];
    for (let b = 0; b < alignedSeq.length; b++) {
        const item = alignedSeq[b];
        const vb = item.visualBar;
        const barDur = Math.max(1, item.endMs - item.startMs);
        const barSpan = Math.max(1, vb.colEnd - vb.colStart);
        for (const onset of vb.noteOnsets || []) {
            const rawMask = barPitchMask([onset], stringPcs);
            const mask = rotateMask12(rawMask, bestShift);
            const localFrac = Math.max(0, Math.min(1, (onset.col - vb.colStart) / barSpan));
            tabOnsets.push({
                onsetIdx: tabOnsets.length,
                barIdx: b,
                col: onset.col,
                colFrac: vb.colStartFrac + (vb.colEndFrac - vb.colStartFrac) * localFrac,
                mask,
                noteCount: onset.frets?.length || 1,
                estMs: item.startMs + localFrac * barDur
            });
        }
    }
    if (tabOnsets.length < 4) return null;

    const midiClusters = [];
    for (const n of midiNotes) {
        const last = midiClusters[midiClusters.length - 1];
        const pc = n.pitch % 12;
        if (last && (n.ms - last.lastMs) <= 28) {
            last.lastMs = n.ms;
            last.mask |= (1 << pc);
            last.count++;
        } else {
            midiClusters.push({ startMs: n.ms, lastMs: n.ms, mask: (1 << pc), count: 1 });
        }
    }
    if (midiClusters.length < 4) return null;

    const T = tabOnsets.length;
    const M = midiClusters.length;
    const INF = 1e9;
    const W = Math.max(60, Math.min(140, Math.round(M * 0.08)));
    const BW = 2 * W + 1;

    const centers = new Int32Array(T);
    let mj = 0;
    for (let i = 0; i < T; i++) {
        while (mj + 1 < M && midiClusters[mj].startMs < tabOnsets[i].estMs) mj++;
        centers[i] = mj;
    }

    const dp = Array.from({ length: T }, () => new Float64Array(BW).fill(INF));
    const backO = Array.from({ length: T }, () => new Int32Array(BW).fill(-1));
    const spanEnd = Array.from({ length: T }, () => new Int32Array(BW).fill(-1));
    const bestScores = Array.from({ length: T }, () => new Float32Array(BW));

    const evalChordAt = (i, j) => {
        const t = tabOnsets[i];
        const maxK = t.noteCount >= 2 ? Math.min(6, t.noteCount + 1) : 1;
        let bestScore = -1;
        let bestEnd = j;
        let combMask = 0;
        for (let k = 0; k < maxK && j + k < M; k++) {
            if (k > 0 && (midiClusters[j + k].startMs - midiClusters[j + k - 1].lastMs > 90
                || midiClusters[j + k].startMs - midiClusters[j].startMs > 380)) {
                break;
            }
            combMask |= midiClusters[j + k].mask;
            const s = maskSimilarity(t.mask, combMask);
            if (s >= bestScore - 1e-6) {
                bestScore = s;
                bestEnd = j + k;
            }
        }
        return { bestScore: Math.max(0, bestScore), bestEnd };
    };

    for (let o = 0; o < BW; o++) {
        const j = centers[0] - W + o;
        if (j < 0 || j >= M) continue;
        const { bestScore, bestEnd } = evalChordAt(0, j);
        dp[0][o] = (1 - bestScore) * 2.5 + Math.abs(midiClusters[j].startMs - tabOnsets[0].estMs) * 0.00004 + j * 0.02;
        spanEnd[0][o] = bestEnd;
        bestScores[0][o] = bestScore;
    }

    for (let i = 1; i < T; i++) {
        const ci = centers[i];
        const ciPrev = centers[i - 1];
        const estMs = tabOnsets[i].estMs;
        for (let o = 0; o < BW; o++) {
            const j = ci - W + o;
            if (j < 0 || j >= M) continue;
            const { bestScore, bestEnd } = evalChordAt(i, j);
            const matchCost = (1 - bestScore) * 2.5 + Math.abs(midiClusters[j].startMs - estMs) * 0.00004;
            let bestPrevCost = INF;
            let bestPrevO = -1;
            for (let po = 0; po < BW; po++) {
                const pj = ciPrev - W + po;
                if (pj < 0 || pj >= M || dp[i - 1][po] >= INF) continue;
                const pEnd = spanEnd[i - 1][po];
                if (j <= pEnd) continue;
                const skipCost = (j - pEnd - 1) * 0.25;
                const c = dp[i - 1][po] + matchCost + skipCost;
                if (c < bestPrevCost) {
                    bestPrevCost = c;
                    bestPrevO = po;
                }
            }
            if (bestPrevO >= 0) {
                dp[i][o] = bestPrevCost;
                backO[i][o] = bestPrevO;
                spanEnd[i][o] = bestEnd;
                bestScores[i][o] = bestScore;
            }
        }
    }

    let bestLastO = -1;
    let bestLastCost = INF;
    for (let o = 0; o < BW; o++) {
        if (dp[T - 1][o] < bestLastCost) {
            bestLastCost = dp[T - 1][o];
            bestLastO = o;
        }
    }
    if (bestLastO < 0) return null;

    const matchedMs = new Float64Array(T);
    let sumSim = 0;
    let curO = bestLastO;
    for (let i = T - 1; i >= 0; i--) {
        const j = centers[i] - W + curO;
        matchedMs[i] = midiClusters[j].startMs;
        sumSim += bestScores[i][curO];
        curO = backO[i][curO];
    }
    if ((sumSim / T) < 0.45) return null;

    // Group tabOnsets by barIdx
    const byBar = Array.from({ length: alignedSeq.length }, () => []);
    for (let i = 0; i < T; i++) {
        byBar[tabOnsets[i].barIdx].push(tabOnsets[i]);
    }

    return { byBar, matchedMs, endMs: Math.max(totalDurationMs || 0, midiClusters[M - 1].lastMs + 500) };
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
        // If the MIDI file omitted a 0x58 Time Signature event (so midiData.bars defaulted to 4/4), has a degenerate
        // 1/16-style grid that fragments the piece, or starts with a pickup lead-in while the tab has a narrow initial
        // pickup bar, build a time-signature-accurate MIDI bar grid.
        const hasInitialPickup = Boolean(visualBars[0]?.isPickup);
        const degenerateMidiSig = Boolean(
            midiData.initialTimeSig &&
            midiData.initialTimeSig.num === 1 &&
            midiData.initialTimeSig.den >= 8 &&
            midiData.bars.length > visualBars.length * 4
        );
        const fallbackSig = (timeSig && !(timeSig.num === 1 && timeSig.den >= 8)) ? timeSig : { num: 4, den: 4 };
        const effTimeSig = degenerateMidiSig ? fallbackSig : (midiData.initialTimeSig || fallbackSig);
        let midiBars = midiData.bars;
        let pickupBar0 = null;
        let fullMidiBars = midiBars;
        const needCustomGrid = Boolean(
            midiData.division &&
            typeof midiData.millis === 'function' &&
            (!midiData.initialTimeSig || degenerateMidiSig || (hasInitialPickup && midiNotes.length > 0 && midiNotes[0].tick > 0))
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
                // A MIDI file's pickup does not always fall on a whole beat from tick 0 (a lead-in rest, or a pickup note
                // that is not a beat long), so the beat and bar grids above can miss every downbeat. Try each onset in
                // the first bar as bar 1; the most downbeat hits wins, and among equals the one that makes the pickup
                // about as long as the tab's pickup is wide.
                const pv = visualBars[0];
                const firstCol = pv.noteOnsets?.[0]?.colOffset || 0;
                const pickupCols = Math.max(1, (pv.colEnd - pv.colStart) - firstCol);
                const barCols = Math.max(1, (pv.colEnd - pv.colStart) / Math.max(0.05, pv.widthRatio || 0.5));
                const expectLen = Math.max(0.1, Math.min(0.9, pickupCols / barCols)) * barTicks;
                let best = null;
                const seen = new Set();
                for (const n of midiNotes) {
                    if (n.tick <= firstNoteTick + tol || n.tick > firstNoteTick + barTicks) continue;
                    if (seen.has(n.tick)) continue;
                    seen.add(n.tick);
                    const hits = scoreCandidate(n.tick);
                    const off = Math.abs(n.tick - firstNoteTick - expectLen);
                    if (!best || hits > best.hits + 1e-9 || (Math.abs(hits - best.hits) <= 1e-9 && off < best.off)) best = { tick: n.tick, hits, off };
                }
                if (best && best.hits >= Math.max(scoreCandidate(bar1Tick), 0.5)) bar1Tick = best.tick;
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

        let bestShift = 0;
        if ((pickupBar0 || hasInternalPickups) && Math.abs(chosenNonPickup.length - fullMidiBars.length) <= 1) {
            const fullRes = alignBarSequences(chosenNonPickup, fullMidiBars, midiNotes);
            bestShift = fullRes.bestShift || 0;
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
                    const rawPrevDur = Math.max(0, prev.endMs - prev.startMs);
                    if (rawPrevDur > 40) {
                        const stealMs = Math.min(defaultPickupMs, rawPrevDur * 0.35);
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
                        combined.push({
                            ...item,
                            startMs: prev.endMs,
                            endMs: prev.endMs + 1,
                            beats: pickupBar0?.beats || 0.5,
                            sim: 1
                        });
                    }
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
            bestShift = res.bestShift || 0;
        }
        const barTotalMs = alignedSeq.length > 0 ? alignedSeq[alignedSeq.length - 1].endMs : 0;
        const noteAligned = tier !== 'C'
            ? alignNoteOnsets(alignedSeq, midiNotes, openStringPitchClasses(tuning, capoFret), bestShift, barTotalMs)
            : null;
        if (noteAligned) {
            const { byBar, matchedMs, endMs } = noteAligned;
            // Refine alignedSeq bar start/end monotonically from matched first-note timestamps
            const firstMsPerBar = byBar.map((list, idx) =>
                list.length > 0 ? matchedMs[list[0].onsetIdx] : null
            );
            let prevEnd = 0;
            for (let b = 0; b < alignedSeq.length; b++) {
                const rawDur = Math.max(1, alignedSeq[b].endMs - alignedSeq[b].startMs);
                if (firstMsPerBar[b] !== null) {
                    alignedSeq[b].startMs = b === 0
                        ? Math.min(alignedSeq[b].startMs, firstMsPerBar[b])
                        : Math.max(prevEnd, firstMsPerBar[b]);
                } else {
                    alignedSeq[b].startMs = prevEnd;
                }
                // Find next bar with matched notes to bound this bar's endMs
                let nextKnownIdx = -1;
                for (let nb = b + 1; nb < alignedSeq.length; nb++) {
                    if (firstMsPerBar[nb] !== null) { nextKnownIdx = nb; break; }
                }
                if (nextKnownIdx === b + 1) {
                    alignedSeq[b].endMs = Math.max(alignedSeq[b].startMs + 1, firstMsPerBar[nextKnownIdx]);
                } else if (nextKnownIdx > b + 1) {
                    const emptyFollowing = nextKnownIdx - (b + 1);
                    const lastNoteMs = byBar[b].length > 0
                        ? matchedMs[byBar[b][byBar[b].length - 1].onsetIdx]
                        : alignedSeq[b].startMs;
                    const targetEnd = Math.max(lastNoteMs + 1, firstMsPerBar[nextKnownIdx]);
                    if (byBar[b].length > 0) {
                        const rem = Math.max(emptyFollowing, targetEnd - lastNoteMs);
                        alignedSeq[b].endMs = Math.max(alignedSeq[b].startMs + 1, lastNoteMs + rem / (emptyFollowing + 1));
                    } else {
                        const step = Math.max(1, (targetEnd - alignedSeq[b].startMs) / (emptyFollowing + 1));
                        alignedSeq[b].endMs = alignedSeq[b].startMs + step;
                    }
                } else if (b === alignedSeq.length - 1) {
                    alignedSeq[b].endMs = Math.max(alignedSeq[b].startMs + 1, endMs);
                } else {
                    const lastNoteMs = byBar[b].length > 0
                        ? matchedMs[byBar[b][byBar[b].length - 1].onsetIdx]
                        : alignedSeq[b].startMs;
                    alignedSeq[b].endMs = Math.max(lastNoteMs + 1, alignedSeq[b].startMs + rawDur);
                }
                prevEnd = alignedSeq[b].endMs;
            }
            alignedSeq._noteAligned = noteAligned;
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

    let points;
    if (alignedSeq._noteAligned) {
        const { byBar, matchedMs, endMs } = alignedSeq._noteAligned;
        const nextBarFirstMs = new Float64Array(barTimeline.length).fill(endMs);
        for (let b = 0; b < barTimeline.length; b++) {
            nextBarFirstMs[b] = barTimeline[b].endMs;
        }
        points = [];
        for (let b = 0; b < barTimeline.length; b++) {
            const bt = barTimeline[b];
            const barOnsets = byBar[b];
            if (!barOnsets || barOnsets.length === 0) {
                points.push({
                    id: `auto-${points.length}`,
                    barIndex: bt.blockId,
                    barOffset: bt.barOffset,
                    barCount: bt.barCount,
                    colStartFrac: bt.colStartFrac,
                    colEndFrac: bt.colEndFrac,
                    barColStartFrac: bt.colStartFrac,
                    barColEndFrac: bt.colEndFrac,
                    visualBarIndex: bt.visualBarIndex,
                    barNumber: bt.barNumber,
                    timeMs: bt.startMs,
                    endTimeMs: bt.endMs,
                    source: 'auto'
                });
                continue;
            }
            for (let r = 0; r < barOnsets.length; r++) {
                const cur = barOnsets[r];
                const tStart = matchedMs[cur.onsetIdx];
                const hasNextInBar = r + 1 < barOnsets.length;
                const tEnd = hasNextInBar ? matchedMs[barOnsets[r + 1].onsetIdx] : nextBarFirstMs[b];
                const cEnd = hasNextInBar ? barOnsets[r + 1].colFrac : bt.colEndFrac;
                points.push({
                    id: `auto-${points.length}`,
                    barIndex: bt.blockId,
                    barOffset: bt.barOffset,
                    barCount: bt.barCount,
                    colStartFrac: cur.colFrac,
                    colEndFrac: cEnd,
                    barColStartFrac: bt.colStartFrac,
                    barColEndFrac: bt.colEndFrac,
                    visualBarIndex: bt.visualBarIndex,
                    barNumber: bt.barNumber,
                    timeMs: tStart,
                    endTimeMs: Math.max(tStart + 1, tEnd),
                    source: 'auto'
                });
            }
        }
    } else {
        points = barTimeline.map((bt, idx) => ({
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
    }

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
