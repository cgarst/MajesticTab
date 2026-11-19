// slotRecordings.js
// The Original panel lists the recordings of each part at once: "Recordings for Full band" and "Recordings for Backing", whichever
// part the dock has selected. A row of the other part first makes that part the active one (the dock follows), then picks the
// recording as usual. The lists the panel always had (#recEmbeddedList, #afFileList, #ytVideoList) keep rendering for the active
// slot as hidden state; this reads the same data for both slots.
//
// Which recordings a part lists: its remembered videos; the audio files whose role in the pack is for it (a backing role is for
// Backing, every other role and a file with no role are for Full band) and the file it plays now; the audio in the Guitar Pro file
// under Full band.

import { switchRealAudioSlot, switchRealAudioSource, getActiveSlot, slotSelection, hasEmbeddedAudio } from './realAudioController.js';
import { buildFileRows, buildMissingFileRows } from './audioFilePlayer.js';
import { buildVideoRows, handleVideoListClick } from '../soundPlayer.js';
import { mediaKey, SYNC_CHANGED_EVENT } from './syncStore.js';
import { REC_REMOVE_MODE_EVENT } from './removeMode.js';
import { AUDIO_FILES_CHANGED_EVENT } from './audioBackup.js';

const $ = (id) => document.getElementById(id);
const SLOTS = [['original', 'Full band'], ['backing', 'Backing']];

function embeddedRow(selected, beforeSelect) {
    const row = document.createElement('div');
    row.className = 'vrow';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'slot';
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', selected ? 'true' : 'false');
    const rd = document.createElement('span'); rd.className = 'rd'; rd.setAttribute('aria-hidden', 'true');
    const t = document.createElement('span'); t.className = 't';
    const b = document.createElement('b'); b.textContent = 'Audio in the Guitar Pro file';
    const sub = document.createElement('span'); sub.textContent = 'Stored in the song file · Mapped';
    t.append(b, sub);
    btn.append(rd, t);
    btn.addEventListener('click', () => { beforeSelect(); switchRealAudioSource('embedded'); });
    row.append(btn);
    return row;
}

export function initSlotRecordings() {
    const host = $('recBySlot');
    if (!host) return;
    const groups = SLOTS.map(([slot, name]) => {
        const group = document.createElement('section');
        group.className = 'rec-slot-group';
        group.dataset.slot = slot;
        const id = `recFor_${slot}`;
        const head = document.createElement('h3');
        head.className = 'rec-slot-head';
        head.id = id;
        head.textContent = `Recordings for ${name}`;
        const list = document.createElement('div');
        list.className = 'rec-slots';
        list.setAttribute('role', 'radiogroup');
        list.setAttribute('aria-labelledby', id);
        const empty = document.createElement('p');
        empty.className = 'rec-slot-empty';
        empty.textContent = 'Nothing attached';
        group.append(head, list, empty);
        host.append(group);
        list.addEventListener('click', (e) => handleVideoListClick(e, () => { if (getActiveSlot() !== slot) switchRealAudioSlot(slot); }));
        return { slot, group, list, empty };
    });

    const render = () => {
        groups.forEach(({ slot, group, list, empty }) => {
            const goHere = () => { if (getActiveSlot() !== slot) switchRealAudioSlot(slot); };
            const sel = slotSelection(slot);
            const rows = [];
            if (slot === 'original' && hasEmbeddedAudio()) rows.push(embeddedRow(sel?.kind === 'embedded', goHere));
            rows.push(...buildFileRows({
                include: (f, metas) => {
                    const role = metas[mediaKey({ kind: 'local', audioId: f.id })]?.role;
                    return (role === 'backing' ? 'backing' : 'original') === slot || (sel?.kind === 'local' && sel.audioId === f.id);
                },
                selected: (id) => sel?.kind === 'local' && sel.audioId === id,
                beforeSelect: goHere
            }));
            if (slot === 'original') rows.push(...buildMissingFileRows());
            rows.push(...buildVideoRows(slot));
            list.replaceChildren(...rows);
            empty.hidden = rows.length > 0;
            if (getActiveSlot() === slot) group.setAttribute('aria-current', 'true'); else group.removeAttribute('aria-current');
        });
    };
    let queued = false;
    const queue = () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; render(); });
    };

    // Anything that changes a recording, a slot or the remove toggle re-renders the lists the panel already keeps
    ['recEmbeddedList', 'afFileList', 'ytVideoList'].forEach((id) => {
        if ($(id)) new MutationObserver(queue).observe($(id), { childList: true });
    });
    ['slotRowOriginal', 'slotRowBacking'].forEach((id) => {
        if ($(id)) new MutationObserver(queue).observe($(id), { attributes: true, attributeFilter: ['aria-checked'] });
    });
    [SYNC_CHANGED_EVENT, REC_REMOVE_MODE_EVENT, AUDIO_FILES_CHANGED_EVENT].forEach((evt) => window.addEventListener(evt, queue));
    render();
}
