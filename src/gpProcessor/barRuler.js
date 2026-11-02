// barRuler.js
// The reader's bar ruler: the position, section and loop strip under the top bar. It is the transport you
// can see: bar numbers, the sections read from the file's own marks (songSections.js), loop brackets, and
// a playhead. Click a bar to jump, click a part to jump to its start, "Loop part" loops the current part.
// It never draws notation; AlphaTab owns that. Files with no usable section marks show the bar ruler only.

import { onTransportEvent, getPlayerContext, getMidiTickLookup, synthPlayerState, applyLoopSettings, updateSynthUI } from './gpPlayer.js';
import { deriveSections, partAtBar, DEFAULT_MIN_BARS } from './songSections.js';
import { buildScoreTimeline, playedBarsFromLookup, tickToPosition } from '../audioSync/scorePositions.js';
import { buildTimelineModel } from '../audioSync/timelineModel.js';
import { listRecords, SYNC_CHANGED_EVENT } from '../audioSync/syncStore.js';
import { getSongKey } from '../youtubePlayer.js';

const MIN_BARS_KEY = 'majestictab.sectionMinBars';

function readMinBars() {
    try {
        const n = parseInt(localStorage.getItem(MIN_BARS_KEY), 10);
        return [1, 2, 4, 8].includes(n) ? n : DEFAULT_MIN_BARS;
    } catch (_) { return DEFAULT_MIN_BARS; }
}

