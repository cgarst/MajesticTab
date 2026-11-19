// audioSync/addStems.js
// Add stems: the Original panel's way to make a set of stems from loose files, the same set a stems-only pack makes (see
// stemSet.js). Pick two or more files, name each part and say which instrument it is (that is what Backing starts without),
// and they are saved as the song's "All stems" recording: the first file leads (the map points are kept under it), the set
// plays as both Full band and Backing, and the rest hang off the lead. Everything stays in the app; nothing here changes
// the pack format.

import { openModal, closeModal, wireModal } from '../gpProcessor/mixerPanel.js';
import { getSongKey } from '../soundPlayer.js';
import { decodePeaks } from './peaks.js';
import { saveAudioFile, unlinkAudioFile, MAX_AUDIO_BYTES } from './audioFileStore.js';
import { setRecordingMeta } from './recordingMeta.js';
import { mediaKey } from './syncStore.js';
import { adoptStemSet } from './audioFilePlayer.js';
import { setSlotSource } from './realAudioController.js';
import { guessInstrument, labelsFromNames, INSTRUMENTS } from './stemGuess.js';
import { showToast } from '../utils/toast.js';

const MODAL = 'addStemsModal';
const PHONE_WARN_AT = 8;
const LENGTH_WARN_MS = 1000;
const $ = (id) => document.getElementById(id);
const clock = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const isPhone = () => Boolean(window.matchMedia?.('(max-width: 640px), (pointer: coarse) and (orientation: landscape) and (max-height: 500px)').matches);
const mediaOf = (meta) => ({ kind: 'local', audioId: meta.id, name: meta.name, durationMs: meta.durationMs ?? null, fingerprint: meta.fingerprint });

let busy = false;

export function initAddStems() {
    const btn = $('afAddStemsBtn');
    const input = $('afStemsInput');
    if (!btn || !input || !$(MODAL)) return;
    wireModal(MODAL, null);
    btn.addEventListener('click', () => { if (getSongKey()) input.click(); });
    input.addEventListener('change', () => {
        const files = [...(input.files || [])];
        input.value = '';
        if (files.length) openSheet(files);
    });
}

