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

const MIN_BEATS = 2;
const MAX_BEATS = 19;
const UNITS = [1, 2, 4, 8, 16]; // note value of one beat
const MAX_REPEAT = 8;
const MAX_PARTS = 8;

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
        // The bars to cycle through: each part is a time signature played `repeat` times (6/8 x2, then 7/8)
        this.pattern = [{ beats: 4, unit: 4, repeat: 1 }];
        this.bars = [];
        this.barIndex = 0;
        this.beatInBar = 0;
        this.beatCount = 0;
        this.shownBeats = 0;
        this.shownPart = -1;
        this.muted = false;
        this.blink = true;
        this.playing = false;
        this.initialized = false;
        this.tapper = new TempoTapper();
        this.ctx = null;
        this.timer = null;
        this.nextTime = 0;
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
            const valid = (x) => x && Number.isInteger(x.beats) && x.beats >= MIN_BEATS && x.beats <= MAX_BEATS && UNITS.includes(x.unit)
                && Number.isInteger(x.repeat) && x.repeat >= 1 && x.repeat <= MAX_REPEAT;
            if (Array.isArray(s.pattern) && s.pattern.length && s.pattern.length <= MAX_PARTS && s.pattern.every(valid)) {
                this.pattern = s.pattern.map(({ beats, unit, repeat }) => ({ beats, unit, repeat }));
            } else if (valid({ ...s, repeat: 1 })) {
                this.pattern = [{ beats: s.beats, unit: s.unit, repeat: 1 }]; // saved before patterns existed
            }
            if (typeof s.muted === 'boolean') this.muted = s.muted;
            if (typeof s.blink === 'boolean') this.blink = s.blink;
        } catch (_) { /* storage can be blocked or hold bad data; the defaults stand */ }
    }

    saveState() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ bpm: this.bpm, pattern: this.pattern, muted: this.muted, blink: this.blink }));
        } catch (_) { /* the setting just won't persist */ }
    }

    /** Seconds per beat: a beat is one note of the signature's unit, with the BPM counting quarter notes. */
    beatSecondsFor(unit) { return (60 / this.bpm) * (4 / unit); }

    /** The pattern laid out bar by bar: [6/8 x2, 7/8] becomes 6/8, 6/8, 7/8. `part` is the pattern row each bar came from. */
    expandBars() {
        return this.pattern.flatMap((p, part) => Array.from({ length: p.repeat }, () => ({ beats: p.beats, unit: p.unit, part })));
    }

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
        $('metroPattern')?.addEventListener('change', (e) => this.onPatternChange(e));
        $('metroPattern')?.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-remove]');
            if (btn) this.removePart(Number(btn.dataset.remove));
        });
        $('metroAddPart')?.addEventListener('click', () => this.addPart());
        $('metroResetPart')?.addEventListener('click', () => this.resetPattern());
        $('metroBpmDown')?.addEventListener('click', () => this.setBpm(this.bpm - 1));
        $('metroBpmUp')?.addEventListener('click', () => this.setBpm(this.bpm + 1));
        $('metroBpmRange')?.addEventListener('input', (e) => this.setBpm(Number(e.target.value)));
        $('metroMuteSwitch')?.addEventListener('change', (e) => { this.muted = e.target.checked; this.saveState(); });
        $('metroBlinkSwitch')?.addEventListener('change', (e) => { this.blink = e.target.checked; this.saveState(); this.render(); });

        document.addEventListener('keydown', (e) => this.onKey(e));
        this.renderPattern();
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
        updateUrl('tools', 'metronome');
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

    /** Each part's beats per bar, note value and repeat count are set on their own; any change restarts the pattern. */
    onPatternChange(e) {
        const sel = e.target.closest('select[data-field]');
        if (!sel) return;
        const part = this.pattern[Number(sel.dataset.part)];
        const value = Number(sel.value);
        if (!part || !Number.isFinite(value)) return;
        if (sel.dataset.field === 'beats') part.beats = Math.min(MAX_BEATS, Math.max(MIN_BEATS, Math.round(value)));
        else if (sel.dataset.field === 'unit' && UNITS.includes(value)) part.unit = value;
        else if (sel.dataset.field === 'repeat') part.repeat = Math.min(MAX_REPEAT, Math.max(1, Math.round(value)));
        this.patternChanged();
    }

    addPart() {
        if (this.pattern.length >= MAX_PARTS) return;
        const last = this.pattern[this.pattern.length - 1];
        this.pattern.push({ beats: last.beats, unit: last.unit, repeat: 1 });
        this.renderPattern();
        this.patternChanged();
    }

    /** Back to a single 4/4 bar, played once. The tempo is left as it is. */
    resetPattern() {
        this.pattern = [{ beats: 4, unit: 4, repeat: 1 }];
        this.renderPattern();
        this.patternChanged();
    }

    removePart(i) {
        if (this.pattern.length <= 1 || !this.pattern[i]) return;
        this.pattern.splice(i, 1);
        this.renderPattern();
        this.patternChanged();
    }

    patternChanged() {
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
        if (e.key === 'Escape') { this.close(); return; }
        const t = e.target;
        const typing = t && ((t.tagName === 'INPUT' && !['range', 'checkbox', 'button'].includes(t.type)) || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
        if (typing) return;
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
        this.bars = this.expandBars();
        this.barIndex = 0;
        this.beatInBar = 0;
        this.beatCount = 0;
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
            const bar = this.bars[this.barIndex];
            const seconds = this.beatSecondsFor(bar.unit);
            if (!this.muted) this.click(this.nextTime, this.beatInBar === 0);
            this.visualQueue.push({ time: this.nextTime, index: this.beatInBar, beats: bar.beats, part: bar.part, n: this.beatCount, seconds });
            this.nextTime += seconds;
            this.beatCount++;
            this.beatInBar++;
            if (this.beatInBar >= bar.beats) {
                this.beatInBar = 0;
                this.barIndex = (this.barIndex + 1) % this.bars.length;
            }
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
            const forward = (this.current.n % 2 === 0); // the arm keeps alternating across bars, whatever their length
            const p = forward ? phase : 1 - phase;
            const eased = 0.5 - Math.cos(p * Math.PI) / 2;
            arm.style.transform = `rotate(${(eased * 2 - 1) * 0.4}rad)`;
        }
        if (this.current) {
            this.renderDots(this.current.beats);
            this.markPart(this.current.part);
            document.querySelectorAll('#metroBeats .metro-beat').forEach((d, i) => d.classList.toggle('is-current', i === this.current.index));
        }
        const mark = $('metroMark');
        if (mark && this.blink && this.current) {
            const since = now - this.current.time;
            mark.classList.toggle('is-lit', since >= 0 && since < 0.08);
        }
        this.raf = requestAnimationFrame(() => this.frame());
    }

    /** One dot per beat of the bar that is sounding; the first (the downbeat) is a tone darker. */
    renderDots(count) {
        const beats = $('metroBeats');
        if (!beats || this.shownBeats === count) return;
        this.shownBeats = count;
        beats.innerHTML = Array.from({ length: count }, (_, i) =>
            `<span class="metro-beat${i === 0 ? ' is-downbeat' : ''}" aria-hidden="true"></span>`).join('');
    }

    /** Take one tone step on the pattern row that is playing. */
    markPart(part) {
        if (this.shownPart === part) return;
        this.shownPart = part;
        document.querySelectorAll('#metroPattern .metro-row').forEach((row) =>
            row.classList.toggle('is-current', Number(row.dataset.part) === part));
    }

    renderPattern() {
        const host = $('metroPattern');
        if (!host) return;
        const options = (values, current) => values.map((v) => `<option value="${v}"${v === current ? ' selected' : ''}>${v}</option>`).join('');
        const beatValues = Array.from({ length: MAX_BEATS - MIN_BEATS + 1 }, (_, i) => MIN_BEATS + i);
        const repeatValues = Array.from({ length: MAX_REPEAT }, (_, i) => i + 1);
        host.innerHTML = this.pattern.map((p, i) => {
            const n = this.pattern.length > 1 ? `Part ${i + 1} ` : '';
            return `<div class="metro-row" data-part="${i}">
                <select class="form-select metro-field" data-field="beats" data-part="${i}" aria-label="${n}beats per bar">${options(beatValues, p.beats)}</select>
                <span class="metro-sig-slash" aria-hidden="true">/</span>
                <select class="form-select metro-field" data-field="unit" data-part="${i}" aria-label="${n}note value of one beat">${options(UNITS, p.unit)}</select>
                <span class="metro-times" aria-hidden="true">&times;</span>
                <select class="form-select metro-field" data-field="repeat" data-part="${i}" aria-label="${n}number of bars">${options(repeatValues, p.repeat)}</select>
                ${this.pattern.length > 1 ? `<button type="button" class="btn btn-sm metro-ghost" data-remove="${i}" aria-label="Remove part ${i + 1}">Remove</button>` : ''}
            </div>`;
        }).join('');
        $('metroAddPart')?.toggleAttribute('hidden', this.pattern.length >= MAX_PARTS);
        this.shownPart = -1;
    }

    render() {
        const bpmEl = $('metroBpm');
        if (!bpmEl) return;
        bpmEl.textContent = String(this.bpm);
        const range = $('metroBpmRange');
        if (range) range.value = String(this.bpm);
        const isDefault = this.pattern.length === 1 && this.pattern[0].beats === 4 && this.pattern[0].unit === 4 && this.pattern[0].repeat === 1;
        const reset = $('metroResetPart');
        if (reset) reset.disabled = isDefault;
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
        if (!this.playing) {
            this.renderDots(this.pattern[0].beats);
            this.markPart(-1);
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