export function initBarRuler() {
    if (document.getElementById('barRuler')) return;
    const bar = document.createElement('div');
    bar.id = 'barRuler';
    bar.className = 'bar-ruler';
    bar.hidden = true;
    bar.innerHTML = `
      <div class="bar-ruler-main">
        <div class="bar-ruler-col">
        <div class="bar-ruler-track" id="barRulerTrack" role="slider" tabindex="0" aria-label="Song position"
             aria-valuemin="1" aria-valuenow="1" aria-valuemax="1">
          <div class="bar-ruler-parts" id="barRulerParts"></div>
          <div class="bar-ruler-ticks" id="barRulerTicks"></div>
          <div class="bar-ruler-loop" id="barRulerLoop" hidden></div>
          <div class="bar-ruler-head" id="barRulerHead"></div>
        </div>
        <div class="bar-ruler-sync" id="barRulerSync" hidden aria-label="Recording sync coverage"></div>
        </div>
        <div class="bar-ruler-side">
          <span class="bar-ruler-readout" id="barRulerReadout" aria-live="off"></span>
          <button type="button" class="btn btn-sm btn-theme-outline bar-ruler-loop-btn" id="barRulerLoopBtn" hidden>Loop part</button>
          <button type="button" class="btn btn-sm btn-theme-icon bar-ruler-info-btn" id="barRulerInfoBtn" hidden
                  aria-expanded="false" aria-controls="barRulerInfo" title="What the file contains" aria-label="What the file contains"><i class="bi-info-circle"></i></button>
        </div>
      </div>
      <div class="bar-ruler-info" id="barRulerInfo" hidden></div>`;
    const topBar = document.getElementById('topBar');
    topBar.insertAdjacentElement('afterend', bar);

    const $ = (id) => document.getElementById(id);
    const track = $('barRulerTrack');
    let model = null; // { total, parts, marks, timeline, scoreKey }
    let current = { bar: 1, pos: 0 };

    function buildModel() {
        const { score } = getPlayerContext();
        const masterBars = score?.masterBars;
        if (!masterBars?.length) { model = null; return; }
        const { parts, marks } = deriveSections(masterBars, { minBars: readMinBars() });
        model = { total: masterBars.length, parts, marks, timeline: null, score };
    }

    function ensureTimeline() {
        if (!model || model.timeline) return;
        const { api } = getPlayerContext();
        const lookup = getMidiTickLookup(api);
        const played = playedBarsFromLookup(lookup);
        if (played.length) model.timeline = buildScoreTimeline(played);
    }

    function render() {
        if (!model) { bar.hidden = true; document.body.classList.remove('has-bar-ruler'); return; }
        bar.hidden = false;
        document.body.classList.add('has-bar-ruler');
        const { total, parts } = model;
        track.setAttribute('aria-valuemax', String(total));

        const partsEl = $('barRulerParts');
        partsEl.innerHTML = '';
        if (parts.length) {
            parts.forEach((p, i) => {
                const el = document.createElement('button');
                el.type = 'button';
                el.className = `bar-ruler-part tone-${i % 2}`;
                el.style.flexGrow = String(p.endBar - p.startBar + 1);
                el.dataset.start = String(p.startBar);
                el.dataset.index = String(i);
                el.title = `${p.name}, bars ${p.startBar} to ${p.endBar}`;
                el.innerHTML = `<span class="bar-ruler-part-name" data-full="${escapeHtml(p.name)}" data-short="${escapeHtml(p.short)}"></span>`;
                partsEl.appendChild(el);
            });
        }
        partsEl.hidden = !parts.length;
        track.classList.toggle('has-parts', parts.length > 0);

        // Bar numbers: about one every 60px, on round steps
        const ticksEl = $('barRulerTicks');
        ticksEl.innerHTML = '';
        const width = track.clientWidth || 600;
        const stepOptions = [1, 2, 4, 5, 8, 10, 16, 20, 25, 32, 50, 100];
        const perBarPx = width / total;
        const step = stepOptions.find((s) => s * perBarPx >= 44) || 100;
        for (let b = 1; b <= total; b += (b === 1 ? step - 1 || 1 : step)) {
            const t = document.createElement('span');
            t.className = 'bar-ruler-tick';
            t.style.left = `${((b - 1) / total) * 100}%`;
            t.textContent = String(b);
            ticksEl.appendChild(t);
        }
        fitLabels();
        updateLoop();
        updateHead();
        renderSyncLane();
        const info = $('barRulerInfoBtn');
        info.hidden = !model.marks.length;
        $('barRulerLoopBtn').hidden = !parts.length;
    }


    // Sync coverage under the ruler: solid where bars follow the recording, dashed where they do not, a notch per
    // point, amber for a point that looks wrong. Read from the song's newest sync record; hidden when it has none.
    function renderSyncLane() {
        const lane = $('barRulerSync');
        lane.innerHTML = '';
        lane.hidden = true;
        if (!model) return;
        let record = null;
        try { record = listRecords(getSongKey() || '')[0] || null; } catch (_) { record = null; }
        ensureTimeline();
        if (!record || !model.timeline) return;
        const bars = model.timeline.bars;
        const toMaster = (f) => {
            const i = Math.min(bars.length - 1, Math.max(0, Math.floor(f)));
            return Math.min(1, (bars[i].barIndex + (f - i)) / model.total);
        };
        const view = buildTimelineModel({ timeline: model.timeline, points: record.points, axis: 'bars' });
        const total = view.totalBars || bars.length;
        const base = document.createElement('div');
        base.className = 'bar-ruler-sync-base';
        lane.appendChild(base);
        for (const g of view.gaps) {
            const el = document.createElement('div');
            el.className = 'bar-ruler-sync-gap';
            const x0 = toMaster(g.x0 * total);
            const x1 = g.x1 >= 1 ? 1 : toMaster(g.x1 * total);
            el.style.left = `${x0 * 100}%`;
            el.style.width = `${Math.max(0, x1 - x0) * 100}%`;
            lane.appendChild(el);
        }
        for (const m of view.markers) {
            const el = document.createElement('div');
            el.className = `bar-ruler-sync-point${m.flag ? ' is-flagged' : ''}`;
            el.style.left = `${toMaster(m.barFraction) * 100}%`;
            lane.appendChild(el);
        }
        const flagged = view.markers.filter((m) => m.flag).length;
        lane.title = `Recording synced: ${view.markers.length} point${view.markers.length === 1 ? '' : 's'}`
            + (view.gaps.length ? `, ${view.gaps.length} unsynced stretch${view.gaps.length === 1 ? '' : 'es'}` : '')
            + (flagged ? `, ${flagged} to check` : '');
        lane.hidden = false;
    }
    window.addEventListener(SYNC_CHANGED_EVENT, () => { if (model) renderSyncLane(); });

    // Full name when the block is wide enough, else the short one, else nothing
    function fitLabels() {
        if (!model) return;
        const width = track.clientWidth || 600;
        track.querySelectorAll('.bar-ruler-part-name').forEach((el) => {
            const blockPx = (el.parentElement.style.flexGrow / model.total) * width;
            const full = el.dataset.full;
            const short = el.dataset.short;
            if (blockPx >= full.length * 7.5 + 14) el.textContent = full;
            else if (blockPx >= short.length * 8 + 12) el.textContent = short;
            else el.textContent = '';
        });
    }

    function updateHead() {
        if (!model) return;
        const { total, parts } = model;
        const head = $('barRulerHead');
        const frac = Math.min(1, Math.max(0, (current.bar - 1 + current.pos) / total));
        head.style.transform = `translateX(${(frac * (track.clientWidth || 0)).toFixed(1)}px)`;
        track.setAttribute('aria-valuenow', String(current.bar));
        const part = partAtBar(parts, current.bar);
        $('barRulerReadout').textContent = part
            ? `${part.name}, bar ${current.bar} of ${total}`
            : `Bar ${current.bar} of ${total}`;
        track.querySelectorAll('.bar-ruler-part').forEach((el) => {
            el.classList.toggle('is-current', part && Number(el.dataset.start) === part.startBar);
        });
        const loopBtn = $('barRulerLoopBtn');
        const looping = Boolean(part) && synthPlayerState.loopEnabled
            && synthPlayerState.loopStartMeasure === part.startBar && synthPlayerState.loopEndMeasure === part.endBar;
        loopBtn.classList.toggle('active', looping);
        loopBtn.setAttribute('aria-pressed', String(looping));
    }

    function updateLoop() {
        const el = $('barRulerLoop');
        if (!model || !synthPlayerState.loopEnabled) { el.hidden = true; return; }
        const s = synthPlayerState.loopStartMeasure;
        const e = synthPlayerState.loopEndMeasure;
        el.hidden = false;
        el.style.left = `${((s - 1) / model.total) * 100}%`;
        el.style.width = `${((e - s + 1) / model.total) * 100}%`;
    }

    function seekToBar(barNumber) {
        const { api, score } = getPlayerContext();
        const mb = score?.masterBars?.[barNumber - 1];
        if (!api || !mb) return;
        const lookup = getMidiTickLookup(api);
        let tick = mb.start;
        try {
            const t = lookup?.getMasterBarStart?.(mb);
            if (typeof t === 'number' && !Number.isNaN(t)) tick = t;
        } catch (_) { /* fall back to the notation tick */ }
        api.tickPosition = tick;
        current = { bar: barNumber, pos: 0 };
        updateHead();
    }

    function barFromPointer(ev) {
        const rect = track.getBoundingClientRect();
        const frac = Math.min(0.9999, Math.max(0, (ev.clientX - rect.left) / rect.width));
        return Math.floor(frac * model.total) + 1;
    }

    let dragging = false;
    track.addEventListener('pointerdown', (ev) => {
        if (!model) return;
        dragging = true;
        track.setPointerCapture?.(ev.pointerId);
        seekToBar(barFromPointer(ev));
    });
    track.addEventListener('pointermove', (ev) => { if (dragging && model) seekToBar(barFromPointer(ev)); });
    const stopDrag = () => { dragging = false; };
    track.addEventListener('pointerup', stopDrag);
    track.addEventListener('pointercancel', stopDrag);
    track.addEventListener('keydown', (ev) => {
        if (!model) return;
        const delta = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
        if (!delta) return;
        ev.preventDefault();
        seekToBar(Math.min(model.total, Math.max(1, current.bar + delta)));
    });

    $('barRulerLoopBtn').addEventListener('click', () => {
        if (!model) return;
        const part = partAtBar(model.parts, current.bar);
        if (!part) return;
        const same = synthPlayerState.loopEnabled && synthPlayerState.loopStartMeasure === part.startBar
            && synthPlayerState.loopEndMeasure === part.endBar;
        synthPlayerState.loopEnabled = !same;
        synthPlayerState.loopStartMeasure = part.startBar;
        synthPlayerState.loopEndMeasure = part.endBar;
        applyLoopSettings();
        updateSynthUI();
        updateLoop();
        updateHead();
    });

    $('barRulerInfoBtn').addEventListener('click', () => {
        const panel = $('barRulerInfo');
        const open = panel.hidden;
        if (open && model) {
            panel.innerHTML = `<div class="small text-white-50 mb-1">What the file contains</div>`
                + `<ul class="bar-ruler-marks">${model.marks.map((m) =>
                    `<li><span class="bar-ruler-mark-bar">Bar ${m.bar}</span> ${escapeHtml(m.raw || '(blank)')}</li>`).join('')}</ul>`;
        }
        panel.hidden = !open;
        $('barRulerInfoBtn').setAttribute('aria-expanded', String(open));
    });

    onTransportEvent((e) => {
        if (e.type === 'attached') {
            buildModel();
            current = { bar: 1, pos: 0 };
            render();
        } else if (e.type === 'detached') {
            model = null;
            render();
        } else if (e.type === 'position') {
            if (!model) return;
            ensureTimeline();
            const at = model.timeline ? tickToPosition(model.timeline, e.tick) : null;
            if (at) current = { bar: at.barIndex + 1, pos: at.pos };
            updateHead();
        } else if (e.type === 'loop') {
            updateLoop();
            updateHead();
        }
    });

    window.addEventListener('resize', () => { if (model) { buildModel(); render(); } });
    // The ruler is part of the reader; hide it in the library
    new MutationObserver(() => {
        bar.classList.toggle('is-in-library', document.body.classList.contains('library-view-active'));
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
