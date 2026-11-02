// syncTimeline.js
// The sync timeline: one strip for the whole song showing where the sync points are, how the recording's tempo moves
// between them, which stretches have no points, and (for a local file) the waveform. The axis is the score's bars
// or the recording's time. Click to seek, drag a point to retime it (time axis), drag on empty space to select a
// range and delete its points. The geometry lives in timelineModel.js; this file draws it and handles the pointer.

import { buildTimelineModel } from './timelineModel.js';
import { formatTime } from './syncEdit.js';

const HEIGHT = 92;
const BADGE_H = 14;
const WAVE_TOP = 14;
const WAVE_H = 38;
const RIBBON_MID = 74;
const RIBBON_HALF = 14;
const HIT_PX = 7;
const DRAG_THRESHOLD_PX = 4;
const MIN_ZOOM = 1;
const MAX_ZOOM = 12;
const PEAKS_PER_SECOND = 50;

const FLAG_TEXT = {
    order: 'Out of order',
    tempo: 'Unusual tempo',
    short: 'Very short segment',
    long: 'Very long segment',
    missing: 'Not in the score'
};

/**
 * @param {object} opts
 * @param {HTMLElement} opts.host element to build the timeline in
 * @param {() => object|null} opts.getData `{ timeline, points, source, peaks, durationMs, selectedId }`, or null when
 *   there is nothing to show yet
 * @param {(points: Array) => void} opts.onChangePoints called with the new point list after a drag or a range delete
 * @param {(target: {mediaMs:number, scoreMs:number}) => void} opts.onSeek
 * @param {(id: string|null) => void} [opts.onSelect]
 * @param {(range: {scoreFrom:number, scoreTo:number}) => void} [opts.onRetap] when given, a selected range offers
 *   "Re-tap Range" (the range in score time)
 */
