// mixerPanel.js
// Synth panel entry points for the SoundFonts and Mixer modals, plus the per-track mixer UI.
import { getMixerTracks, setTrackMixer, resetMixer, onMixerChange, toggleSynthPanel } from './gpPlayer.js';

const PAN_LABELS = (pan) => (pan === 8 ? 'C' : pan < 8 ? `L${(8 - pan) * 100 / 8 | 0}` : `R${(pan - 8) * 100 / 8 | 0}`);

function openModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    toggleSynthPanel(false);
    modal.classList.add('show');
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
}

function closeModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.remove('show');
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
}

function wireModal(id, openBtnId, onOpen) {
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

function buildRow(t) {
    const row = document.createElement('div');
    row.className = 'mixer-row';
    row.dataset.index = t.index;

    const name = document.createElement('div');
    name.className = 'mixer-name text-truncate small';
    name.textContent = t.name;
    name.title = t.name;

    const mute = document.createElement('button');
    mute.type = 'button';
    mute.className = 'btn btn-sm theme-control-btn mixer-toggle mixer-mute-btn';
    mute.textContent = 'M';
    mute.title = `Mute ${t.name}`;
    mute.setAttribute('aria-label', `Mute ${t.name}`);

    const solo = document.createElement('button');
    solo.type = 'button';
    solo.className = 'btn btn-sm theme-control-btn mixer-toggle mixer-solo-btn';
    solo.textContent = 'S';
    solo.title = `Solo ${t.name}`;
    solo.setAttribute('aria-label', `Solo ${t.name}`);

    const vol = document.createElement('input');
    vol.type = 'range';
    vol.className = 'mixer-volume';
    vol.min = '0'; vol.max = '150'; vol.step = '1';
    vol.setAttribute('aria-label', `${t.name} volume`);
    const volBadge = document.createElement('span');
    volBadge.className = 'theme-value-badge mixer-volume-badge';

    const pan = document.createElement('input');
    pan.type = 'range';
    pan.className = 'mixer-pan';
    pan.min = '0'; pan.max = '16'; pan.step = '1';
    pan.setAttribute('aria-label', `${t.name} pan`);
    const panBadge = document.createElement('span');
    panBadge.className = 'theme-value-badge mixer-pan-badge';

    const volWrap = document.createElement('div');
    volWrap.className = 'mixer-slider';
    volWrap.append(vol, volBadge);
    const panWrap = document.createElement('div');
    panWrap.className = 'mixer-slider';
    panWrap.append(pan, panBadge);

    row.append(name, mute, solo, volWrap, panWrap);
    return row;
}

function updateRow(row, t) {
    row.querySelector('.mixer-mute-btn').classList.toggle('active', t.mute);
    row.querySelector('.mixer-solo-btn').classList.toggle('active', t.solo);
    row.classList.toggle('is-muted', t.mute);
    const vol = row.querySelector('.mixer-volume');
    if (document.activeElement !== vol) vol.value = Math.round(t.volume * 100);
    row.querySelector('.mixer-volume-badge').textContent = `${Math.round(t.volume * 100)}%`;
    const pan = row.querySelector('.mixer-pan');
    if (document.activeElement !== pan) pan.value = t.pan;
    row.querySelector('.mixer-pan-badge').textContent = PAN_LABELS(t.pan);
}

export function initMixerPanel() {
    const list = document.getElementById('mixerTrackList');
    const empty = document.getElementById('mixerEmptyMsg');
    const resetBtn = document.getElementById('mixerResetBtn');
    if (!list) return;

    const render = () => {
        const tracks = getMixerTracks();
        if (empty) empty.style.display = tracks.length ? 'none' : '';
        if (resetBtn) resetBtn.disabled = tracks.length === 0;
        const rows = [...list.children];
        // Rebuild only when the track set changed so sliders keep focus while dragging
        if (rows.length !== tracks.length || rows.some((r, i) => Number(r.dataset.index) !== tracks[i].index)) {
            list.replaceChildren(...tracks.map(buildRow));
        }
        [...list.children].forEach((row, i) => updateRow(row, tracks[i]));
    };

    list.addEventListener('click', (e) => {
        const row = e.target.closest('.mixer-row');
        const btn = e.target.closest('.mixer-toggle');
        if (!row || !btn) return;
        const t = getMixerTracks()[Number(row.dataset.index)];
        if (btn.classList.contains('mixer-mute-btn')) setTrackMixer(t.index, { mute: !t.mute });
        else setTrackMixer(t.index, { solo: !t.solo });
    });
    list.addEventListener('input', (e) => {
        const row = e.target.closest('.mixer-row');
        if (!row) return;
        const index = Number(row.dataset.index);
        if (e.target.classList.contains('mixer-volume')) setTrackMixer(index, { volume: Number(e.target.value) / 100 });
        else if (e.target.classList.contains('mixer-pan')) setTrackMixer(index, { pan: Number(e.target.value) });
    });
    // Double-click a slider to snap it back to its default
    list.addEventListener('dblclick', (e) => {
        const row = e.target.closest('.mixer-row');
        if (!row) return;
        const index = Number(row.dataset.index);
        if (e.target.classList.contains('mixer-volume')) setTrackMixer(index, { volume: 1 });
        else if (e.target.classList.contains('mixer-pan')) setTrackMixer(index, { pan: getMixerTracks()[index].defaultPan });
    });
    resetBtn?.addEventListener('click', () => resetMixer());

    onMixerChange(render);
    wireModal('mixerModal', 'mixerModalBtn', render);
    wireModal('soundFontModal', 'soundFontModalBtn');
    render();
}
