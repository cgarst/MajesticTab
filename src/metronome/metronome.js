// metronome.js
// Vanilla JavaScript port of "The Minimal Metronome" by Zane Helton (https://github.com/ZaneH/metronome, MIT License).
// Taken from that project: the tempo tapper, the time signature list, the swing-arm ticker, the blink on the
// downbeat, the 30-300 BPM range and the keyboard map. Its React, Tone.js and Tauri parts are not used: the
// click is scheduled with the Web Audio clock directly.

import { updateUrl, clearUrl } from '../utils/urlRouter.js';
import { registerAudioContext, resumeTrackedAudioContexts } from '../utils/iosAudioUnlock.js';

const MIN_BPM = 30;
const MAX_BPM = 300;
const STORAGE_KEY = 'majestictab.metronome';
const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD_S = 0.12;

// [beats per bar, note value of one beat]
const TIME_SIGNATURES = [[4, 4], [3, 4], [2, 4], [2, 2], [3, 8], [6, 8], [9, 8], [12, 8], [5, 4], [6, 4]];

const $ = (id) => document.getElementById(id);
const clampBpm = (n) => Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(n)));

/** Tempo tapper (from the upstream project): the average of the taps in a run; a pause over a second starts a new run. */
class TempoTapper {
    constructor() { this.reset(); }
    reset() { this.count = 0; this.first = 0; this.previous = 0; this.bpm = 0; }
    tap(now = Date.now()) {
        if (now - this.previous > 1000) this.count = 0;
        if (this.count === 0) {
            this.count = 1;
            this.first = now;
            this.bpm = 0;
        } else {
            this.bpm = Math.round((60000 * this.count) / (now - this.first));
            this.count++;
        }
        this.previous = now;
        return this.bpm;
    }
}

class MetronomeController {
    constructor() {
        this.bpm = 120;
        this.sigIndex = 0;
        this.muted = false;
        this.blink = true;
        this.playing = false;
        this.initialized = false;
        this.tapper = new TempoTapper();
        this.ctx = null;
        this.timer = null;
        this.nextTime = 0;
        this.beatIndex = 0;
        this.visualQueue = [];
        this.raf = null;
        this.bpmBuffer = '';
        this.bpmBufferTimer = null;
        this.loadState();
    }

    loadState() {
        try {
            const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            if (Number.isFinite(s.bpm)) this.bpm = clampBpm(s.bpm);
            if (Number.isInteger(s.sig) && TIME_SIGNATURES[s.sig]) this.sigIndex = s.sig;
            if (typeof s.muted === 'boolean') this.muted = s.muted;
            if (typeof s.blink === 'boolean') this.blink = s.blink;
        } catch (_) { /* storage can be blocked or hold bad data; the defaults stand */ }
    }