function openSheet(files) {
    const body = $('addStemsBody');
    body.replaceChildren();
    const labels = labelsFromNames(files.map((f) => f.name));
    const rows = files.map((file, i) => ({
        file, label: labels[i], instrument: guessInstrument(file.name), data: null, analysed: null, error: file.size > MAX_AUDIO_BYTES ? 'Too large' : ''
    }));

    const intro = document.createElement('p');
    intro.className = 'add-stems-intro';
    intro.textContent = 'Name each part and say which instrument it is. The first file leads: the map points are kept with it. The files must line up from the start of the song.';
    const list = document.createElement('div');
    list.className = 'add-stems-list';
    const notes = document.createElement('div');
    notes.className = 'add-stems-notes';
    notes.setAttribute('role', 'status');
    const foot = document.createElement('p');
    foot.className = 'add-stems-foot';
    foot.textContent = 'Adds one recording, “All stems”, under Full band and Backing. Backing starts without the guitars; you can change what is muted.';
    const actions = document.createElement('div');
    actions.className = 'add-stems-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'btn btn-sm btn-theme-outline'; cancel.textContent = 'Cancel';
    const add = document.createElement('button');
    add.type = 'button'; add.className = 'btn btn-sm btn-theme-primary add-stems-go'; add.textContent = 'Add stems';
    actions.append(cancel, add);
    body.append(intro, list, notes, foot, actions);

    const rowEls = rows.map((r) => {
        const el = document.createElement('div');
        el.className = 'add-stems-row';
        const name = document.createElement('div');
        name.className = 'add-stems-file';
        const fileName = document.createElement('span'); fileName.textContent = r.file.name;
        const meta = document.createElement('span'); meta.className = 'add-stems-meta'; meta.textContent = 'Reading…';
        name.append(fileName, meta);
        const label = document.createElement('input');
        label.type = 'text'; label.className = 'form-control form-control-sm'; label.value = r.label; label.maxLength = 60;
        label.setAttribute('aria-label', `Name of ${r.file.name}`);
        label.addEventListener('input', () => { r.label = label.value; });
        const select = document.createElement('select');
        select.className = 'form-select form-select-sm';
        select.setAttribute('aria-label', `Instrument of ${r.file.name}`);
        INSTRUMENTS.forEach(([value, text]) => select.append(new Option(text, value, false, value === r.instrument)));
        select.addEventListener('change', () => { r.instrument = select.value; });
        el.append(name, label, select);
        list.append(el);
        return { el, meta };
    });

    const refresh = () => {
        const reading = rows.some((r) => !r.analysed && !r.error);
        const bad = rows.some((r) => r.error);
        const msgs = [];
        if (rows.length < 2) msgs.push('Choose at least two files for a set of stems.');
        if (bad) msgs.push('A file could not be used: remove it by choosing the files again.');
        if (isPhone() && rows.length > PHONE_WARN_AT) msgs.push(`A set of ${rows.length} stems is heavy on a phone: each part is decoded while it plays. A computer, or fewer stems, works better.`);
        const lengths = rows.filter((r) => r.analysed?.durationMs).map((r) => r.analysed.durationMs);
        if (lengths.length > 1 && Math.max(...lengths) - Math.min(...lengths) > LENGTH_WARN_MS) {
            msgs.push(`These files differ in length by ${Math.round((Math.max(...lengths) - Math.min(...lengths)) / 1000)} seconds, so they may not line up.`);
        }
        notes.replaceChildren(...msgs.map((m) => { const p = document.createElement('p'); p.textContent = m; return p; }));
        add.disabled = busy || reading || bad || rows.length < 2;
    };

    // Each file is read and measured, one at a time: the same decode the single Add audio file does
    (async () => {
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            if (r.error) { rowEls[i].meta.textContent = r.error; continue; }
            try {
                r.data = await r.file.arrayBuffer();
                r.analysed = (await decodePeaks(r.data)) || { durationMs: null, peaks: null };
                rowEls[i].meta.textContent = r.analysed.durationMs ? clock(r.analysed.durationMs) : 'Unknown length';
            } catch (e) {
                r.error = 'Could not read this file';
                rowEls[i].meta.textContent = r.error;
            }
            refresh();
        }
        refresh();
    })();

    cancel.addEventListener('click', () => { if (!busy) closeModal(MODAL); });
    add.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        add.disabled = true;
        const songKey = getSongKey();
        const saved = [];
        try {
            for (let i = 0; i < rows.length; i++) {
                add.textContent = `Saving ${i + 1} of ${rows.length}…`;
                const r = rows[i];
                const meta = await saveAudioFile({
                    name: r.file.name, type: r.file.type || 'audio/mpeg', data: r.data, songKey,
                    durationMs: r.analysed?.durationMs ?? null, peaks: r.analysed?.peaks ?? null
                });
                saved.push({ meta, row: r });
            }
            const lead = saved[0];
            const leadKey = mediaKey(mediaOf(lead.meta));
            const stems = saved.map(({ meta, row }) => ({ audioId: meta.id, label: row.label.trim() || 'Stem', instrument: row.instrument }));
            setRecordingMeta(songKey, mediaOf(lead.meta), { role: 'original', label: 'All stems', stems });
            saved.slice(1).forEach(({ meta, row }) => {
                setRecordingMeta(songKey, mediaOf(meta), { role: 'stem', stemOf: leadKey, label: row.label.trim() || 'Stem', instrument: row.instrument });
            });
            // Both parts play the set from its file (not a video they may have had before)
            setSlotSource('local', 'original');
            setSlotSource('local', 'backing');
            await adoptStemSet(lead.meta);
            closeModal(MODAL);
            showToast(`Added ${saved.length} stems`);
        } catch (e) {
            console.warn('[Add stems] could not add the stems:', e);
            // Nothing half-added is kept
            for (const { meta } of saved) { try { await unlinkAudioFile(meta.id, songKey); } catch { /* best effort */ } }
            notes.replaceChildren(Object.assign(document.createElement('p'), { textContent: e?.message || 'Could not save the stems' }));
            add.textContent = 'Add stems';
        } finally {
            busy = false;
            add.textContent = 'Add stems';
            refresh();
        }
    });

    refresh();
    openModal(MODAL);
}
