// mixerPanel.js
// Synth panel entry points for the SoundFonts and Mixer modals, plus the per-track mixer UI.
import { getMixerTracks, setTrackMixer, resetMixer, onMixerChange, toggleSynthPanel } from './gpPlayer.js';
import { toggleYouTubePanel } from '../youtubePlayer.js';
import { TRACK_PALETTE, getTrackColorIndexFor } from '../utils/trackColors.js';

const PAN_LABELS = (pan) => (pan === 8 ? 'C' : pan < 8 ? `L${(8 - pan) * 100 / 8 | 0}` : `R${(pan - 8) * 100 / 8 | 0}`);

// Pending close timers: opening again during the close transition must cancel the close, or it hides the new view
const closeTimers = new WeakMap();

export function openModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    clearTimeout(closeTimers.get(modal));
    modal.classList.remove('is-closing');
    toggleSynthPanel(false);
    toggleYouTubePanel(false);
    modal.classList.add('show');
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
}

export function closeModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    if (modal.classList.contains('is-closing')) return;
    modal.classList.add('is-closing');
    const finishClose = () => {
        modal.classList.remove('show', 'is-closing');
        modal.style.display = 'none';
        modal.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('modal-open');
    };
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        finishClose();
    } else {
        closeTimers.set(modal, setTimeout(finishClose, 150));
    }
}

export function wireModal(id, openBtnId, onOpen) {
    const modal = document.getElementById(id);
    if (!modal) return;
    document.getElementById(openBtnId)?.addEventListener('click', () => {
        openModal(id);
        onOpen?.();
    });
    document.getElementById(`${id}CloseBtn`)?.addEventListener('click', () => closeModal(id));
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(id); });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.classList.contains('show')) closeModal(id);
    });
}

// ---- Per-track mix (mute, solo, level, pan): one always-visible strip per track in the Synth panel's Mixer ----
function slider(label, cls, min, max, name) {
    const wrap = document.createElement('div');
    wrap.className = 'mixer-slider';
    const l = document.createElement('span');
    l.className = 'mixer-slider-label';
    l.textContent = label;
    const input = document.createElement('input');
    input.type = 'range';
    input.className = cls;
    input.min = String(min); input.max = String(max); input.step = '1';
    input.setAttribute('aria-label', `${name} ${label.toLowerCase()}`);
    const badge = document.createElement('span');
    badge.className = 'theme-value-badge ' + cls + '-badge';
    wrap.append(l, input, badge);
    return wrap;
}

export function buildTrackMix(t) {
    const box = document.createElement('div');
    box.className = 'track-mix';
    box.dataset.index = t.index;

    // Top line: the track's color and name, with Mute and Solo
    const head = document.createElement('div');
    head.className = 'track-mix-head';
    const dot = document.createElement('span');
    dot.className = 'track-chip-dot gp-track-dot';
    dot.style.setProperty('--track-color', TRACK_PALETTE[getTrackColorIndexFor(t.index)]);
    const name = document.createElement('span');
    name.className = 'track-mix-name';
    name.textContent = t.name;
    name.title = t.name;
    const toggles = document.createElement('div');
    toggles.className = 'track-mix-toggles';
    [['mixer-mute-btn', 'Mute', 'M'], ['mixer-solo-btn', 'Solo', 'S']].forEach(([cls, label, letter]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `btn btn-sm theme-control-btn mixer-toggle ${cls}`;
        b.textContent = letter;
        b.title = label;
        b.setAttribute('aria-pressed', 'false');
        b.setAttribute('aria-label', `${label} ${t.name}`);
        toggles.append(b);
    });
    head.append(dot, name, toggles);

    // Second line: level and pan, always visible
    const sliders = document.createElement('div');
    sliders.className = 'track-mix-sliders';
    sliders.append(slider('Level', 'mixer-volume', 0, 150, t.name), slider('Pan', 'mixer-pan', 0, 16, t.name));

    box.append(head, sliders);
    return box;
}

function updateTrackMix(box, t) {
    const mute = box.querySelector('.mixer-mute-btn');
    const solo = box.querySelector('.mixer-solo-btn');
    mute.classList.toggle('active', t.mute); mute.setAttribute('aria-pressed', String(!!t.mute));
    solo.classList.toggle('active', t.solo); solo.setAttribute('aria-pressed', String(!!t.solo));
    box.closest('.gp-track-item')?.classList.toggle('is-muted', !!t.mute);
    const vol = box.querySelector('.mixer-volume');
    if (document.activeElement !== vol) vol.value = Math.round(t.volume * 100);
    box.querySelector('.mixer-volume-badge').textContent = `${Math.round(t.volume * 100)}%`;
    const pan = box.querySelector('.mixer-pan');
    if (document.activeElement !== pan) pan.value = t.pan;
    box.querySelector('.mixer-pan-badge').textContent = PAN_LABELS(t.pan);
}

/** Wire the Song panel's track list: delegated mix controls, live refresh, and the Reset levels button. */
export function bindTrackMix(list, resetBtn) {
    if (!list || list.dataset.mixBound) return;
    list.dataset.mixBound = '1';
    const refresh = () => {
        const tracks = getMixerTracks();
        list.querySelectorAll('.track-mix').forEach((box) => {
            const t = tracks[Number(box.dataset.index)];
            if (t) updateTrackMix(box, t);
        });
        if (resetBtn) resetBtn.disabled = tracks.length === 0;
    };
    list.addEventListener('click', (e) => {
        const btn = e.target.closest('.mixer-toggle');
        if (btn) {
            const box = btn.closest('.track-mix');
            const t = getMixerTracks()[Number(box.dataset.index)];
            setTrackMixer(t.index, btn.classList.contains('mixer-mute-btn') ? { mute: !t.mute } : { solo: !t.solo });
            return;
        }
    });
    list.addEventListener('input', (e) => {
        const box = e.target.closest('.track-mix');
        if (!box) return;
        const index = Number(box.dataset.index);
        if (e.target.classList.contains('mixer-volume')) setTrackMixer(index, { volume: Number(e.target.value) / 100 });
        else if (e.target.classList.contains('mixer-pan')) setTrackMixer(index, { pan: Number(e.target.value) });
    });
    // Double-click a slider to snap it back to its default
    list.addEventListener('dblclick', (e) => {
        const box = e.target.closest('.track-mix');
        if (!box) return;
        const index = Number(box.dataset.index);
        if (e.target.classList.contains('mixer-volume')) setTrackMixer(index, { volume: 1 });
        else if (e.target.classList.contains('mixer-pan')) setTrackMixer(index, { pan: getMixerTracks()[index].defaultPan });
    });
    resetBtn?.addEventListener('click', () => resetMixer());
    onMixerChange(refresh);
    refresh();
}

export function initMixerPanel() {
    wireModal('soundFontModal', 'soundFontModalBtn');
}
