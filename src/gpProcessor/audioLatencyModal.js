// audioLatencyModal.js
// Modal for the audio latency compensation (late Bluetooth speakers) with a tap calibration tool.
import { getAudioLatencyMs, setAudioLatencyMs } from './gpPlayer.js';
import { wireModal } from './mixerPanel.js';

const CLICK_INTERVAL_MS = 1200;
const LOOKAHEAD_MS = 150;
const MIN_TAPS = 4;
const MAX_TAPS_USED = 10;

const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export function initAudioLatencyModal() {
    const slider = document.getElementById('latencySlider');
    const badge = document.getElementById('latencyBadge');
    const panelBadge = document.getElementById('latencyModalBadge');
    const flash = document.getElementById('latencyFlash');
    const tapBtn = document.getElementById('latencyTapBtn');
    const startBtn = document.getElementById('latencyStartBtn');
    const applyBtn = document.getElementById('latencyApplyBtn');
    const measuredEl = document.getElementById('latencyMeasured');
    const tapCountEl = document.getElementById('latencyTapCount');
    const modal = document.getElementById('latencyModal');
    if (!modal || !slider) return;

    let ctx = null;
    let schedulerTimer = 0;
    let rafId = 0;
    let nextClickCtxSec = 0;
    let perfBaseMs = 0; // performance.now() when ctx.currentTime was 0
    let clicks = []; // scheduled click times, performance clock (ms)
    let flashes = []; // scheduled click times, context clock (s)
    let offsets = [];
    let measured = null;

    const syncUI = () => {
        const ms = getAudioLatencyMs();
        slider.value = String(ms);
        badge.textContent = `${ms} ms`;
        if (panelBadge) panelBadge.textContent = `${ms} ms`;
    };

    const resetMeasurement = () => {
        offsets = [];
        measured = null;
        measuredEl.textContent = '–';
        tapCountEl.textContent = '0 taps';
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
            if (clicks.length > 8) clicks.shift();
            nextClickCtxSec += CLICK_INTERVAL_MS / 1000;
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
        try { ctx?.close(); } catch (_) {}
        ctx = null;
        flashes = [];
        clicks = [];
        flash.classList.remove('on');
        tapBtn.disabled = true;
        startBtn.textContent = 'Start Clicks';
    };

    const start = () => {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        resetMeasurement();
        ctx = new Ctx({ latencyHint: 'interactive' });
        ctx.resume?.();
        perfBaseMs = performance.now() - ctx.currentTime * 1000;
        nextClickCtxSec = ctx.currentTime + 0.5;
        scheduleClicks();
        schedulerTimer = setInterval(scheduleClicks, 50);
        rafId = requestAnimationFrame(animate);
        tapBtn.disabled = false;
        startBtn.textContent = 'Stop Clicks';
    };

    const tap = (tapMs) => {
        if (!ctx || !clicks.length) return;
        // Offset from the nearest click, folded into one interval around zero.
        const nearest = clicks.reduce((best, c) => (Math.abs(tapMs - c) < Math.abs(tapMs - best) ? c : best));
        let offset = tapMs - nearest;
        offset = ((offset + CLICK_INTERVAL_MS / 2) % CLICK_INTERVAL_MS + CLICK_INTERVAL_MS) % CLICK_INTERVAL_MS - CLICK_INTERVAL_MS / 2;
        offsets.push(offset);
        tapCountEl.textContent = `${offsets.length} ${offsets.length === 1 ? 'tap' : 'taps'}`;
        if (offsets.length >= MIN_TAPS) {
            measured = Math.max(0, Math.round(median(offsets.slice(-MAX_TAPS_USED))));
            measuredEl.textContent = `${measured} ms`;
            applyBtn.disabled = false;
        }
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
        if (measured === null) return;
        setAudioLatencyMs(measured);
        syncUI();
    });

    slider.addEventListener('input', (e) => { setAudioLatencyMs(e.target.value); syncUI(); });
    modal.querySelectorAll('[data-latency-step]').forEach((btn) => {
        btn.addEventListener('click', () => {
            setAudioLatencyMs(getAudioLatencyMs() + parseInt(btn.dataset.latencyStep, 10));
            syncUI();
        });
    });

    // Close paths in wireModal hide the modal without a hook, so stop clicks when it goes away.
    new MutationObserver(() => { if (!modal.classList.contains('show')) stop(); })
        .observe(modal, { attributes: true, attributeFilter: ['class'] });

    wireModal('latencyModal', 'latencyModalBtn', () => { resetMeasurement(); syncUI(); });
    syncUI();
}
