// tapCalibrationModal.js
// The "Calibrate tap offset" dialog (see tapCalibration.js for the maths): plays clicks at uneven times, collects the
// user's taps, and offers the measured delay as the tap offset. Opened from tap mode.

import { openModal, closeModal, wireModal } from '../gpProcessor/mixerPanel.js';
import {
    nextClickInterval, delayForTap, summarizeDelays, offsetFromDelay, SKIP_TAPS, MIN_TAPS_FOR_RESULT
} from './tapCalibration.js';

const LOOKAHEAD_MS = 150;
const KEEP_CLICKS = 12;
/** A spread wider than this means the taps are too uneven to trust. */
const UNSTEADY_SPREAD_MS = 60;

let wired = false;
let state = { latencyMs: 0, onApply: null };

const $ = (id) => document.getElementById(id);

function wire() {
    wired = true;
    const modal = $('tapCalModal');
    const flash = $('tapCalFlash');
    const tapBtn = $('tapCalTapBtn');
    const startBtn = $('tapCalStartBtn');
    const applyBtn = $('tapCalApplyBtn');
    const measuredEl = $('tapCalMeasured');
    const countEl = $('tapCalCount');
    const noteEl = $('tapCalNote');

    let ctx = null;
    let schedulerTimer = 0;
    let rafId = 0;
    let nextClickCtxSec = 0;
    let perfBaseMs = 0;     // performance.now() when the audio clock was 0
    let clicks = [];        // click times on the performance clock, ascending
    let flashes = [];       // click times on the audio clock, for the flash
    let delays = [];
    let lastPairedClick = null;
    let offset = null;

    const reset = () => {
        delays = [];
        lastPairedClick = null;
        offset = null;
        measuredEl.textContent = '–';
        countEl.textContent = '0 taps';
        noteEl.textContent = '';
        applyBtn.disabled = true;
    };

    const scheduleClicks = () => {
        while (nextClickCtxSec < ctx.currentTime + LOOKAHEAD_MS / 1000) {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.frequency.value = 1000;
            gain.gain.setValueAtTime(0.0001, nextClickCtxSec);
            gain.gain.exponentialRampToValueAtTime(0.6, nextClickCtxSec + 0.002);
            gain.gain.exponentialRampToValueAtTime(0.0001, nextClickCtxSec + 0.05);
            osc.connect(gain).connect(ctx.destination);
            osc.start(nextClickCtxSec);
            osc.stop(nextClickCtxSec + 0.06);
            flashes.push(nextClickCtxSec);
            clicks.push(perfBaseMs + nextClickCtxSec * 1000);
            if (clicks.length > KEEP_CLICKS) clicks.shift();
            nextClickCtxSec += nextClickInterval(Math.random()) / 1000;
        }
    };

    const animate = () => {
        if (flashes.length && ctx.currentTime >= flashes[0]) {
            flashes.shift();
            flash.classList.add('on');
            setTimeout(() => flash.classList.remove('on'), 90);
        }
        rafId = requestAnimationFrame(animate);
    };

    const stop = () => {
        clearInterval(schedulerTimer);
        cancelAnimationFrame(rafId);
        schedulerTimer = 0;
        try { ctx?.close(); } catch { /* already closed */ }
        ctx = null;
        flashes = [];
        clicks = [];
        flash.classList.remove('on');
        tapBtn.disabled = true;
        startBtn.textContent = 'Start Clicks';
    };

    const start = () => {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) {
            noteEl.textContent = 'This device cannot play the clicks.';
            return;
        }
        reset();
        ctx = new Ctx({ latencyHint: 'interactive' });
        ctx.resume?.();
        perfBaseMs = performance.now() - ctx.currentTime * 1000;
        nextClickCtxSec = ctx.currentTime + 0.8;
        scheduleClicks();
        schedulerTimer = setInterval(scheduleClicks, 50);
        rafId = requestAnimationFrame(animate);
        tapBtn.disabled = false;
        startBtn.textContent = 'Stop Clicks';
        noteEl.textContent = 'Tap each time you hear a click.';
    };

    const tap = (tapMs) => {
        if (!ctx) return;
        const paired = delayForTap(clicks, tapMs);
        // A second tap for the same click, or one with no click before it, is not a reaction
        if (!paired || paired.click === lastPairedClick) return;
        lastPairedClick = paired.click;
        delays.push(paired.delay);
        countEl.textContent = `${delays.length} ${delays.length === 1 ? 'tap' : 'taps'}`;
        const result = summarizeDelays(delays);
        if (!result) {
            noteEl.textContent = `Keep going: ${Math.max(0, SKIP_TAPS + MIN_TAPS_FOR_RESULT - delays.length)} more.`;
            return;
        }
        offset = offsetFromDelay(result.medianMs, state.latencyMs);
        measuredEl.textContent = `${result.medianMs} ms after the click (±${result.spreadMs})`;
        const parts = [];
        if (state.latencyMs > 0) parts.push(`Your audio latency setting of ${state.latencyMs} ms is already taken off, so the offset is ${offset} ms.`);
        else parts.push(`The offset would be ${offset} ms.`);
        if (result.spreadMs > UNSTEADY_SPREAD_MS) parts.push('Your taps vary a lot. Keep tapping, or try again.');
        noteEl.textContent = parts.join(' ');
        applyBtn.disabled = false;
    };

    tapBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); tap(e.timeStamp); });
    document.addEventListener('keydown', (e) => {
        if (e.code === 'Space' && ctx && modal.classList.contains('show')) {
            e.preventDefault();
            if (!e.repeat) tap(e.timeStamp);
        }
    });
    startBtn.addEventListener('click', () => (ctx ? stop() : start()));
    applyBtn.addEventListener('click', () => {
        if (offset === null) return;
        state.onApply?.(offset);
        closeModal('tapCalModal');
    });

    // The shared close paths hide the dialog without a hook, so stop the clicks when it goes away
    new MutationObserver(() => { if (!modal.classList.contains('show')) stop(); })
        .observe(modal, { attributes: true, attributeFilter: ['class'] });
    wireModal('tapCalModal', 'tapCalNoOpenButton');
    modal._reset = reset;
}

/**
 * @param {object} opts
 * @param {number} opts.latencyMs the audio latency setting, already taken off every tap
 * @param {(offsetMs: number) => void} opts.onApply called with the measured offset when the user accepts it
 */
export function openTapCalibration({ latencyMs = 0, onApply }) {
    if (!$('tapCalModal')) return;
    if (!wired) wire();
    state = { latencyMs, onApply };
    $('tapCalModal')._reset();
    openModal('tapCalModal');
}
