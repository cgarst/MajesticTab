// slotRecordings.js
// The Original panel's recordings are two expandable sections, Full band and Backing, in the style of the rows the panel
// folds other things under. Each row names what that part plays now, so both parts can be read without opening anything, and
// opens to the part's recordings, whichever part the dock has selected. A row of the other part first makes that part the active
// one (the dock follows), then picks the recording as usual. The lists the panel always had (#recEmbeddedList, #afFileList,
// #ytVideoList) keep rendering for the active slot as hidden state; this reads the same data for both slots.
// Which section is open: with a stem set both start closed (the stems stay on top); otherwise the active part's is open, and the
// dock changing part opens that part's. The person's own opening and closing stands until one of those happens.
// The two Add a video buttons (Add to Full band, Add to Backing) switch to their part and then add what is in the field: nothing
// is added to a part by default.
//
// Which recordings a part lists: its remembered videos; the audio files whose role in the pack is for it (a backing role is for
// Backing, every other role and a file with no role are for Full band) and the file it plays now; the audio in the Guitar Pro file
// under Full band.

import { switchRealAudioSlot, switchRealAudioSource, getActiveSlot, slotSelection, hasEmbeddedAudio } from './realAudioController.js';
import { buildFileRows, buildMissingFileRows } from './audioFilePlayer.js';
import { buildVideoRows, handleVideoListClick, addVideoFieldUntouched, ADD_VIDEO_EVENT } from '../soundPlayer.js';
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
    const stems = $('afStemSection');

    const groups = SLOTS.map(([slot, name]) => {
        const group = document.createElement('details');
        group.className = 'rec-part';
        group.dataset.slot = slot;
        const summary = document.createElement('summary');
        const title = document.createElement('span');
        title.textContent = name;
        const now = document.createElement('span');
        now.className = 'rec-part-now';
        summary.append(title, now);
        const list = document.createElement('div');
        list.className = 'rec-slots';
        list.setAttribute('role', 'radiogroup');
        list.setAttribute('aria-label', `Recordings for ${name}`);
        const empty = document.createElement('p');
        empty.className = 'rec-part-empty';
        empty.textContent = 'Nothing attached';
        group.append(summary, list, empty);
        host.append(group);
        list.addEventListener('click', (e) => handleVideoListClick(e, () => { if (getActiveSlot() !== slot) switchRealAudioSlot(slot); }));
        return { slot, group, list, empty, now };
    });
    const sectionOf = (slot) => groups.find((g) => g.slot === slot)?.group;

    const render = () => {
        groups.forEach(({ slot, list, empty, now }) => {
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
            // The row says what the part plays: the title of its selected recording
            now.textContent = list.querySelector('[aria-checked="true"] .t b')?.textContent || 'Nothing attached';
        });
    };

    // Which sections start open: see the header. Run when the stems come or go and when the dock changes part.
    let stemsWere = null;
    let lastActive = null;
    let noneWas = false;
    const arrange = () => {
        const withStems = Boolean(stems) && !stems.hidden;
        const active = getActiveSlot();
        const none = groups.every((g) => !g.empty.hidden);
        if (withStems !== stemsWere) {
            stemsWere = withStems;
            groups.forEach(({ slot, group }) => { group.open = !withStems && slot === active; });
        } else if (!withStems && none && !noneWas) {
            // With nothing attached the two sections are the whole panel
            groups.forEach(({ group }) => { group.open = true; });
        } else if (active !== lastActive && !withStems) {
            const next = sectionOf(active);
            if (next) next.open = true;
        }
        lastActive = active;
        noneWas = none;
    };

    let queued = false;
    const queue = () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; render(); arrange(); });
    };

    // Anything that changes a recording, a slot or the remove toggle re-renders the lists the panel already keeps
    ['recEmbeddedList', 'afFileList', 'ytVideoList'].forEach((id) => {
        if ($(id)) new MutationObserver(queue).observe($(id), { childList: true });
    });
    ['slotRowOriginal', 'slotRowBacking'].forEach((id) => {
        if ($(id)) new MutationObserver(queue).observe($(id), { attributes: true, attributeFilter: ['aria-checked'] });
    });
    if (stems) new MutationObserver(queue).observe(stems, { attributes: true, attributeFilter: ['hidden'] });
    // Add a video: the part is chosen here, then the field is added to it
    [['ytAddFullBtn', 'original'], ['ytAddBackingBtn', 'backing']].forEach(([id, slot]) => {
        $(id)?.addEventListener('click', () => {
            const text = $('ytSearchQueryInput')?.value || ''; // switching the part resets the field, so read it first
            const useDefault = addVideoFieldUntouched();
            if (getActiveSlot() !== slot) switchRealAudioSlot(slot);
            const section = sectionOf(slot);
            if (section) section.open = true;
            window.dispatchEvent(new CustomEvent(ADD_VIDEO_EVENT, { detail: { text, useDefault } }));
        });
    });
    [SYNC_CHANGED_EVENT, REC_REMOVE_MODE_EVENT, AUDIO_FILES_CHANGED_EVENT].forEach((evt) => window.addEventListener(evt, queue));
    render();
    arrange();
}
