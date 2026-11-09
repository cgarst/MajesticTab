// barRuler.js
// The reader's transport: a bar ruler in the bottom dock. It shows how a player thinks about position (bar
// numbers and the song's own sections), not minutes. The song's sections are the ruler's segments, each named
// inside itself (marks from songSections.js); a file with no usable marks is one plain segment with bar numbers.
// The dock never names the section, so the ruler's length does not change through a song. Sync points are not drawn here: the recording bar has them.
// Drag to seek; the dock's loop button loops the current part.
// It never draws notation; AlphaTab owns that.

import { notePlaybackBar, onTransportEvent, getPlayerContext, getMidiTickLookup, synthPlayerState, applyLoopSettings, updateSynthUI, toggleMetronome, followSeekToBar } from './gpPlayer.js';
import { deriveSections, partAtBar, buildSegments, segmentIndexAtBar, movementNumeral, MIN_BLOCK_PX, DEFAULT_MIN_BARS } from './songSections.js';
import { buildScoreTimeline, playedBarsFromLookup, tickToPosition, tickToScoreMs, tempoAtScoreMs } from '../audioSync/scorePositions.js';
import { getAudioSyncSession } from '../audioSync/audioSyncController.js';

const MIN_BARS_KEY = 'majestictab.sectionMinBars';
const SVG_NS = 'http://www.w3.org/2000/svg';

