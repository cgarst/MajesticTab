// fingeringPlanner.js
// Chooses a string for every note when a tab is re-fingered for another guitar, so the whole phrase stays playable.
// Pure: no AlphaTab objects, no DOM. tabAdapter.js builds the input and writes the answer back to the score.
//
// Notes are grouped into units (one unit = notes that sound together). The planner picks one fingering per unit
// with a Viterbi search whose state is the hand position (the lowest fretted fret; open strings do not move the hand,
// so an all-open unit carries the position through). What it costs:
//   - a chord that spans more than a few frets
//   - moving the hand between units
//   - drifting from the hand position the source tab had
//   - leaving the string the tab used (small, so untouched notes stay as written)
//   - folding a note by octaves when nothing fits (more for the lowest note)
//   - breaking a tie, slide or hammer-on that should stay on one string (found by repeating the search)
// Frets in and out are relative to the capo: 0 is the open string, or the capo itself.

const MOVE_COST = 2;
const SRC_POS_COST = 4;
const LINK_COST = 300;
const PARK_COST = 1000;
const LOWEST_FOLD_COST = 120;
const FOLD_COST = new Map([[0, 0], [12, 80], [-12, 80], [24, 200], [-24, 200]]);
const MAX_ENUM = 4000;
const MAX_CANDIDATES = 120;
const LINK_PASSES = 3;

function spanCost(span) {
    if (span <= 2) return 0;
    if (span === 3) return 4;
    if (span === 4) return 12;
    if (span === 5) return 60;
    return 150 * (span - 4);
}

function shiftCost(d) {
    return d <= 4 ? 3 * d : 12 + 6 * (d - 4);
}

function frettedOf(cands, notes) {
    const out = [];
    cands.forEach((c, q) => { if (c.fret > 0 && !notes[q].fixed) out.push(c.fret); });
    return out;
}

/**
 * @param {object} input
 * @param {Array<{notes: Array<{pitch:number, staticJ:number, srcFretted?:boolean, fixed?:{j:number,fret:number}, id?:any, linkId?:any}>}>} input.units
 *   pitch is the MIDI pitch to sound; staticJ the string index (0 = highest) the tab alignment would use; srcFretted
 *   says the source note was fretted; fixed pins a note (harmonics); linkId is the id of a note this one is tied to,
 *   slid from or hammered from.
 * @param {number[]} input.player MIDI pitch of each open string, highest first
 * @returns {{units: Array<Array<{j:number, fret:number, shift:number, parked:boolean}>>, folded:number}}
 */
