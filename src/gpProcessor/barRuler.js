// barRuler.js
// The reader's transport: a bar ruler in the bottom dock. It shows how a player thinks about position (bar
// numbers and the song's own sections), not minutes. Section names come from the file's marks
// (songSections.js); a file with no usable marks shows bar numbers only. Under the numbers a coverage lane shows
// which bars follow a synced recording. Drag to seek; the dock's loop button loops the current part.
// It never draws notation; AlphaTab owns that.

import { notePlaybackBar, onTransportEvent, getPlayerContext, getMidiTickLookup, synthPlayerState, applyLoopSettings, updateSynthUI, toggleMetronome } from './gpPlayer.js';
import { deriveSections, partAtBar, DEFAULT_MIN_BARS } from './songSections.js';
import { buildScoreTimeline, playedBarsFromLookup, tickToPosition, tickToScoreMs, tempoAtScoreMs } from '../audioSync/scorePositions.js';
import { buildTimelineModel } from '../audioSync/timelineModel.js';
import { listRecords, SYNC_CHANGED_EVENT } from '../audioSync/syncStore.js';
import { getSongKey } from '../youtubePlayer.js';
import { getAudioSyncSession } from '../audioSync/audioSyncController.js';

const MIN_BARS_KEY = 'majestictab.sectionMinBars';
const SVG_NS = 'http://www.w3.org/2000/svg';

function readMinBars() {
    try {
        const n = parseInt(localStorage.getItem(MIN_BARS_KEY), 10);
        return [1, 2, 4, 8].includes(n) ? n : DEFAULT_MIN_BARS;
    } catch (_) { return DEFAULT_MIN_BARS; }
}