    saveState() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ bpm: this.bpm, sig: this.sigIndex, muted: this.muted, blink: this.blink }));
        } catch (_) { /* the setting just won't persist */ }
    }

    get beats() { return TIME_SIGNATURES[this.sigIndex][0]; }
    get unit() { return TIME_SIGNATURES[this.sigIndex][1]; }
    /** Seconds per beat: a beat is one note of the signature's unit, with the BPM counting quarter notes. */
    get beatSeconds() { return (60 / this.bpm) * (4 / this.unit); }

    isOpen() {
        const m = $('metronomeModal');
        return Boolean(m) && m.style.display !== 'none';
    }

    init() {
        if (this.initialized) return;
        this.initialized = true;

        $('metronomeToggleBtn')?.addEventListener('click', () => this.open());
        $('metronomeModalCloseBtn')?.addEventListener('click', () => this.close());
        const backdrop = $('metronomeModal');
        backdrop?.addEventListener('click', (e) => { if (e.target === backdrop) this.close(); });

        $('metroPlayBtn')?.addEventListener('click', () => this.toggle());
        $('metroTapBtn')?.addEventListener('click', () => this.tap());
        $('metroSigBtn')?.addEventListener('click', () => this.nextSignature());
        $('metroBpmDown')?.addEventListener('click', () => this.setBpm(this.bpm - 1));
        $('metroBpmUp')?.addEventListener('click', () => this.setBpm(this.bpm + 1));
        $('metroBpmRange')?.addEventListener('input', (e) => this.setBpm(Number(e.target.value)));
        $('metroMuteSwitch')?.addEventListener('change', (e) => { this.muted = e.target.checked; this.saveState(); });
        $('metroBlinkSwitch')?.addEventListener('change', (e) => { this.blink = e.target.checked; this.saveState(); this.render(); });

        document.addEventListener('keydown', (e) => this.onKey(e));
        this.render();
    }

    // ---- Open / close ------------------------------------------------------

    open() {
        const modal = $('metronomeModal');
        if (!modal) return;
        modal.style.display = 'flex';
        modal.setAttribute('aria-hidden', 'false');
        $('metronomeToggleBtn')?.classList.add('active');
        this.render();
        updateUrl('metronome');
        $('metroPlayBtn')?.focus({ preventScroll: true });
    }

    close() {
        this.stop();
        const modal = $('metronomeModal');
        if (modal) {
            modal.style.display = 'none';
            modal.setAttribute('aria-hidden', 'true');
        }
        $('metronomeToggleBtn')?.classList.remove('active');
        const libPage = $('libraryPage');
        if (libPage && libPage.style.display !== 'none') {
            import('../libraryModal.js').then((m) => updateUrl(m.getActiveLibraryView?.() || 'library'));
        } else {
            clearUrl();
        }
    }

    // ---- Controls ----------------------------------------------------------

    setBpm(value) {
        if (!Number.isFinite(value)) return;
        this.bpm = clampBpm(value);
        this.saveState();
        this.render();
    }

    nextSignature() {
        this.sigIndex = (this.sigIndex + 1) % TIME_SIGNATURES.length;
        this.beatIndex = 0;
        this.saveState();
        this.render();
        if (this.playing) this.restart();
    }

    tap() {
        const bpm = this.tapper.tap();
        if (bpm >= MIN_BPM) this.setBpm(bpm);
    }

    toggle() {
        if (this.playing) this.stop();
        else this.start();
    }

    onKey(e) {
        if (!this.isOpen() || e.ctrlKey || e.metaKey || e.altKey) return;
        const t = e.target;
        const typing = t && ((t.tagName === 'INPUT' && !['range', 'checkbox', 'button'].includes(t.type)) || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
        if (typing) return;
        if (e.key === 'Escape') { this.close(); return; }
        const onButton = t && t.tagName === 'BUTTON';
        let handled = true;
        switch (e.key) {
            case ' ': if (onButton) return; this.toggle(); break;
            case 't': case 'T': this.tap(); break;
            case 'm': case 'M': this.setMuted(!this.muted); break;
            case 'ArrowUp': case 'ArrowRight': if (t && t.type === 'range') return; this.setBpm(this.bpm + (e.shiftKey ? 10 : 1)); break;
            case 'ArrowDown': case 'ArrowLeft': if (t && t.type === 'range') return; this.setBpm(this.bpm - (e.shiftKey ? 10 : 1)); break;
            case 'Backspace': this.bpmBuffer = this.bpmBuffer.slice(0, -1); this.commitBuffer(); break;
            default:
                if (/^[0-9]$/.test(e.key)) { this.bpmBuffer = (this.bpmBuffer + e.key).slice(-3); this.commitBuffer(); }
                else handled = false;
        }
        if (handled) e.preventDefault();
    }

    /** Digits type a tempo: the last three typed digits count, and the buffer clears after a pause. */
    commitBuffer() {
        clearTimeout(this.bpmBufferTimer);
        this.bpmBufferTimer = setTimeout(() => { this.bpmBuffer = ''; }, 1500);
        const n = Number(this.bpmBuffer);
        if (n >= MIN_BPM && n <= MAX_BPM) this.setBpm(n);
    }

    setMuted(v) {
        this.muted = v;
        this.saveState();
        this.render();
    }

    // ---- Audio -------------------------------------------------------------

    start() {
        if (this.playing) return;
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        if (!this.ctx) {
            this.ctx = new Ctx();
            try { registerAudioContext(this.ctx); } catch (_) { /* tracking is optional */ }
        }
        try { resumeTrackedAudioContexts(); } catch (_) { /* optional */ }
        this.ctx.resume?.();
        this.playing = true;
        this.beatIndex = 0;
        this.visualQueue = [];
        this.nextTime = this.ctx.currentTime + 0.06;
        this.timer = setInterval(() => this.schedule(), LOOKAHEAD_MS);
        this.schedule();
        this.raf = requestAnimationFrame(() => this.frame());
        this.render();
    }

    stop() {
        if (!this.playing) return;
        this.playing = false;
        clearInterval(this.timer);
        this.timer = null;
        cancelAnimationFrame(this.raf);
        this.visualQueue = [];
        this.render();
    }

    restart() {
        this.stop();
        this.start();
    }

    schedule() {
        if (!this.ctx) return;
        while (this.nextTime < this.ctx.currentTime + SCHEDULE_AHEAD_S) {
            const accent = this.beatIndex % this.beats === 0;
            if (!this.muted) this.click(this.nextTime, accent);
            this.visualQueue.push({ time: this.nextTime, index: this.beatIndex % this.beats, seconds: this.beatSeconds });
            this.nextTime += this.beatSeconds;
            this.beatIndex++;
        }
    }

    /** A short sine blip: C5 on the downbeat, C4 on the other beats (the same pitches as the upstream project). */
    click(time, accent) {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = accent ? 523.25 : 261.63;
        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(0.9, time + 0.005);
        gain.gain.setValueAtTime(0.9, time + 0.08);
        gain.gain.linearRampToValueAtTime(0, time + 0.1);
        osc.connect(gain).connect(this.ctx.destination);
        osc.start(time);
        osc.stop(time + 0.11);
    }

    // ---- Display -----------------------------------------------------------

    /** Follows the audio clock: moves the swing arm and lights the current beat. */
    frame() {
        if (!this.playing) return;
        const now = this.ctx.currentTime;
        while (this.visualQueue.length && this.visualQueue[0].time <= now) {
            this.current = this.visualQueue.shift();
            this.lastTime = this.current.time;
        }
        const arm = $('metroArm');
        if (arm && this.current) {
            // One beat swings the arm across; the next swings it back
            const phase = Math.min(1, Math.max(0, (now - this.current.time) / this.current.seconds));
            const forward = (this.current.index % 2 === 0);
            const p = forward ? phase : 1 - phase;
            const eased = 0.5 - Math.cos(p * Math.PI) / 2;
            arm.style.transform = `rotate(${(eased * 2 - 1) * 0.4}rad)`;
        }
        const dots = document.querySelectorAll('#metroBeats .metro-beat');
        dots.forEach((d, i) => d.classList.toggle('is-current', this.current ? i === this.current.index : false));
        const mark = $('metroMark');
        if (mark && this.blink && this.current) {
            const since = now - this.current.time;
            mark.classList.toggle('is-lit', since >= 0 && since < 0.08);
        }
        this.raf = requestAnimationFrame(() => this.frame());
    }

    render() {
        const bpmEl = $('metroBpm');
        if (!bpmEl) return;
        bpmEl.textContent = String(this.bpm);
        const range = $('metroBpmRange');
        if (range) range.value = String(this.bpm);
        const sig = $('metroSigBtn');
        if (sig) sig.textContent = `${this.beats}/${this.unit}`;
        const play = $('metroPlayBtn');
        if (play) {
            play.textContent = this.playing ? 'Stop' : 'Start';
            play.setAttribute('aria-pressed', String(this.playing));
        }
        const mute = $('metroMuteSwitch');
        if (mute) mute.checked = this.muted;
        const blink = $('metroBlinkSwitch');
        if (blink) blink.checked = this.blink;
        const mark = $('metroMark');
        if (mark) { mark.hidden = !this.blink; if (!this.playing) mark.classList.remove('is-lit'); }
        const beats = $('metroBeats');
        if (beats && beats.children.length !== this.beats) {
            beats.innerHTML = Array.from({ length: this.beats }, (_, i) =>
                `<span class="metro-beat${i === 0 ? ' is-downbeat' : ''}" aria-hidden="true"></span>`).join('');
        }
        if (!this.playing) {
            document.querySelectorAll('#metroBeats .metro-beat').forEach((d) => d.classList.remove('is-current'));
            const arm = $('metroArm');
            if (arm) arm.style.transform = '';
            this.current = null;
        }
        $('metronomeToggleBtn')?.classList.toggle('is-running', this.playing);
    }
}

export const metronome = new MetronomeController();

export function initMetronome() { metronome.init(); }
export function openMetronomeModal() { metronome.open(); }
export function closeMetronomeModal() { metronome.close(); }
