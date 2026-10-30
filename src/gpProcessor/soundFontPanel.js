// soundFontPanel.js
// SoundFont library UI inside the synth panel: add .sf2/.sf3 files, enable any number at once, delete.
import { reloadSynthSoundFonts } from './gpPlayer.js';
import {
    listOrderedSoundFonts, addSoundFont, deleteSoundFont,
    getSelectedSoundFontIds, getSavedSoundFontIds, setSelectedSoundFontIds, setSoundFontOrder, getSoundFontStrict, setSoundFontStrict,
    getForcedPreset, setForcedPreset, listSoundFontPresets
} from '../soundFontStore.js';
import { showToast } from '../utils/toast.js';
import { requireSupporter } from '../supporter.js';

function formatSize(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function iconButton(cls, icon, label) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn btn-sm btn-theme-icon flex-shrink-0 ${cls}`;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.innerHTML = `<i class="${icon}" aria-hidden="true"></i>`;
    return btn;
}

function buildRow({ id, name, detail, checked, editing, deletable, canMoveUp, canMoveDown }) {
    const row = document.createElement('div');
    row.className = 'soundfont-row d-flex align-items-center gap-2';
    row.dataset.id = id;

    const sw = document.createElement('div');
    sw.className = 'form-check form-switch mb-0 flex-shrink-0';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'form-check-input theme-switch';
    input.id = `soundFontToggle_${id}`;
    input.checked = checked;
    input.setAttribute('aria-label', `Use ${name}`);
    sw.appendChild(input);

    const label = document.createElement('label');
    label.className = 'soundfont-row-label flex-grow-1 small mb-0';
    label.htmlFor = input.id;
    const title = document.createElement('div');
    title.className = 'text-truncate';
    title.textContent = name;
    title.title = name;
    const sub = document.createElement('div');
    sub.className = 'text-white-50';
    sub.style.fontSize = '0.7rem';
    sub.textContent = detail;
    label.append(title, sub);

    row.append(sw, label);

    if (editing) {
        const up = iconButton('soundfont-move-up-btn', 'bi-chevron-up', `Move ${name} up`);
        up.disabled = !canMoveUp;
        const down = iconButton('soundfont-move-down-btn', 'bi-chevron-down', `Move ${name} down`);
        down.disabled = !canMoveDown;
        row.append(up, down);
        if (deletable) row.appendChild(iconButton('btn-theme-danger soundfont-delete-btn', 'bi-trash', `Delete ${name}`));
    }
    return row;
}

export function initSoundFontPanel() {
    const list = document.getElementById('soundFontList');
    const addBtn = document.getElementById('soundFontAddBtn');
    const editBtn = document.getElementById('soundFontEditBtn');
    const fileInput = document.getElementById('soundFontFileInput');
    if (!list || !addBtn || !editBtn || !fileInput) return;

    let editing = false;

    const strictToggle = document.getElementById('soundFontStrictToggle');
    if (strictToggle) {
        strictToggle.checked = getSoundFontStrict();
        strictToggle.addEventListener('change', () => {
            if (!requireSupporter('customSoundFonts')) {
                strictToggle.checked = getSoundFontStrict();
                return;
            }
            setSoundFontStrict(strictToggle.checked);
            scheduleReload();
        });
    }

    let reloadTimer = null;
    const scheduleReload = () => {
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
            reloadSynthSoundFonts().catch(err => {
                console.error('[SoundFont] Reload failed:', err);
                showToast('Could not load the selected SoundFonts.', 'error');
            });
        }, 600);
    };

    const forceFont = document.getElementById('soundFontForceFont');
    const forcePreset = document.getElementById('soundFontForcePreset');

    const option = (value, text) => Object.assign(document.createElement('option'), { value, textContent: text });

    async function renderForce(fonts) {
        if (!forceFont || !forcePreset) return;
        const forced = getForcedPreset();
        const enabled = new Set(getSelectedSoundFontIds());
        const custom = fonts.filter(f => enabled.has(f.id));
        forceFont.replaceChildren(option('', 'Off (use each track\'s instrument)'), ...custom.map(f => option(f.id, f.name)));
        const active = forced && custom.some(f => f.id === forced.id) ? forced : null;
        forceFont.value = active ? active.id : '';
        forcePreset.hidden = !active;
        if (!active) return;
        const presets = await listSoundFontPresets(active.id);
        forcePreset.replaceChildren(...presets.map(p => option(String(p.program), `${p.program}: ${p.name || 'Preset'}`)));
        forcePreset.value = String(active.program);
    }

    forceFont?.addEventListener('change', async () => {
        const id = forceFont.value;
        if (id && !requireSupporter('customSoundFonts')) {
            await render();
            return;
        }
        if (!id) {
            setForcedPreset(null);
        } else {
            const presets = await listSoundFontPresets(id);
            if (presets.length === 0) {
                showToast('That SoundFont has no melodic presets.', 'info');
                setForcedPreset(null);
            } else {
                setForcedPreset({ id, program: presets[0].program });
            }
        }
        await render();
        scheduleReload();
    });

    forcePreset?.addEventListener('change', () => {
        const forced = getForcedPreset();
        if (!forced) return;
        if (!requireSupporter('customSoundFonts')) {
            render();
            return;
        }
        setForcedPreset({ id: forced.id, program: Number(forcePreset.value) });
        scheduleReload();
    });

    async function render() {
        const selected = new Set(getSelectedSoundFontIds());
        const fonts = await listOrderedSoundFonts();
        renderForce(fonts).catch(err => console.warn('[SoundFont] Could not list presets:', err));
        list.replaceChildren(...fonts.map((f, i) => buildRow({
            id: f.id,
            name: f.name,
            detail: f.builtin ? 'General MIDI' : formatSize(f.size),
            checked: selected.has(f.id),
            editing,
            deletable: !f.builtin,
            canMoveUp: i > 0,
            canMoveDown: i < fonts.length - 1
        })));
    }

    editBtn.addEventListener('click', () => {
        editing = !editing;
        editBtn.textContent = editing ? 'Done' : 'Edit';
        editBtn.classList.toggle('active', editing);
        render();
    });

    list.addEventListener('change', (e) => {
        const input = e.target.closest('input[type="checkbox"]');
        const id = input?.closest('.soundfont-row')?.dataset.id;
        if (!id) return;
        if (!requireSupporter('customSoundFonts')) {
            input.checked = !input.checked;
            return;
        }
        const next = new Set(getSavedSoundFontIds());
        if (input.checked) next.add(id); else next.delete(id);
        if (next.size === 0) {
            // At least one SoundFont must stay on or there is nothing to play with
            input.checked = true;
            showToast('Keep at least one SoundFont enabled.', 'info');
            return;
        }
        // Disabling the forced font drops the forced preset
        if (!input.checked && getForcedPreset()?.id === id) setForcedPreset(null);
        setSelectedSoundFontIds([...next]);
        render();
        scheduleReload();
    });

    list.addEventListener('click', async (e) => {
        const row = e.target.closest('.soundfont-row');
        const moveBtn = e.target.closest('.soundfont-move-up-btn, .soundfont-move-down-btn');
        if (moveBtn && row) {
            if (!requireSupporter('customSoundFonts')) return;
            const ids = (await listOrderedSoundFonts()).map(f => f.id);
            const from = ids.indexOf(row.dataset.id);
            const to = from + (moveBtn.classList.contains('soundfont-move-up-btn') ? -1 : 1);
            if (from < 0 || to < 0 || to >= ids.length) return;
            [ids[from], ids[to]] = [ids[to], ids[from]];
            setSoundFontOrder(ids);
            await render();
            list.querySelector(`[data-id="${row.dataset.id}"] .${moveBtn.classList.contains('soundfont-move-up-btn') ? 'soundfont-move-up-btn' : 'soundfont-move-down-btn'}:not(:disabled)`)?.focus();
            scheduleReload();
            return;
        }
        const btn = e.target.closest('.soundfont-delete-btn');
        if (!btn || !row) return;
        // Two-step confirm: the viewer suppresses native confirm dialogs
        if (btn.dataset.armed !== '1') {
            btn.dataset.armed = '1';
            const label = btn.title;
            btn.title = 'Click again to confirm delete';
            btn.classList.add('active');
            btn.innerHTML = '<i class="bi-exclamation-triangle-fill" aria-hidden="true"></i>';
            setTimeout(() => {
                if (!btn.isConnected) return;
                btn.dataset.armed = '';
                btn.classList.remove('active');
                btn.title = label;
                btn.innerHTML = '<i class="bi-trash" aria-hidden="true"></i>';
            }, 3000);
            return;
        }
        const wasEnabled = getSelectedSoundFontIds().includes(row.dataset.id);
        if (getForcedPreset()?.id === row.dataset.id) setForcedPreset(null);
        await deleteSoundFont(row.dataset.id);
        await render();
        if (wasEnabled) scheduleReload();
    });

    addBtn.addEventListener('click', () => {
        if (requireSupporter('customSoundFonts')) fileInput.click();
    });
    fileInput.addEventListener('change', async () => {
        const files = [...fileInput.files];
        fileInput.value = '';
        if (files.length === 0) return;
        const added = [];
        for (const file of files) {
            try {
                added.push(await addSoundFont(file));
            } catch (err) {
                showToast(err.message, 'error');
            }
        }
        if (added.length === 0) return;
        // New uploads are enabled right away so they are audible
        setSelectedSoundFontIds([...getSavedSoundFontIds(), ...added.map(a => a.id)]);
        await render();
        showToast(added.length === 1 ? `Added ${added[0].name}` : `Added ${added.length} SoundFonts`, 'success');
        scheduleReload();
    });

    render().catch(err => console.warn('[SoundFont] Could not list SoundFonts:', err));
}
