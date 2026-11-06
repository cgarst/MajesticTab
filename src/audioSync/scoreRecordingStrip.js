// audioSync/scoreRecordingStrip.js
// The recording bar for Guitar Pro tabs: the same two-bar layout the text and PDF tabs have. While Original is the
// selected sound, the recording's own progress (time, a track with ticks at the sync points, and its sync state) sits
// directly above the bar ruler. "Add sync points" lives here, so the Original panel only chooses the source.
// The bar drives the existing sync controls (tap to sync, which links on to the point editor) rather than copying them.

import { getSongKey, playerState } from '../youtubePlayer.js';
import { getActiveRecording } from './realAudioController.js';
import { loadRecord, SYNC_CHANGED_EVENT } from './syncStore.js';
import { sessionPointsFor, isJamGuestFollowing, JAM_BRIDGE_EVENT } from './jamBridge.js';
import { buildTimelineModel } from './timelineModel.js';
import { buildScoreTimeline, playedBarsFromLookup } from './scorePositions.js';
import { getMidiTickLookup } from '../gpProcessor/gpPlayer.js';
import { isTvMode } from '../tvMode.js';

const $ = (id) => document.getElementById(id);

const fmtTime = (ms) => {
    const total = Math.max(0, Math.floor((ms || 0) / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

const durationOf = (rec) => rec.source.durationMs || (rec.kind === 'youtube' && playerState.duration ? playerState.duration * 1000 : null);

export function initScoreRecordingStrip() {
    const slot = $('dockRulerSlot');
    if (!slot || $('scoreRecStrip')) return;

    const strip = document.createElement('aside');
    strip.id = 'scoreRecStrip';
    strip.className = 'rec-strip in-dock';
    strip.hidden = true;
    strip.setAttribute('aria-label', 'Recording');
    strip.innerHTML = `
      <span class="rec-time" aria-hidden="true">0:00</span>
      <div class="rec-track" role="slider" tabindex="0" aria-label="Recording position">
        <i class="rec-fill"></i><span class="rec-marks"></span>
      </div>
      <span class="rec-status" role="status"></span>
      <span class="rec-actions"></span>`;
    slot.prepend(strip);
    const timeEl = strip.querySelector('.rec-time');
    const track = strip.querySelector('.rec-track');
    const fill = strip.querySelector('.rec-fill');
    const marksEl = strip.querySelector('.rec-marks');
    const statusEl = strip.querySelector('.rec-status');
    const actionsEl = strip.querySelector('.rec-actions');

    let rec = null;
    let recKey = '';
    let points = [];
    let fromHost = false;
    let summary = { full: false, flaggedBar: null };
    let drawnKey = '';

    const prefixOf = (r) => (r.kind === 'local' ? 'af' : 'yt');
    const canAuthor = () => Boolean(rec) && !isTvMode() && !(rec.kind === 'youtube' && isJamGuestFollowing());

    function readPoints() {
        points = [];
        fromHost = false;
        summary = { full: false, flaggedBar: null };
        if (!rec) return;
        const host = sessionPointsFor(rec.media);
        const record = host ? { points: host } : loadRecord(getSongKey(), rec.media);
        points = record?.points || [];
        fromHost = Boolean(host);
        if (!points.length) return;
        // Coverage: a bar with no point drifts, a flagged point looks late against the sound
        try {
            const api = window.gpApi;
            const lookup = api && getMidiTickLookup(api);
            const played = lookup ? playedBarsFromLookup(lookup) : [];
            if (played.length) {
                const view = buildTimelineModel({ timeline: buildScoreTimeline(played), points, axis: 'bars' });
                const flagged = view.markers.find((m) => m.flag);
                summary = { full: view.gaps.length === 0, flaggedBar: flagged ? flagged.barIndex + 1 : null };
            }
        } catch { /* the bar still shows the point count */ }
    }

    function draw(force = false) {
        const dur = rec && durationOf(rec);
        const key = `${recKey}|${points.length}|${summary.full}|${summary.flaggedBar}|${canAuthor()}|${dur}`;
        if (!force && key === drawnKey) return;
        drawnKey = key;
        strip.classList.toggle('is-synced', points.length > 0);
        const n = points.length;
        if (!n) {
            statusEl.textContent = 'Not synced';
            statusEl.title = 'The recording plays on its own. The cursor won’t follow it until you add sync points.';
        } else {
            statusEl.removeAttribute('title');
            const state = summary.flaggedBar ? `Check bar ${summary.flaggedBar}` : summary.full ? 'Synced' : 'Partly synced';
            statusEl.textContent = `${state} · ${n} ${n === 1 ? 'point' : 'points'}${fromHost ? ' from the host' : ''}`;
        }
        if (!canAuthor()) actionsEl.innerHTML = '';
        else if (!n) actionsEl.innerHTML = '<button type="button" class="ct-text" data-act="sync">Add points</button>';
        else actionsEl.innerHTML = '<button type="button" class="ct-text" data-act="sync">Add points</button>';
        marksEl.replaceChildren();
        if (dur) {
            for (const p of points) {
                const t = document.createElement('i');
                t.style.left = `${Math.min(100, (p.timeMs / dur) * 100)}%`;
                marksEl.appendChild(t);
            }
        }
    }

    actionsEl.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (!act || !rec) return;
        // The controls that own the sync flow live in the Original panel; they check TV and Jam guest rules themselves
        $(`${prefixOf(rec)}SyncTapBtn`)?.click();
    });

    function seekFromPointer(e) {
        const dur = rec && durationOf(rec);
        if (!dur) return;
        const r = track.getBoundingClientRect();
        rec.source.seek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur);
    }
    let dragging = false;
    track.addEventListener('pointerdown', (e) => { dragging = true; track.setPointerCapture(e.pointerId); seekFromPointer(e); });
    track.addEventListener('pointermove', (e) => { if (dragging) seekFromPointer(e); });
    track.addEventListener('pointerup', () => { dragging = false; });
    track.addEventListener('pointercancel', () => { dragging = false; });
    track.addEventListener('keydown', (e) => {
        if (!rec) return;
        const step = { ArrowLeft: -5000, ArrowRight: 5000, ArrowDown: -5000, ArrowUp: 5000 }[e.key];
        if (step) { e.preventDefault(); e.stopPropagation(); rec.source.seek(Math.max(0, rec.source.getTimeMs() + step)); }
    });

    const refresh = () => { readPoints(); draw(true); };
    window.addEventListener(SYNC_CHANGED_EVENT, refresh);
    window.addEventListener(JAM_BRIDGE_EVENT, refresh);

    function tick() {
        const isScore = Boolean(window.gpApi?.score);
        const originalOn = Boolean($('mobileYtToggleBtn')?.classList.contains('active-audio-mode'));
        const hidden = !isScore || !originalOn || document.body.classList.contains('library-view-active')
            || document.body.classList.contains('sync-mode'); // tap mode has its own toolbar
        const next = hidden ? null : getActiveRecording();
        const nextKey = next ? `${next.kind}|${JSON.stringify(next.media)}|${getSongKey()}` : '';
        if (nextKey !== recKey) {
            rec = next;
            recKey = nextKey;
            refresh();
        }
        strip.hidden = !rec;
        document.body.classList.toggle('score-rec-strip-on', Boolean(rec));
        // A recording with no sync points can't be followed, so the score shows no cursor
        document.body.classList.toggle('score-cursor-hidden', Boolean(rec) && points.length === 0);
        if (!rec) return;
        const t = rec.source.getTimeMs() || 0;
        const dur = durationOf(rec);
        timeEl.textContent = dur ? `${fmtTime(t)} / ${fmtTime(dur)}` : fmtTime(t);
        fill.style.transform = `scaleX(${dur ? Math.min(1, t / dur) : 0})`;
        draw();
    }
    setInterval(tick, 150);
    tick();
}
