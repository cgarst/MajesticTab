// audioSync/scoreRecordingStrip.js
// The recording bar for Guitar Pro tabs: the same two-bar layout the text and PDF tabs have. While Original is the
// selected sound, the recording's own progress (time, a track with ticks at the sync points, and its sync state) sits
// directly above the bar ruler. "Sync" (or "Edit sync" once points exist) lives here and opens the Sync sheet, so the Original panel only chooses
// the source. The sheet drives the existing sync controls (tap mode, the point editor) rather than copying them.

import { getSongKey, playerState } from '../soundPlayer.js';
import { getActiveRecording, getActiveMedia, getEmbeddedSyncPoints } from './realAudioController.js';
import { loadRecord, SYNC_CHANGED_EVENT } from './syncStore.js';
import { sessionPointsFor, isJamGuestFollowing, JAM_BRIDGE_EVENT } from './jamBridge.js';
import { isTvMode } from '../tvMode.js';
import { midiSynthActive } from '../classtab/midiSynth.js';
import { openSyncSheet, syncStateText, describeSync, recordingName } from './syncSheet.js';

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
        <span class="rec-marks"></span><i class="rec-fill"></i><i class="rec-head"></i>
      </div>
      <span class="rec-end"><span class="rec-status" role="status"></span><span class="rec-actions"></span></span>`;
    slot.prepend(strip);
    const timeEl = strip.querySelector('.rec-time');
    const track = strip.querySelector('.rec-track');
    const fill = strip.querySelector('.rec-fill');
    const head = strip.querySelector('.rec-head');
    const marksEl = strip.querySelector('.rec-marks');
    const statusEl = strip.querySelector('.rec-status');
    const actionsEl = strip.querySelector('.rec-actions');

    let rec = null;
    let recKey = '';
    let points = [];
    let fromHost = false;
    let summary = { full: false, flaggedBar: null, flagKind: null, gapBars: 0 };
    let origin = null;
    let drawnKey = '';

    const prefixOf = (r) => (r.kind === 'local' ? 'af' : 'yt');
    const canAuthor = () => Boolean(rec) && rec.kind !== 'embedded' && !isTvMode() && !(rec.kind === 'youtube' && isJamGuestFollowing());

    function readPoints() {
        points = [];
        fromHost = false;
        summary = { full: false, flaggedBar: null, flagKind: null, gapBars: 0 };
        origin = null;
        if (!rec) return;
        const host = rec.kind === 'embedded' ? null : sessionPointsFor(rec.media);
        const record = rec.kind === 'embedded' ? { points: getEmbeddedSyncPoints() } : host ? { points: host } : loadRecord(getSongKey(), rec.media);
        points = record?.points || [];
        origin = record?.media?.origin || null;
        fromHost = Boolean(host);
        if (!points.length) return;
        summary = describeSync(points);
    }

    function draw(force = false) {
        const dur = rec && durationOf(rec);
        const key = `${recKey}|${points.length}|${summary.full}|${summary.flaggedBar}|${canAuthor()}|${dur}`;
        if (!force && key === drawnKey) return;
        drawnKey = key;
        strip.classList.toggle('is-synced', points.length > 0);
        const n = points.length;
        const label = !n ? 'Not synced' : syncStateText(n, summary, fromHost);
        const hint = !n ? 'The recording plays on its own. The cursor won’t follow it until you add sync points.' : '';
        if (!canAuthor()) {
            statusEl.textContent = label;
            if (hint) statusEl.title = hint;
            else statusEl.removeAttribute('title');
            actionsEl.innerHTML = '';
        } else {
            // One door: the status label itself opens the Sync sheet
            statusEl.textContent = '';
            statusEl.removeAttribute('title');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ct-text';
            btn.dataset.act = 'sync';
            btn.textContent = label;
            if (hint) btn.title = hint;
            btn.setAttribute('aria-label', `${label} — open sync options`);
            actionsEl.replaceChildren(btn);
        }
        marksEl.replaceChildren();
        if (dur) {
            // A tab with hundreds of points would paint the whole track solid and hide the position: draw at most one
            // tick per 4px of track
            const width = track.clientWidth || 160;
            let lastPx = -Infinity;
            for (const p of [...points].sort((a, b) => a.timeMs - b.timeMs)) {
                const px = Math.min(1, p.timeMs / dur) * width;
                if (px - lastPx < 4) continue;
                lastPx = px;
                const t = document.createElement('i');
                t.style.left = `${Math.min(100, (p.timeMs / dur) * 100)}%`;
                marksEl.appendChild(t);
            }
        }
    }

    actionsEl.addEventListener('click', (e) => {
        if (!e.target.closest('[data-act]') || !rec) return;
        const key = recKey;
        const opened = rec;
        openSyncSheet({
            prefix: prefixOf(opened),
            name: () => recordingName(opened.media),
            // Re-read on every call, so the sheet follows edits; a recording that changed under it shows nothing
            read: () => {
                if (key === recKey) readPoints();
                return { points: key === recKey ? points : [], summary, fromHost, media: key === recKey ? rec?.media : null, origin };
            }
        });
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
        // A MIDI file runs on a placeholder score; its tab is text, and the text recording bar covers it
        const isScore = Boolean(window.gpApi?.score) && !midiSynthActive;
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
        // The bar takes its place as soon as Original has a recording attached, not when the player has loaded it:
        // showing it on the first beat of play pushed the score and the dock up by the bar's height.
        const reserved = Boolean(rec) || (!hidden && Boolean(getActiveMedia()));
        strip.hidden = !reserved;
        document.body.classList.toggle('score-rec-strip-on', reserved);
        // A recording with no sync points can't be followed, so the score shows no cursor
        // Before its player has loaded the recording is not "active" yet, but it is attached: judge it by its saved points
        let noPoints = Boolean(rec) && points.length === 0;
        if (!rec && !hidden) {
            const media = getActiveMedia();
            if (media) {
                noPoints = media.kind === 'embedded' ? false
                    : media.kind === 'youtube' ? !loadRecord(getSongKey(), media)?.points?.length : true;
            }
        }
        document.body.classList.toggle('score-cursor-hidden', noPoints);
        if (!rec) return;
        const t = rec.source.getTimeMs() || 0;
        const dur = durationOf(rec);
        timeEl.textContent = dur ? `${fmtTime(t)} / ${fmtTime(dur)}` : fmtTime(t);
        const frac = dur ? Math.min(1, t / dur) : 0;
        fill.style.transform = `scaleX(${frac})`;
        head.style.left = `${frac * 100}%`;
        draw();
    }
    setInterval(tick, 150);
    tick();
}