export function createSyncTimeline({ host, getData, onChangePoints, onSeek, onSelect, onRetap }) {
    host.innerHTML = `
      <div class="sync-tl">
        <div class="sync-tl-bar">
          <div class="hud-pill-group" role="group" aria-label="Timeline axis">
            <button type="button" class="btn btn-sm active" data-tl-axis="bars" title="Space the bars evenly">Bars</button>
            <button type="button" class="btn btn-sm" data-tl-axis="media" title="Space by time in the recording">Time</button>
          </div>
          <div class="hud-pill-group" role="group" aria-label="Timeline zoom">
            <button type="button" class="btn btn-sm" data-tl-zoom="out" title="Zoom out" aria-label="Zoom out"><i class="bi-dash-lg"></i></button>
            <button type="button" class="btn btn-sm" data-tl-zoom="in" title="Zoom in" aria-label="Zoom in"><i class="bi-plus-lg"></i></button>
          </div>
          <button type="button" class="btn btn-sm btn-theme-primary" data-tl-retap hidden>Re-tap Range</button>
          <button type="button" class="btn btn-sm btn-theme-danger" data-tl-delete hidden></button>
          <span class="small text-white-50 sync-tl-status" data-tl-status></span>
        </div>
        <div class="sync-tl-scroll">
          <div class="sync-tl-stack">
            <canvas class="sync-tl-canvas"></canvas>
            <canvas class="sync-tl-head" aria-label="Sync timeline. Click to seek."></canvas>
          </div>
        </div>
      </div>`;
    const scroller = host.querySelector('.sync-tl-scroll');
    const base = host.querySelector('.sync-tl-canvas');
    const head = host.querySelector('.sync-tl-head');
    const deleteBtn = host.querySelector('[data-tl-delete]');
    const retapBtn = host.querySelector('[data-tl-retap]');
    const status = host.querySelector('[data-tl-status]');

    let axis = 'bars';
    let zoom = 1;
    let model = null;
    let data = null;
    let width = 0;
    let range = null;          // { x0, x1 } as fractions of the axis
    let drag = null;           // pointer interaction in progress
    let dragPoints = null;     // points while a marker is being dragged
    let hover = null;
    let raf = 0;
    let destroyed = false;

    const css = () => {
        const s = getComputedStyle(base);
        const v = (name, fallback) => s.getPropertyValue(name).trim() || fallback;
        return {
            primary: v('--accent-primary', '#a855f7'), secondary: v('--accent-secondary', '#10b981'),
            muted: v('--text-muted', '#94a3b8'), dim: v('--text-dim', '#64748b'), text: v('--text-primary', '#f8fafc'),
            border: v('--border-subtle', 'rgba(147,51,234,0.16)'), card: v('--bg-card-solid', '#151022')
        };
    };

    function size() {
        const w = Math.max(240, Math.round(scroller.clientWidth * zoom));
        const dpr = window.devicePixelRatio || 1;
        width = w;
        for (const c of [base, head]) {
            c.style.width = `${w}px`;
            c.style.height = `${HEIGHT}px`;
            c.width = Math.round(w * dpr);
            c.height = Math.round(HEIGHT * dpr);
        }
        return dpr;
    }

    function currentPoints() {
        return dragPoints || data.points;
    }

    function rebuild() {
        data = getData();
        if (!data?.timeline?.bars.length) {
            model = null;
            return false;
        }
        model = buildTimelineModel({ timeline: data.timeline, points: currentPoints(), axis, durationMs: data.durationMs ?? data.source?.durationMs ?? null });
        return true;
    }

    // --- Drawing ----------------------------------------------------------------------------------------------------

    function sourceColor(c, source) {
        return source === 'tap' ? c.primary : source === 'auto' ? c.secondary : c.text;
    }

    function drawWave(ctx, c, dpr) {
        const peaks = data.peaks;
        const mid = WAVE_TOP + WAVE_H / 2;
        ctx.fillStyle = c.border;
        ctx.fillRect(0, mid, width, 1);
        if (!peaks?.length) {
            ctx.fillStyle = c.dim;
            ctx.font = '11px system-ui, sans-serif';
            ctx.fillText(data.source?.kind === 'local' ? 'Waveform unavailable for this file' : 'No waveform for YouTube', 8, mid - 6);
            return;
        }
        ctx.fillStyle = c.dim;
        for (let px = 0; px < width; px++) {
            const a = model.xToMediaMs(px / width);
            const b = model.xToMediaMs((px + 1) / width);
            const from = Math.floor(Math.min(a, b) / 1000 * PEAKS_PER_SECOND);
            const to = Math.max(from + 1, Math.ceil(Math.max(a, b) / 1000 * PEAKS_PER_SECOND));
            let peak = 0;
            for (let i = from; i < to && i < peaks.length; i++) if (peaks[i] > peak) peak = peaks[i];
            const half = Math.max(0.5, (peak / 255) * (WAVE_H / 2 - 1));
            ctx.fillRect(px, mid - half, 1, half * 2);
        }
    }

    function hatch(ctx, x0, y0, w, h, color) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, y0, w, h);
        ctx.clip();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = x0 - h; x < x0 + w; x += 7) {
            ctx.moveTo(x, y0 + h);
            ctx.lineTo(x + h, y0);
        }
        ctx.stroke();
        ctx.restore();
    }

    function drawStatic() {
        if (destroyed) return;
        const ok = rebuild();
        const dpr = size();
        const ctx = base.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, HEIGHT);
        const c = css();
        if (!ok) {
            ctx.fillStyle = c.dim;
            ctx.font = '12px system-ui, sans-serif';
            ctx.fillText('Open a tab to see its sync timeline', 8, HEIGHT / 2);
            status.textContent = '';
            drawHead();
            return;
        }
        ctx.fillStyle = c.card;
        ctx.fillRect(0, WAVE_TOP, width, HEIGHT - WAVE_TOP);
        drawWave(ctx, c, dpr);

        // Tempo ribbon: above the line is faster than written, below is slower
        ctx.fillStyle = c.border;
        ctx.fillRect(0, RIBBON_MID, width, 1);
        for (const s of model.segments) {
            const x0 = s.x0 * width;
            const w = Math.max(1, (s.x1 - s.x0) * width);
            if (s.ratio === null) {
                hatch(ctx, x0, RIBBON_MID - RIBBON_HALF, w, RIBBON_HALF * 2, '#ef6c78');
                continue;
            }
            const lg = Math.max(-2, Math.min(2, Math.log2(s.ratio)));
            const h = (lg / 2) * RIBBON_HALF;
            const odd = s.flag === 'tempo' || s.flag === 'order';
            ctx.fillStyle = odd ? '#ef6c78' : s.flag ? '#e0a73a' : Math.abs(lg) < 0.1 ? c.secondary : c.primary;
            ctx.globalAlpha = 0.85;
            ctx.fillRect(x0, h >= 0 ? RIBBON_MID - h : RIBBON_MID, w, Math.max(2, Math.abs(h)));
            ctx.globalAlpha = 1;
        }

        // Stretches with no points
        ctx.font = '11px system-ui, sans-serif';
        for (const g of model.gaps) {
            const x0 = g.x0 * width;
            const w = (g.x1 - g.x0) * width;
            if (w < 2) continue;
            hatch(ctx, x0, WAVE_TOP, w, HEIGHT - WAVE_TOP, c.border);
            const label = w > 120 ? `no points, ${g.bars} bar${g.bars === 1 ? '' : 's'}` : w > 34 ? `${g.bars} bars` : '';
            if (label) {
                ctx.fillStyle = c.card;
                const tw = ctx.measureText(label).width + 8;
                ctx.fillRect(x0 + w / 2 - tw / 2, WAVE_TOP + 2, tw, 15);
                ctx.fillStyle = c.muted;
                ctx.fillText(label, x0 + w / 2 - tw / 2 + 4, WAVE_TOP + 13);
            }
        }

        // Points
        for (const m of model.markers) {
            const x = Math.round(m.x * width) + 0.5;
            const selected = m.id === data.selectedId;
            ctx.strokeStyle = sourceColor(c, m.source);
            ctx.lineWidth = selected ? 3 : 1.5;
            ctx.beginPath();
            ctx.moveTo(x, WAVE_TOP);
            ctx.lineTo(x, HEIGHT);
            ctx.stroke();
            if (m.flag) {
                ctx.fillStyle = '#ef6c78';
                ctx.beginPath();
                ctx.arc(x, BADGE_H / 2, 5, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#fff';
                ctx.font = 'bold 9px system-ui, sans-serif';
                ctx.fillText('!', x - 1.5, BADGE_H / 2 + 3.5);
            }
        }
        const flagged = model.markers.filter(m => m.flag).length;
        const parts = [`${model.markers.length} point${model.markers.length === 1 ? '' : 's'}`];
        if (flagged) parts.push(`${flagged} to check`);
        if (model.unplaced) parts.push(`${model.unplaced} not in this score`);
        status.textContent = parts.join(' · ');
        drawHead();
    }

    function drawHead() {
        if (destroyed) return;
        const dpr = window.devicePixelRatio || 1;
        const ctx = head.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, HEIGHT);
        if (!model) return;
        const c = css();
        if (range) {
            ctx.fillStyle = c.primary;
            ctx.globalAlpha = 0.22;
            ctx.fillRect(range.x0 * width, WAVE_TOP, (range.x1 - range.x0) * width, HEIGHT - WAVE_TOP);
            ctx.globalAlpha = 1;
        }
        const src = data.source;
        if (src) {
            const x = model.mediaMsToX(src.getTimeMs()) * width;
            ctx.fillStyle = c.secondary;
            ctx.fillRect(Math.round(x), 0, 2, HEIGHT);
            if (zoom > 1 && src.isPlaying() && !drag) keepInView(x);
        }
    }

    function keepInView(x) {
        const left = scroller.scrollLeft;
        const view = scroller.clientWidth;
        if (x < left + view * 0.1 || x > left + view * 0.9) scroller.scrollLeft = Math.max(0, x - view * 0.3);
    }

    function loop() {
        raf = 0;
        if (destroyed) return;
        drawHead();
        if (data?.source?.isPlaying() && host.offsetParent !== null) raf = requestAnimationFrame(loop);
    }

    function kick() {
        if (!raf && !destroyed) raf = requestAnimationFrame(loop);
    }

    // --- Pointer ----------------------------------------------------------------------------------------------------

    const xFrac = (e) => {
        const r = head.getBoundingClientRect();
        return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    };

    function markerAt(e) {
        if (!model) return null;
        const r = head.getBoundingClientRect();
        const px = e.clientX - r.left;
        let best = null;
        for (const m of model.markers) {
            const d = Math.abs(m.x * r.width - px);
            if (d <= HIT_PX && (!best || d < best.d)) best = { m, d };
        }
        return best?.m || null;
    }

    function seekTo(x) {
        onSeek({ mediaMs: model.xToMediaMs(x), scoreMs: model.xToScoreMs(x) });
        drawHead();
    }

    function pointsInRange() {
        return model ? model.markers.filter(m => m.x >= range.x0 && m.x <= range.x1).map(m => m.id) : [];
    }

    function updateDeleteButton() {
        retapBtn.hidden = !range || !onRetap;
        const ids = range ? pointsInRange() : [];
        deleteBtn.hidden = !range || !ids.length;
        deleteBtn.textContent = `Delete ${ids.length} Point${ids.length === 1 ? '' : 's'}`;
    }

    head.addEventListener('pointerdown', (e) => {
        if (!model || e.button > 0) return;
        try { head.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
        const marker = markerAt(e);
        drag = { startX: e.clientX, x0: xFrac(e), marker, moved: false, kind: marker && axis === 'media' ? 'marker' : 'pending' };
        if (!marker) { range = null; updateDeleteButton(); }
    });

    head.addEventListener('pointermove', (e) => {
        if (!model) return;
        if (!drag) {
            const m = markerAt(e);
            const seg = !m && model.segments.find(s => xFrac(e) >= s.x0 && xFrac(e) <= s.x1);
            const text = m
                ? `Bar ${bar(m)} at ${formatTime(m.timeMs)} (${m.source})${m.flag ? `. ${FLAG_TEXT[m.flag]}` : ''}`
                : seg && seg.ratio !== null ? `${seg.bpm ? `${Math.round(seg.bpm)} bpm, ` : ''}${seg.ratio.toFixed(2)}x the written tempo${seg.flag ? `. ${FLAG_TEXT[seg.flag]}` : ''}` : '';
            if (head.title !== text) head.title = text;
            head.style.cursor = m && axis === 'media' ? 'ew-resize' : 'pointer';
            return;
        }
        if (Math.abs(e.clientX - drag.startX) > DRAG_THRESHOLD_PX) drag.moved = true;
        if (!drag.moved) return;
        const x = xFrac(e);
        if (drag.kind === 'marker') {
            const ms = Math.round(model.xToMediaMs(x));
            const sorted = [...data.points].sort((a, b) => a.timeMs - b.timeMs);
            const i = sorted.findIndex(p => p.id === drag.marker.id);
            const lo = i > 0 ? sorted[i - 1].timeMs + 1 : 0;
            const hi = i < sorted.length - 1 ? sorted[i + 1].timeMs - 1 : Infinity;
            dragPoints = data.points.map(p => (p.id === drag.marker.id ? { ...p, timeMs: Math.min(hi, Math.max(lo, ms)) } : p));
            drawStatic();
        } else {
            drag.kind = 'range';
            range = { x0: Math.min(drag.x0, x), x1: Math.max(drag.x0, x) };
            updateDeleteButton();
            drawHead();
        }
    });

    head.addEventListener('pointerup', (e) => {
        if (!drag) return;
        const d = drag;
        drag = null;
        if (!model) return;
        if (!d.moved) {
            if (d.marker) {
                onSelect?.(d.marker.id);
                onSeek({ mediaMs: d.marker.timeMs, scoreMs: d.marker.scoreMs });
            } else {
                onSelect?.(null);
                seekTo(xFrac(e));
            }
            drawStatic();
        } else if (d.kind === 'marker' && dragPoints) {
            const next = dragPoints;
            dragPoints = null;
            onChangePoints(next);
        }
        updateDeleteButton();
    });

    head.addEventListener('pointercancel', () => { drag = null; if (dragPoints) { dragPoints = null; drawStatic(); } });

    head.addEventListener('wheel', (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        setZoom(zoom * (e.deltaY < 0 ? 1.25 : 0.8), xFrac(e));
    }, { passive: false });

    function bar(m) {
        const entry = data.timeline.bars[Math.min(data.timeline.bars.length - 1, Math.floor(m.barFraction))];
        return `${entry.barIndex + 1}${entry.occurrence ? ` (pass ${entry.occurrence + 1})` : ''}`;
    }

    function setZoom(next, anchor = 0.5) {
        const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
        if (z === zoom) return;
        const frac = scroller.scrollWidth ? (scroller.scrollLeft + scroller.clientWidth * anchor) / scroller.scrollWidth : anchor;
        zoom = z;
        drawStatic();
        scroller.scrollLeft = frac * scroller.scrollWidth - scroller.clientWidth * anchor;
    }

    host.querySelectorAll('[data-tl-axis]').forEach((b) => b.addEventListener('click', () => {
        axis = b.dataset.tlAxis;
        range = null;
        host.querySelectorAll('[data-tl-axis]').forEach((o) => o.classList.toggle('active', o === b));
        updateDeleteButton();
        drawStatic();
    }));
    host.querySelectorAll('[data-tl-zoom]').forEach((b) => b.addEventListener('click', () => setZoom(zoom * (b.dataset.tlZoom === 'in' ? 1.6 : 0.625))));
    retapBtn.addEventListener('click', () => {
        if (!range || !model) return;
        const scoreFrom = model.xToScoreMs(range.x0);
        const scoreTo = model.xToScoreMs(range.x1);
        range = null;
        updateDeleteButton();
        drawHead();
        onRetap({ scoreFrom, scoreTo });
    });
    deleteBtn.addEventListener('click', () => {
        if (!range) return;
        const ids = new Set(pointsInRange());
        range = null;
        updateDeleteButton();
        onChangePoints(data.points.filter(p => !ids.has(p.id)));
    });

    const ro = new ResizeObserver(() => { if (host.offsetParent !== null) drawStatic(); });
    ro.observe(scroller);

    return {
        /** Rebuild and redraw after the points, the score or the recording changed. */
        refresh() {
            if (host.offsetParent === null) return;
            range = null;
            updateDeleteButton();
            drawStatic();
            kick();
        },
        /** Redraw only the playhead (cheap); call when playback starts. */
        wake: kick,
        destroy() {
            destroyed = true;
            cancelAnimationFrame(raf);
            ro.disconnect();
            host.replaceChildren();
        }
    };
}