function formatClock(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '0:00';
    const t = Math.floor(ms / 1000);
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
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
        <div class="fill" id="rulerFill"></div>
        <div class="loop" id="rulerLoop"></div>
        <svg id="rulerTicks" preserveAspectRatio="none" aria-hidden="true"></svg>
        <div class="ruler-labels" id="rulerLabels" aria-hidden="true"></div>
        <div class="ruler-lane" id="rulerLane" hidden></div>
      </div>
      <div class="head" id="rulerHead"></div>`;
    slot.appendChild(ruler);

    const $ = (id) => document.getElementById(id);
    const dock = $('mobilePlaybackDock');
    let model = null; // { total, parts, marks, timeline, score }
    let current = { bar: 1, pos: 0 };
    let marksPanel = null;

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
        const played = playedBarsFromLookup(getMidiTickLookup(api));
        if (played.length) model.timeline = buildScoreTimeline(played);
    }

    // ---- drawing ------------------------------------------------------------------------------------------

    function render() {
        dock?.classList.toggle('has-ruler', Boolean(model));
        ruler.hidden = !model;
        if (!model) return;
        const { total } = model;
        ruler.setAttribute('aria-valuemax', String(total));
        drawTicks();
        drawLabels();
        renderSyncLane();
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

    function drawLabels() {
        const { total, parts, major } = model;
        const box = $('rulerLabels');
        box.innerHTML = '';
        const width = ruler.clientWidth || 600;
        // Bar numbers on the major steps (1, then every `major`)
        for (let b = 1; b <= total; b += (b === 1 ? (major > 1 ? major - 1 : 1) : major)) {
            const em = document.createElement('em');
            em.textContent = String(b);
            em.style.left = `${((b - 1) / total) * 100}%`;
            box.appendChild(em);
        }
        // Section names, hidden when the next section starts too close
        parts.forEach((p, i) => {
            const x = ((p.startBar - 1) / total) * width;
            const nextX = i + 1 < parts.length ? ((parts[i + 1].startBar - 1) / total) * width : width;
            const room = nextX - x;
            let text = '';
            if (room >= p.name.length * 6.4 + 10) text = p.name;
            else if (room >= p.short.length * 7 + 8) text = p.short;
            if (!text) return;
            const mk = document.createElement('span');
            mk.className = 'mk';
            mk.textContent = text;
            mk.style.left = `${((p.startBar - 1) / total) * 100}%`;
            box.appendChild(mk);
        });
    }

    function updateHead() {
        if (!model) return;
        const { total, parts } = model;
        const frac = Math.min(1, Math.max(0, (current.bar - 1 + current.pos) / total));
        const w = ruler.clientWidth || 0;
        $('rulerHead').style.transform = `translate3d(${(frac * w).toFixed(1)}px,0,0)`;
        $('rulerFill').style.transform = `scaleX(${frac.toFixed(4)})`;
        ruler.setAttribute('aria-valuenow', String(current.bar));
        const part = partAtBar(parts, current.bar);
        ruler.setAttribute('aria-valuetext', part ? `${part.name}, bar ${current.bar} of ${total}` : `Bar ${current.bar} of ${total}`);
        const secEl = $('dockSection');
        const prefixEl = $('dockBarPrefix');
        if (secEl) {
            if (part && part.name && part.name !== 'Start') {
                secEl.textContent = `${part.name}, `;
                secEl.style.display = 'inline';
                if (prefixEl) prefixEl.textContent = 'bar ';
            } else {
                secEl.textContent = '';
                secEl.style.display = 'none';
                if (prefixEl) prefixEl.textContent = 'Bar ';
            }
        }
        const barEl = $('dockBar');
        if (barEl && barEl.textContent !== String(current.bar)) barEl.textContent = String(current.bar);
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

    // Sync coverage in the bottom lane: solid where bars follow the recording, dashed where they do not, a notch
    // per point, amber for a point that looks wrong. Read from the song's newest sync record.
    function renderSyncLane() {
        const lane = $('rulerLane');
        lane.innerHTML = '';
        lane.hidden = true;
        ruler.dataset.lane = '0';
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
        base.className = 'lane-base';
        lane.appendChild(base);
        for (const g of view.gaps) {
            const el = document.createElement('div');
            el.className = 'lane-gap';
            const x0 = toMaster(g.x0 * total);
            const x1 = g.x1 >= 1 ? 1 : toMaster(g.x1 * total);
            el.style.left = `${x0 * 100}%`;
            el.style.width = `${Math.max(0, x1 - x0) * 100}%`;
            lane.appendChild(el);
        }
        for (const m of view.markers) {
            const el = document.createElement('div');
            el.className = `lane-point${m.flag ? ' is-flagged' : ''}`;
            el.style.left = `${toMaster(m.barFraction) * 100}%`;
            lane.appendChild(el);
        }
        const flagged = view.markers.filter((m) => m.flag).length;
        lane.title = `Recording synced: ${view.markers.length} point${view.markers.length === 1 ? '' : 's'}`
            + (view.gaps.length ? `, ${view.gaps.length} unsynced stretch${view.gaps.length === 1 ? '' : 'es'}` : '')
            + (flagged ? `, ${flagged} to check` : '');
        lane.hidden = false;
        ruler.dataset.lane = '1';
    }
    window.addEventListener(SYNC_CHANGED_EVENT, () => { if (model) { renderSyncLane(); } });

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
    });
    ruler.addEventListener('pointermove', (ev) => { if (dragging && model) seekToBar(barFromPointer(ev)); });
    const stopDrag = () => { dragging = false; };
    ruler.addEventListener('pointerup', stopDrag);
    ruler.addEventListener('pointercancel', stopDrag);
    ruler.addEventListener('keydown', (ev) => {
        if (!model) return;
        const delta = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
        if (!delta) return;
        ev.preventDefault();
        ev.stopPropagation();
        seekToBar(Math.min(model.total, Math.max(1, current.bar + delta)));
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
            $('dockClock').textContent = '0:00 / 0:00';
        } else if (e.type === 'detached') {
            model = null;
            const secEl = $('dockSection');
            if (secEl) { secEl.textContent = ''; secEl.style.display = 'none'; }
            const prefixEl = $('dockBarPrefix');
            if (prefixEl) prefixEl.textContent = 'Bar ';
            render();
        } else if (e.type === 'position') {
            if (!model) return;
            ensureTimeline();
            const at = model.timeline ? tickToPosition(model.timeline, e.tick) : null;
            if (at) { current = { bar: at.barIndex + 1, pos: at.pos }; notePlaybackBar(current.bar, model.total); }
            updateHead();
            const clock = $('dockClock');
            if (clock) clock.textContent = `${formatClock(e.timeMs)} / ${formatClock(e.endMs)}`;
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

    window.addEventListener('resize', () => { if (model) { buildModel(); render(); } });
}