export function planFingering({ units, player, capo = 0, maxFret = 24 }) {
    const m = player.length;
    const maxRel = Math.max(0, maxFret - capo);
    const P = maxRel + 1;

    // Hand position the source had, in this guitar's frets via the static string; carried through open-only units
    const srcPos = [];
    let carry = null;
    for (const unit of units) {
        const f = [];
        for (const n of unit.notes) {
            if (!n.srcFretted || n.fixed || n.staticJ < 0 || n.staticJ >= m) continue;
            const r = n.pitch - player[n.staticJ] - capo;
            if (r > 0) f.push(r);
        }
        if (f.length) carry = Math.min(...f);
        srcPos.push(carry);
    }

    const cands = units.map((unit, ui) => {
        const notes = unit.notes;
        if (!notes.length) return [{ c: [], base: 0, pos: null, parked: false }];
        const lowest = Math.min(...notes.map(n => n.pitch));

        const gen = (shifts, maxFold) => {
            const out = [];
            const used = new Set();
            for (const n of notes) if (n.fixed) used.add(n.fixed.j);
            const cur = [];
            const rec = (q, nf, pen) => {
                if (out.length >= MAX_ENUM) return;
                if (q === notes.length) { out.push({ c: cur.map(x => ({ ...x })), pen }); return; }
                const n = notes[q];
                if (n.fixed) {
                    cur.push({ j: n.fixed.j, fret: n.fixed.fret, shift: 0 });
                    rec(q + 1, nf, pen);
                    cur.pop();
                    return;
                }
                for (const sh of shifts) {
                    const isFold = sh !== 0;
                    if (isFold && nf >= maxFold) continue;
                    for (let j = 0; j < m; j++) {
                        if (used.has(j)) continue;
                        const r = n.pitch + sh - player[j] - capo;
                        if (r < 0 || r > maxRel) continue;
                        used.add(j);
                        cur.push({ j, fret: r, shift: sh });
                        rec(q + 1, nf + (isFold ? 1 : 0),
                            pen + (FOLD_COST.get(sh) || 0) + (isFold && n.pitch === lowest ? LOWEST_FOLD_COST : 0));
                        cur.pop();
                        used.delete(j);
                    }
                }
            };
            rec(0, 0, 0);
            return out;
        };

        let raw = gen([0], 0);
        if (!raw.length) raw = gen([0, 12, -12, 24, -24], 2);
        if (!raw.length) raw = gen([0, 12, -12, 24, -24], notes.length);
        let parked = false;
        if (!raw.length) {
            // Nothing fits at all: park each note on a free string at the nearest legal fret, and flag it
            parked = true;
            const used = new Set();
            const c = notes.map(n => {
                if (n.fixed) { used.add(n.fixed.j); return { j: n.fixed.j, fret: n.fixed.fret, shift: 0 }; }
                let j = -1;
                for (let x = 0; x < m; x++) if (!used.has(x)) { j = x; break; }
                if (j < 0) j = 0;
                used.add(j);
                return { j, fret: Math.min(maxRel, Math.max(0, n.pitch - player[j] - capo)), shift: 0 };
            });
            raw = [{ c, pen: PARK_COST }];
        }

        const scored = raw.map(({ c, pen }) => {
            const f = frettedOf(c, notes);
            let base = pen;
            if (f.length) base += spanCost(Math.max(...f) - Math.min(...f));
            c.forEach((x, q) => { if (!notes[q].fixed && x.j !== notes[q].staticJ) base += MOVE_COST; });
            const pos = f.length ? Math.min(...f) : null;
            if (pos !== null && srcPos[ui] !== null) base += SRC_POS_COST * Math.abs(pos - srcPos[ui]);
            return { c, base, pos, parked };
        });
        scored.sort((a, b) => a.base - b.base);
        const kept = scored.slice(0, MAX_CANDIDATES);
        return kept;
    });

    // Linked notes (tie, slide, hammer-on) are found by id; the partner's string in the previous pass is the preference
    const where = new Map();
    units.forEach((u, ui) => u.notes.forEach((n, q) => { if (n.id !== undefined) where.set(n.id, [ui, q]); }));
    const links = []; // [ui, q, partnerUi, partnerQ]
    units.forEach((u, ui) => u.notes.forEach((n, q) => {
        const w = n.linkId !== undefined ? where.get(n.linkId) : null;
        if (!w) return;
        links.push([ui, q, w[0], w[1]]);
        links.push([w[0], w[1], ui, q]);
    }));

    const transTable = Array.from({ length: P }, (_, a) => Float64Array.from({ length: P }, (_, b) => shiftCost(Math.abs(a - b))));
    let assign = null;
    let prefs = null;
    const passes = links.length ? LINK_PASSES : 1;
    for (let pass = 0; pass < passes; pass++) {
        const NB = units.length;
        const backPrev = new Array(NB);
        const backCi = new Array(NB);
        let prev = new Float64Array(P);
        for (let ui = 0; ui < NB; ui++) {
            const cur = new Float64Array(P).fill(Infinity);
            const bp = new Int16Array(P).fill(-1);
            const bc = new Int32Array(P).fill(-1);
            // cheapest way to arrive at each hand position
            const best = new Float64Array(P).fill(Infinity);
            const arg = new Int16Array(P).fill(-1);
            for (let p = 0; p < P; p++) {
                for (let pp = 0; pp < P; pp++) {
                    const v = prev[pp] + transTable[pp][p];
                    if (v < best[p]) { best[p] = v; arg[p] = pp; }
                }
            }
            cands[ui].forEach((cand, ci) => {
                let cost = cand.base;
                if (prefs) {
                    for (const [lq, pj] of prefs[ui]) if (cand.c[lq] && cand.c[lq].j !== pj) cost += LINK_COST;
                }
                if (cand.pos !== null) {
                    const v = best[cand.pos] + cost;
                    if (v < cur[cand.pos]) { cur[cand.pos] = v; bp[cand.pos] = arg[cand.pos]; bc[cand.pos] = ci; }
                } else {
                    for (let pp = 0; pp < P; pp++) {
                        const v = prev[pp] + cost;
                        if (v < cur[pp]) { cur[pp] = v; bp[pp] = pp; bc[pp] = ci; }
                    }
                }
            });
            backPrev[ui] = bp;
            backCi[ui] = bc;
            prev = cur;
        }
        let st = 0;
        for (let p = 1; p < P; p++) if (prev[p] < prev[st]) st = p;
        const next = new Array(NB);
        for (let ui = NB - 1; ui >= 0; ui--) {
            next[ui] = cands[ui][backCi[ui][st]];
            st = backPrev[ui][st];
        }
        const changed = !assign || next.some((c, ui) => c.c.some((x, q) => x.j !== assign[ui].c[q].j));
        assign = next;
        if (!links.length || !changed) break;
        prefs = units.map(() => []);
        for (const [ui, q, pu, pq] of links) prefs[ui].push([q, assign[pu].c[pq].j]);
    }

    let folded = 0;
    for (const a of assign) folded += a.parked ? a.c.length : a.c.filter(x => x.shift !== 0).length;
    return {
        units: assign.map(a => a.c.map(x => ({ ...x, parked: a.parked }))),
        folded
    };
}