function readMinBars() {
    try {
        const n = parseInt(localStorage.getItem(MIN_BARS_KEY), 10);
        return [1, 2, 4, 8].includes(n) ? n : DEFAULT_MIN_BARS;
    } catch (_) { return DEFAULT_MIN_BARS; }
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function initBarRuler() {
    if (document.getElementById('barRuler')) return;
    const slot = document.getElementById('dockRulerSlot');
    if (!slot) return;

    const ruler = document.createElement('div');
    ruler.id = 'barRuler';
    ruler.className = 'ruler';
    ruler.setAttribute('role', 'slider');
    ruler.tabIndex = 0;
    ruler.setAttribute('aria-label', 'Song position, in bars');
    ruler.setAttribute('aria-valuemin', '1');
    ruler.innerHTML = `
      <div class="ruler-clip">
        <div class="ruler-segs" id="rulerSegs" aria-hidden="true"></div>
        <div class="loop" id="rulerLoop"></div>
        <svg id="rulerTicks" preserveAspectRatio="none" aria-hidden="true"></svg>
        <div class="ruler-labels" id="rulerLabels" aria-hidden="true"></div>
      </div>
      <div class="head" id="rulerHead"></div>
      <div class="ruler-tip" id="rulerTip" aria-hidden="true"></div>`;
    slot.appendChild(ruler);

    const $ = (id) => document.getElementById(id);
    const dock = $('mobilePlaybackDock');
    let model = null; // { total, parts, marks, timeline, score }
    let current = { bar: 1, pos: 0 };
    let marksPanel = null;
    let segEls = []; // { body, fill, label, seg, filled }
    let currentSeg = -1;
    let currentPartName = null;
    let tipTimer = 0;

    function buildModel() {
        const { score } = getPlayerContext();
        const masterBars = score?.masterBars;
        if (!masterBars?.length) { model = null; return; }
        const { parts, marks } = deriveSections(masterBars, { minBars: readMinBars() });
        model = { total: masterBars.length, parts, marks, segments: [], timeline: null, score };
    }

    function ensureTimeline() {
        if (!model || model.timeline) return;
        const { api } = getPlayerContext();
        const played = playedBarsFromLookup(getMidiTickLookup(api));
        if (played.length) model.timeline = buildScoreTimeline(played);
    }

    // ---- drawing ------------------------------------------------------------------------------------------

    function syncDockTimeVisibility() {
        const dockTime = $('dockTime');
        if (!dockTime) return;
        // On a phone the strip shows the position (and it is the only place that does); between phone and desktop widths it hides when the dock is cramped
        const isNarrow = window.innerWidth > 640 && dock && dock.clientWidth > 0 && dock.clientWidth < 560;
        const next = isNarrow ? 'none' : '';
        if (dockTime.style.display !== next) dockTime.style.display = next;
    }

    function render() {
        dock?.classList.toggle('has-ruler', Boolean(model));
        ruler.hidden = !model;
        if (!model) return;
        syncDockTimeVisibility();
        const { total } = model;
        ruler.setAttribute('aria-valuemax', String(total));
        // The dock's bar readout reserves room for the song's widest bar number, so the ruler never changes length
        dock?.style.setProperty('--bar-digits', String(String(total).length));
        drawTicks();
        drawSegments();
        drawLabels();
        updateLoop();
        updateHead();
        $('barRulerInfoBtn')?.toggleAttribute('hidden', !model.marks.length);
    }

    function drawTicks() {
        const { total } = model;
        const svg = $('rulerTicks');
        svg.setAttribute('viewBox', `0 0 ${total} 44`);
        svg.innerHTML = '';
        const width = ruler.clientWidth || 600;
        const perBar = width / total;
        const major = [1, 2, 5, 10, 20, 25, 50, 100].find((s) => s * perBar >= 38) || 100;
        const path = document.createElementNS(SVG_NS, 'path');
        let d = '';
        for (let b = 0; b < total; b++) {
            const isMajor = b % major === 0;
            if (!isMajor && perBar < 3.5) continue;
            const h = isMajor ? 12 : (perBar >= 6 && b % 5 === 0 ? 8 : 5);
            d += `M${b} 44v${-h}`;
        }
        path.setAttribute('d', d);
        svg.appendChild(path);
        model.major = major;
    }

    // Text fitting: a label is cut at a word boundary and never shrinks to a stray letter. Measured with the
    // label's own font, so what fits here fits on screen.
    const measure = (() => {
        let ctx = null;
        return (text) => {
            try {
                ctx = ctx || document.createElement('canvas').getContext('2d');
                ctx.font = '600 11px system-ui, sans-serif';
                return ctx.measureText(text).width;
            } catch (_) { return text.length * 6.5; }
        };
    })();
    const LABEL_PAD = 10; // 5px in, 3px out, the 2px gap
    const MIN_LABEL_CHARS = 4;

    // Cut at a word boundary, never to a stray letter. Returns '' when nothing readable fits.
    function fitWords(text, avail) {
        if (!text || avail < 24) return '';
        if (measure(text) <= avail) return text;
        const words = text.split(' ');
        if (words.length > 1) {
            // A trailing number or numeral ("Chorus II") goes without an ellipsis; anything else is cut with one
            let onlyNumbers = true;
            while (words.length > 1) {
                if (!/^(\d+|[ivx]+)$/i.test(words.pop())) onlyNumbers = false;
                const head = words.join(' ').replace(/[\s:,\u00b7-]+$/, '');
                if (head.length < MIN_LABEL_CHARS) continue;
                if (onlyNumbers && measure(head) <= avail) return head;
                const cut = `${head}\u2026`;
                if (measure(cut) <= avail) return cut;
            }
            return '';
        }
        // One long word: cut it by letters, but only when enough of it survives to read
        let t = text;
        while (t.length > MIN_LABEL_CHARS && measure(`${t}\u2026`) > avail) t = t.slice(0, -1);
        return t.length >= MIN_LABEL_CHARS && measure(`${t}\u2026`) <= avail ? `${t}\u2026` : '';
    }

    // A block's name in the room it has: the whole name, a word-boundary cut, or for a numbered movement its
    // numeral ("IV"), which is how the file itself numbers it
    function fitLabel(text, px) {
        const avail = px - LABEL_PAD;
        const words = fitWords(text, avail);
        if (words) return words;
        const numeral = movementNumeral(text);
        return numeral && measure(numeral) <= avail ? numeral : '';
    }

    // "Movement \u00b7 section" for a bar: the block's own name and the part the bar is in (either may be missing)
    function placeAt(bar) {
        const seg = model.segments[segmentIndexAtBar(model.segments, bar)];
        const part = partAtBar(model.parts, bar);
        const partName = part && part.name && part.name !== 'Start' ? part.name : '';
        const title = seg?.title || '';
        if (title && partName && partName !== title) return { title, sub: partName };
        return { title: title || partName, sub: '' };
    }

    // One block per section (one plain block when the file names none). At most one level is drawn for the
    // ruler's width (songSections.buildSegments); the 2px gap between blocks is real transparency, and each
    // block carries its own played fill so the gap stays clean.
    function drawSegments() {
        const box = $('rulerSegs');
        box.innerHTML = '';
        segEls = [];
        currentSeg = -1;
        currentPartName = null;
        const width = ruler.clientWidth || 600;
        model.segments = buildSegments(model.parts, model.total, width);
        const segments = model.segments.length ? model.segments : [{ start: 0, width: 1, title: '' }];
        segments.forEach((seg) => {
            const px = seg.width * width;
            const el = document.createElement('div');
            el.className = 'seg';
            el.style.left = `${seg.start * 100}%`;
            el.style.width = `${seg.width * 100}%`;
            if (px < MIN_BLOCK_PX) el.classList.add('tight'); // too narrow to carry a gap: it is a colour, not a block
            if (seg.family) el.dataset.family = seg.family;
            const body = document.createElement('div');
            body.className = 'seg-body';
            const fill = document.createElement('div');
            fill.className = 'seg-fill';
            body.appendChild(fill);
            let label = null;
            let main = null;
            let sub = null;
            if (model.segments.length) {
                label = document.createElement('span');
                label.className = 'seg-label';
                main = document.createElement('span');
                main.className = 'seg-main';
                sub = document.createElement('span');
                sub.className = 'seg-sub';
                label.append(main, sub);
                main.textContent = fitLabel(seg.title, px);
                body.appendChild(label);
            }
            el.appendChild(body);
            box.appendChild(el);
            segEls.push({ el, fill, label, main, sub, seg, px, filled: -1 });
        });
    }

    // The block the playhead is in says where it is, to the part: "Movement \u00b7 section" in the room it has
    function updateCurrentLabel(at) {
        const e = segEls[at];
        if (!e?.label) return;
        const { title, sub } = placeAt(current.bar);
        const avail = e.px - LABEL_PAD;
        const set = (main, rest = '') => { e.main.textContent = main; e.sub.textContent = rest; };
        if (sub && title) {
            // Whole movement and section, else the movement's numeral and the section, else the section alone
            const numeral = movementNumeral(title);
            const tries = [[title, ` \u00b7 ${sub}`], ...(numeral ? [[numeral, ` \u00b7 ${sub}`]] : [])];
            for (const [m, r] of tries) {
                if (measure(m + r) <= avail) { set(m, r); return; }
            }
            set(fitWords(sub, avail) || fitLabel(title, e.px));
            return;
        }
        set(fitLabel(title || sub, e.px));
    }

    // Bar numbers on the major steps (1, then every `major`), in their own row under the names
    function drawLabels() {
        const { total, major } = model;
        const box = $('rulerLabels');
        box.innerHTML = '';
        for (let b = 1; b <= total; b += (b === 1 ? (major > 1 ? major - 1 : 1) : major)) {
            const em = document.createElement('em');
            em.textContent = String(b);
            em.style.left = `${((b - 1) / total) * 100}%`;
            box.appendChild(em);
        }
    }

    // ---- the scrub readout: where the playhead is, in words, while the person moves it -----------------------

    function updateTip() {
        const tip = $('rulerTip');
        if (!model || !tip) return;
        const { title, sub } = placeAt(current.bar);
        tip.textContent = [title, sub, `${title || sub ? 'bar' : 'Bar'} ${current.bar}`].filter(Boolean).join(' \u00b7 ');
        const w = ruler.clientWidth || 0;
        const half = (tip.offsetWidth || 0) / 2;
        const frac = Math.min(1, Math.max(0, (current.bar - 1 + current.pos) / model.total));
        const x = Math.min(Math.max(frac * w, half), Math.max(half, w - half));
        tip.style.transform = `translate3d(${x.toFixed(1)}px,0,0) translateX(-50%)`;
    }

    function showTip() {
        const tip = $('rulerTip');
        if (!tip || !model) return;
        clearTimeout(tipTimer);
        tip.classList.add('is-on');
        updateTip();
    }

    function holdTip() {
        clearTimeout(tipTimer);
        tipTimer = setTimeout(() => $('rulerTip')?.classList.remove('is-on'), 600);
    }

    function updateHead() {
        if (!model) return;
        syncDockTimeVisibility();
        const { total, parts } = model;
        const frac = Math.min(1, Math.max(0, (current.bar - 1 + current.pos) / total));
        const w = ruler.clientWidth || 0;
        $('rulerHead').style.transform = `translate3d(${(frac * w).toFixed(1)}px,0,0)`;
        for (const e of segEls) {
            const f = Math.min(1, Math.max(0, (frac - e.seg.start) / e.seg.width));
            const q = Math.round(f * 1000);
            if (q === e.filled) continue;
            e.filled = q;
            e.fill.style.transform = `scaleX(${(q / 1000).toFixed(3)})`;
        }
        const at = model.segments.length ? segmentIndexAtBar(model.segments, current.bar) : -1;
        const part = partAtBar(parts, current.bar);
        const partName = part?.name || '';
        if (at !== currentSeg || partName !== currentPartName) {
            const old = segEls[currentSeg];
            if (old?.label && currentSeg !== at) {
                old.label.classList.remove('is-current');
                old.main.textContent = fitLabel(old.seg.title, old.px);
                old.sub.textContent = '';
            }
            if (at >= 0) {
                segEls[at]?.label?.classList.add('is-current');
                updateCurrentLabel(at);
            }
            currentSeg = at;
            currentPartName = partName;
        }
        ruler.setAttribute('aria-valuenow', String(current.bar));
        const place = placeAt(current.bar);
        const placeText = [place.title, place.sub].filter(Boolean).join(', ');
        ruler.setAttribute('aria-valuetext', placeText ? `${placeText}, bar ${current.bar} of ${total}` : `Bar ${current.bar} of ${total}`);
        const barEl = $('dockBar');
        if (barEl && barEl.textContent !== String(current.bar)) barEl.textContent = String(current.bar);
        if ($('rulerTip')?.classList.contains('is-on')) updateTip();
        const loopBtn = $('dockLoopBtn');
        if (loopBtn) {
            const target = loopTarget();
            const looping = synthPlayerState.loopEnabled && target
                && synthPlayerState.loopStartMeasure === target.start && synthPlayerState.loopEndMeasure === target.end;
            loopBtn.classList.toggle('active-audio-mode', Boolean(looping));
            loopBtn.setAttribute('aria-pressed', String(Boolean(looping)));
            loopBtn.title = part ? `Loop ${part.name} (bars ${part.startBar} to ${part.endBar})` : 'Loop the song';
        }
    }

    function updateLoop() {
        const el = $('rulerLoop');
        if (!model || !synthPlayerState.loopEnabled) { ruler.dataset.loop = '0'; return; }
        const s = synthPlayerState.loopStartMeasure;
        const e = synthPlayerState.loopEndMeasure;
        ruler.dataset.loop = '1';
        el.style.left = `${((s - 1) / model.total) * 100}%`;
        el.style.width = `${((e - s + 1) / model.total) * 100}%`;
    }

    // ---- seek -----------------------------------------------------------------------------------------------

    function seekToBar(barNumber) {
        const { api, score } = getPlayerContext();
        const mb = score?.masterBars?.[barNumber - 1];
        if (!api || !mb) return;
        let tick = mb.start;
        try {
            const t = getMidiTickLookup(api)?.getMasterBarStart?.(mb);
            if (typeof t === 'number' && !Number.isNaN(t)) tick = t;
        } catch (_) { /* fall back to the notation tick */ }
        api.tickPosition = tick;
        current = { bar: barNumber, pos: 0 };
        updateHead();
        followSeekToBar(api.tickPosition, barNumber - 1);
    }

    function barFromPointer(ev) {
        const rect = ruler.getBoundingClientRect();
        const frac = Math.min(0.9999, Math.max(0, (ev.clientX - rect.left) / rect.width));
        return Math.floor(frac * model.total) + 1;
    }

    let dragging = false;
    ruler.addEventListener('pointerdown', (ev) => {
        if (!model) return;
        dragging = true;
        ruler.setPointerCapture?.(ev.pointerId);
        seekToBar(barFromPointer(ev));
        showTip();
    });
    ruler.addEventListener('pointermove', (ev) => {
        if (!dragging || !model) return;
        // One seek per bar crossed, so a drag does not flood the recording with seeks
        const bar = barFromPointer(ev);
        if (bar !== current.bar) seekToBar(bar);
    });
    const stopDrag = () => { if (dragging) holdTip(); dragging = false; };
    ruler.addEventListener('pointerup', stopDrag);
    ruler.addEventListener('pointercancel', stopDrag);
    ruler.addEventListener('keydown', (ev) => {
        if (!model) return;
        const delta = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
        if (!delta) return;
        ev.preventDefault();
        ev.stopPropagation();
        seekToBar(Math.min(model.total, Math.max(1, current.bar + delta)));
        showTip();
        holdTip();
    });

    // ---- dock buttons -------------------------------------------------------------------------------------

    function loopTarget() {
        if (!model) return null;
        const part = partAtBar(model.parts, current.bar);
        return part ? { start: part.startBar, end: part.endBar } : { start: 1, end: model.total };
    }

    $('dockLoopBtn')?.addEventListener('click', () => {
        const target = loopTarget();
        if (!target) return;
        const same = synthPlayerState.loopEnabled && synthPlayerState.loopStartMeasure === target.start
            && synthPlayerState.loopEndMeasure === target.end;
        synthPlayerState.loopEnabled = !same;
        synthPlayerState.loopStartMeasure = target.start;
        synthPlayerState.loopEndMeasure = target.end;
        applyLoopSettings();
        updateSynthUI();
        updateLoop();
        updateHead();
    });

    const metroBtn = $('dockMetroBtn');
    function syncMetro() {
        const on = Boolean(synthPlayerState.metronomeEnabled);
        metroBtn?.classList.toggle('active-audio-mode', on);
        metroBtn?.setAttribute('aria-pressed', String(on));
    }
    metroBtn?.addEventListener('click', () => { toggleMetronome(); setTimeout(syncMetro, 0); });

    // "What the file contains": the raw marks, so a wrong label can be understood
    function ensureInfoButton() {
        if ($('barRulerInfoBtn')) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'barRulerInfoBtn';
        btn.className = 'btn mobile-dock-btn dock-icon-btn';
        btn.hidden = true;
        btn.title = 'What the file contains (section marks)';
        btn.setAttribute('aria-label', 'What the file contains');
        btn.setAttribute('aria-expanded', 'false');
        btn.innerHTML = '<i class="bi-info-circle"></i>';
        $('dockLoopBtn')?.insertAdjacentElement('beforebegin', btn);
        btn.addEventListener('click', () => {
            if (!marksPanel) {
                marksPanel = document.createElement('div');
                marksPanel.className = 'dock-marks';
                marksPanel.hidden = true;
                dock.appendChild(marksPanel);
            }
            const open = marksPanel.hidden;
            if (open && model) {
                marksPanel.innerHTML = `<div class="mhead"><span>What the file contains</span><button type="button" class="dock-marks-close" aria-label="Close"><i class="bi-x-lg"></i></button></div><ul class="bar-ruler-marks">${model.marks.map((m) =>
                    `<li><span class="bar-ruler-mark-bar">Bar ${m.bar}</span> ${escapeHtml(m.raw || '(blank)')}</li>`).join('')}</ul>`;
            }
            marksPanel.hidden = !open;
            btn.setAttribute('aria-expanded', String(open));
            marksPanel.querySelector('.dock-marks-close')?.addEventListener('click', () => {
                marksPanel.hidden = true;
                btn.setAttribute('aria-expanded', 'false');
                btn.focus();
            });
        });
    }
    ensureInfoButton();

    // ---- transport events --------------------------------------------------------------------------------

    onTransportEvent((e) => {
        if (e.type === 'attached') {
            buildModel();
            current = { bar: 1, pos: 0 };
            render();
            syncMetro();
            const total = getPlayerContext().score?.tempo;
            if (total) $('dockBpm').textContent = String(Math.round(total * (synthPlayerState.playbackSpeed || 1)));
        } else if (e.type === 'detached') {
            model = null;
            render();
        } else if (e.type === 'position') {
            if (!model) return;
            ensureTimeline();
            const at = model.timeline ? tickToPosition(model.timeline, e.tick) : null;
            if (at) { current = { bar: at.barIndex + 1, pos: at.pos }; notePlaybackBar(current.bar, model.total); }
            updateHead();
            if (model.timeline) {
                try {
                    const scoreMs = tickToScoreMs(model.timeline, e.tick);
                    const bpm = tempoAtScoreMs(model.timeline, scoreMs);
                    // With the original recording playing through sync points, the tempo is how fast the recording
                    // plays the score here, not the one written in the file.
                    const session = getAudioSyncSession();
                    const factor = session ? session.tempoFactorAt(scoreMs) : (synthPlayerState.playbackSpeed || 1);
                    if (bpm) $('dockBpm').textContent = String(Math.round(bpm * factor));
                } catch (_) { /* keep the last tempo */ }
            }
        } else if (e.type === 'loop') {
            updateLoop();
            updateHead();
        }
    });

    window.addEventListener('resize', () => { syncDockTimeVisibility(); if (model) { buildModel(); render(); } });
    // The ruler also changes width without the window changing (Reading mode narrows the bar), and the playhead
    // is placed in pixels, so redraw whenever its own width changes
    if (typeof ResizeObserver === 'function') {
        let lastW = 0;
        new ResizeObserver(() => {
            const w = ruler.clientWidth;
            if (!w || w === lastW) return;
            lastW = w;
            if (model) render();
        }).observe(ruler);
    }
}
