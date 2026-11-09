// songTuningMenu.js
// The Song menu's "Tuning" row: what the open tab was written for, for every kind of tab.
//   Guitar Pro: read from the file (every tuning its tracks report). It cannot be edited here.
//   PDF and text: the tuning stored with the tab. "Change tuning" sets it (it is then the player's own and no import
//   or rescan replaces it).
// Under the row, "Tunings in this song" lists each tuning with a "Show in library" switch. A tuning switched off is
// hidden from this song's labels and from Browse by tunings (and from the fretboard's tuning badge); it stays on the
// song, and this list is the only place it comes back. Everything else (tuner, Guitar panel, playback) still uses the
// real tuning.
// A tab that is not in the library yet keeps its choices on the open file; Save to library writes them to the song.

import { getTuningInfo, getInstrumentMode, extractScoreMetadata, allSongTunings, tuningKeyOf, getHiddenTuningKeys, detectFileMetadata, setCurrentHiddenTunings } from './tuningUtils.js';
import { getAdaptTuningOptions } from './tabAdapter.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const GP_EXT = ['gp', 'gp3', 'gp4', 'gp5', 'gpx'];
const isGpFile = (file) => GP_EXT.includes(String(file?.name || '').split('.').pop().toLowerCase());

/** Notes typed by hand ("D A D F# B E", "DADGBE") to the stored string, or null when they are not a tuning. */
export function parseCustomTuning(text) {
    let cleaned = String(text || '').trim().replace(/♯/g, '#').replace(/♭/g, 'b');
    if (!cleaned) return null;
    // Run together ("dadgbe") every letter is a string, so a flat needs a separator or the flat sign: "D A Eb"
    const run = !/[\s,-]/.test(cleaned);
    if (run) cleaned = cleaned.toUpperCase();
    const tokens = cleaned.match(run ? /[A-G]#?/g : /[A-Ga-g](?:#|b)?/g);
    // Every character must belong to a note: "D A D X B E" is not a tuning
    if (!tokens || tokens.join('').length !== cleaned.replace(/[\s,-]+/g, '').length) return null;
    if (tokens.length < 4 || tokens.length > 10) return null;
    return tokens.map((t) => t[0].toUpperCase() + t.slice(1)).join(' ');
}

/** What the open tab holds, for the row: the tunings found, which this song hides, and whether it can be changed. */
async function readState() {
    const { getCurrentFile } = await import('../main.js');
    const file = getCurrentFile();
    if (!file) return null;
    const gp = isGpFile(file);
    let song = null;
    let tab = null;
    if (file.librarySongId) {
        const { getSongById } = await import('../libraryStore.js');
        song = await getSongById(file.librarySongId);
        tab = song?.tabOptions?.find((t) => t.id === file.tabId) || null;
    }

    let tunings = [];
    let current = null; // the stored tuning of a PDF or text tab
    if (gp) {
        const score = window.gpState?.canvases?.[0]?.api?.score;
        tunings = score ? extractScoreMetadata(score).allTunings : [];
        if (!tunings.length && song) tunings = allSongTunings(song);
    } else if (tab) {
        current = tab.tuning || null;
        tunings = current ? [current] : [];
    } else if (file.tabTuning) {
        current = file.tabTuning.tuning || null;
        tunings = current ? [current] : [];
    } else {
        if (!file._tuningMeta) file._tuningMeta = await detectFileMetadata(file, file.name).catch(() => null);
        current = file._tuningMeta?.primaryTuning || null;
        tunings = current ? [current] : [];
    }

    const hidden = song ? getHiddenTuningKeys(song) : new Set(Array.isArray(file.hiddenTunings) ? file.hiddenTunings : []);
    return { file, song, tab, gp, tunings, current, hidden };
}

function labelOf(t) {
    return getTuningInfo(t)?.displayName || t;
}

function summary(state) {
    const visible = state.tunings.filter((t) => !state.hidden.has(tuningKeyOf(t) || t));
    const hiddenCount = state.tunings.length - visible.length;
    if (!state.tunings.length) return state.gp ? '' : 'Not set';
    if (!visible.length) return 'Hidden in library';
    const text = visible.map(labelOf).join(', ');
    return hiddenCount > 0 ? `${text} · ${hiddenCount} hidden` : text;
}

async function setHidden(state, tuning, hidden) {
    const key = tuningKeyOf(tuning) || tuning;
    if (state.song) {
        const { setSongTuningHidden } = await import('../libraryStore.js');
        await setSongTuningHidden(state.song.id, tuning, hidden);
    } else {
        const keys = new Set(Array.isArray(state.file.hiddenTunings) ? state.file.hiddenTunings : []);
        if (hidden) keys.add(key); else keys.delete(key);
        state.file.hiddenTunings = [...keys];
    }
}

async function setTuning(state, tuning) {
    if (state.tab && state.song) {
        const { setTabTuning } = await import('../libraryStore.js');
        await setTabTuning(state.song.id, state.tab.id, tuning);
    } else {
        state.file.tabTuning = { tuning: tuning || null, source: 'user' };
    }
}

export function initSongTuningMenu() {
    const panelBody = document.querySelector('#scoreOptionsDropdownPanel .synth-panel-body');
    if (!panelBody) return;

    const group = document.createElement('div');
    group.className = 'score-options-group';
    group.id = 'scoreOptionsTuningGroup';
    group.hidden = true;
    group.innerHTML = `
      <button type="button" class="tuning-row" id="songTuningRow" aria-expanded="false" aria-controls="songTuningDetail">
        <span class="tuning-row-text"><b>Tuning</b><small id="songTuningValue"></small></span>
      </button>
      <div class="tuning-detail" id="songTuningDetail" hidden></div>`;

    const place = () => {
        if (group.isConnected) return;
        const anchor = $('scoreOptionsAltTabGroup') || $('scoreOptionsSaveGroup');
        if (anchor) anchor.after(group); else panelBody.appendChild(group);
    };

    const row = group.querySelector('#songTuningRow');
    const value = group.querySelector('#songTuningValue');
    const detail = group.querySelector('#songTuningDetail');
    let seq = 0;
    let open = false;

    const setOpen = (next) => {
        open = next;
        row.setAttribute('aria-expanded', String(next));
        detail.hidden = !next;
        if (next) render();
    };

    async function render() {
        place();
        const mySeq = ++seq;
        const state = await readState();
        if (mySeq !== seq) return;
        setCurrentHiddenTunings(state ? state.hidden : []);
        if (!state || (state.gp && state.tunings.length === 0)) { group.hidden = true; return; }
        group.hidden = false;
        value.textContent = summary(state);
        if (!open) return;

        const items = state.tunings.map((t, i) => {
            const shown = !state.hidden.has(tuningKeyOf(t) || t);
            return `<label class="tuning-item${shown ? '' : ' is-hidden'}" for="songTuningShow${i}">
              <span class="tuning-item-name">${esc(labelOf(t))}</span>
              <span class="form-check form-switch mb-0"><input class="form-check-input theme-switch" type="checkbox" id="songTuningShow${i}" data-i="${i}" ${shown ? 'checked' : ''} aria-label="Show ${esc(labelOf(t))} in library"></span>
            </label>`;
        }).join('');

        const known = getAdaptTuningOptions(getInstrumentMode());
        const currentKey = state.current ? tuningKeyOf(state.current) : null;
        const knownMatch = known.find((k) => tuningKeyOf(k.shortName) === currentKey);
        const change = state.gp ? '' : `
          <div class="tuning-change">
            <label class="form-label" for="songTuningSelect">Tab is written for</label>
            <select class="form-select form-select-sm" id="songTuningSelect">
              <option value="">Not set</option>
              ${known.map((k) => `<option value="${esc(k.shortName)}" ${knownMatch === k ? 'selected' : ''}>${esc(k.name)}</option>`).join('')}
              <option value="__custom" ${state.current && !knownMatch ? 'selected' : ''}>Other tuning</option>
            </select>
            <div class="tuning-custom" id="songTuningCustom" ${state.current && !knownMatch ? '' : 'hidden'}>
              <label class="form-label" for="songTuningNotes">Notes, lowest string first</label>
              <input type="text" class="form-control form-control-sm" id="songTuningNotes" placeholder="D A D G B E" value="${esc(state.current && !knownMatch ? (getTuningInfo(state.current)?.notes || state.current) : '')}" autocomplete="off" spellcheck="false">
              <div class="tuning-custom-error" id="songTuningError" role="alert" hidden>Enter four to ten notes, such as D A D F# B E.</div>
              <button type="button" class="tuning-text-action" id="songTuningSetBtn">Set tuning</button>
            </div>
          </div>`;

        detail.innerHTML = `${change}
          ${items ? `<div class="tuning-list-title">Tunings in this song</div><div class="tuning-list">${items}</div>
          <div class="tuning-note">A tuning switched off is left out of this song's labels and of Browse by tunings.</div>` : ''}`;

        detail.querySelectorAll('input[data-i]').forEach((input) => {
            input.addEventListener('change', async () => {
                await setHidden(state, state.tunings[Number(input.dataset.i)], !input.checked);
                await render();
            });
        });
        const select = detail.querySelector('#songTuningSelect');
        const custom = detail.querySelector('#songTuningCustom');
        select?.addEventListener('change', async () => {
            if (select.value === '__custom') { custom.hidden = false; detail.querySelector('#songTuningNotes')?.focus(); return; }
            custom.hidden = true;
            await setTuning(state, select.value || null);
            await render();
        });
        detail.querySelector('#songTuningSetBtn')?.addEventListener('click', async () => {
            const notes = parseCustomTuning(detail.querySelector('#songTuningNotes').value);
            const err = detail.querySelector('#songTuningError');
            err.hidden = Boolean(notes);
            if (!notes) return;
            await setTuning(state, notes);
            await render();
        });
    }

    row.addEventListener('click', () => setOpen(!open));
    document.addEventListener('scoreoptions:open', () => { place(); render(); });
    window.addEventListener('majestictab:file-loaded', () => { setOpen(false); render(); });
    window.addEventListener('libraryDataChanged', () => { if (group.isConnected) render(); });
    place();
    render();
}

export { isGpFile };
