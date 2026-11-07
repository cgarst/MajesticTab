// classtab/midiSynth.js
// A MIDI file as the Synth source of a text or PDF tab. The file is not synced to the tab, so nothing follows it on
// the page. It plays through the reader's existing synth (SoundFont, volume, latency, speed, loop by time) by
// loading it into a hidden AlphaTab player that holds a one-bar placeholder score, and handing that player to gpPlayer.

import { readMidiFile } from './midiReader.js';
import { applySoundFontsToApi } from '../soundFontStore.js';
import { setActiveAudioMode } from '../utils/navigationUtils.js';
import { attachAlphaTabApi, showSynthPlayer, hideSynthPlayer, detachAlphaTabApi, getPlayerContext, isSynthPlaying, synthPlayerState } from '../gpProcessor/gpPlayer.js';
import { saveAudioFile, getAudioFile, putAudioRecord, unlinkAudioFile } from '../audioSync/audioFileStore.js';
import { getSongById } from '../libraryStore.js';
import { fretboardController } from '../fretboard/fretboardController.js';
import { showToast } from '../utils/toast.js';

let hostEl = null;
let ownApi = null;
let ownFile = null;

/** True when this file's MIDI is already the reader's live synth (a re-layout of the same tab must not rebuild it). */
export function midiSynthIsFor(file) {
    return !!file && midiSynthActive && ownFile === file && !!ownApi && window.gpApi === ownApi;
}

/** True when a MIDI synth source is loaded as the reader's synth. */
export let midiSynthActive = false;

/**
 * @param {Uint8Array} bytes the MIDI file
 * @returns {Promise<void>} resolves once the synth has been handed to the reader
 */
export async function attachMidiSynth(bytes) {
    const at = globalThis.alphaTab;
    const { file, clicks } = readMidiFile(bytes, at);
    removeMidiSynth();
    hostEl = document.createElement('div');
    hostEl.className = 'midi-synth-host';
    hostEl.setAttribute('aria-hidden', 'true');
    hostEl.style.cssText = 'position:fixed;left:-9999px;top:0;width:320px;height:160px;overflow:hidden;pointer-events:none';
    document.body.appendChild(hostEl);
    const api = new at.AlphaTabApi(hostEl, {
        core: { tex: true },
        player: { enablePlayer: true, playerMode: at.PlayerMode.EnabledSynthesizer, enableCursor: false, enableElementHighlighting: false, scrollMode: at.ScrollMode.Off }
    });
    api.tex('\\tempo 100 . 3.3.4');
    api.keepPositionOnPause = true; // pausing a MIDI file would reset its player to 0:00 (gpPlayer restores the spot)
    api.followDisabled = true; // its placeholder score has no page to scroll to (gpPlayer's playback follow skips it)
    window.gpApi = api;
    ownApi = api;
    midiSynthActive = true;
    applySoundFontsToApi(api).catch((e) => console.error('[SoundFont] Failed to load SoundFonts:', e));
    attachAlphaTabApi(api, { clicks });
    // The fretboard shows Guitar Pro notes only; this placeholder score has none
    const noFretboard = () => { if (ownApi === api) fretboardController.onScoreClosed(); };
    noFretboard();
    api.scoreLoaded.on(noFretboard);
    api.renderFinished?.on(noFretboard);
    showSynthPlayer();
    // The placeholder score generates its own MIDI at first and again whenever the reader rebuilds it (a track mode
    // or SoundFont change); the file replaces it every time. Not midiLoaded.on: AlphaTab 1.8.4 recurses forever in its
    // loadedMidiInfo getter once that event has a listener, so the load step itself is wrapped instead.
    // `ours` is true while the file is the player's loaded MIDI. playerReady is the player's readyForPlayback event, which
    // fires after every loadMidiFile, so it may only load when the file is not loaded yet; otherwise load, ready, load
    // repeats forever and pins the synth worker at full CPU.
    let ours = false;
    const load = () => {
        if (ownApi !== api) return;
        noFretboard();
        ours = true;
        try { api.player?.loadMidiFile(file); } catch (e) { ours = false; console.warn('[MIDI synth]', e); }
    };
    const original = api.loadMidiForScore.bind(api);
    api.loadMidiForScore = (...args) => {
        ours = false;
        const r = original(...args);
        load();
        return r;
    };
    api.playerReady?.on(() => { if (!ours) load(); });
}

export function removeMidiSynth() {
    // Only take the player down while it is still ours: opening a Guitar Pro file has already replaced it
    if (midiSynthActive && ownApi && window.gpApi === ownApi) {
        try { detachAlphaTabApi(); } catch { /* already gone */ }
    }
    ownApi = null;
    ownFile = null;
    midiSynthActive = false;
    hostEl?.remove();
    hostEl = null;
}

// --- Storage: a library song keeps its MIDI in the audio store, under a key of its own so the sync editor never lists it

const midiKey = (songId) => `midi:${songId}`;

export async function saveSongMidi(songId, name, bytes) {
    const { putLibraryRecord } = await import('../libraryStore.js');
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const meta = await saveAudioFile({ name, type: 'audio/midi', data, songKey: midiKey(songId) });
    const full = await getAudioFile(meta.id);
    if (full && full.kind !== 'midi') await putAudioRecord({ ...full, kind: 'midi' });
    const song = await getSongById(songId);
    if (song) await putLibraryRecord('song', { ...song, synthMidi: { audioFileId: meta.id, name } });
}

export async function removeSongMidi(songId) {
    const { putLibraryRecord } = await import('../libraryStore.js');
    const song = await getSongById(songId);
    if (!song?.synthMidi) return;
    await unlinkAudioFile(song.synthMidi.audioFileId, midiKey(songId));
    const { synthMidi, ...rest } = song;
    await putLibraryRecord('song', rest);
}

async function bytesFor(file) {
    if (file.synthMidiBytes) return file.synthMidiBytes;
    if (typeof file.synthMidiLoader === 'function') return file.synthMidiLoader();
    if (file.librarySongId) {
        const song = await getSongById(file.librarySongId);
        const rec = song?.synthMidi && await getAudioFile(song.synthMidi.audioFileId);
        if (rec?.data) return new Uint8Array(rec.data);
    }
    return null;
}

const isTextOrPdf = (file) => /\.(txt|pdf)$/i.test(file?.name || '');
const $ = (id) => document.getElementById(id);

// A text or PDF tab always offers Synth beside Original, even before a MIDI file is linked: pressing it opens a panel whose
// only action is to link one. `bare` is true while the button is shown on that promise alone.
let bare = false;

function showLinkUi(file) {
    const eligible = isTextOrPdf(file);
    const linked = midiSynthActive;
    // The MIDI file's player holds a one-bar placeholder score, so bar loops mean nothing: design.css hides them
    document.body.classList.toggle('midi-synth-source', linked);
    if (eligible && !linked) {
        bare = true;
        showSynthPlayer();
    } else if (bare && !linked && !getPlayerContext().api) {
        bare = false;
        hideSynthPlayer();
    } else if (!eligible || linked) {
        bare = false;
    }
    document.body.classList.toggle('midi-synth-none', eligible && !linked);
    // A text or PDF tab always gets the section: link a MIDI file when none is linked, replace or remove it when one is
    if ($('synthMidiSection')) $('synthMidiSection').style.display = eligible || linked ? '' : 'none';
    if ($('synthMidiNote')) $('synthMidiNote').textContent = linked ? "Plays the MIDI file. It isn't synced to the tab." : 'Link a MIDI file to hear this tab. It isn\'t synced to the tab.';
    if ($('synthMidiReplaceBtn')) $('synthMidiReplaceBtn').textContent = linked ? 'Link another MIDI file\u2026' : 'Link a MIDI file\u2026';
    if ($('synthMidiRemoveBtn')) $('synthMidiRemoveBtn').style.display = linked ? '' : 'none';
}

/** After a text or PDF tab is on screen: give it the MIDI it has, if any. */
export async function attachSynthMidiForFile(file, getCurrent) {
    if (midiSynthIsFor(file)) { showLinkUi(file); return; }
    removeMidiSynth();
    showLinkUi(file);
    if (!isTextOrPdf(file)) return;
    try {
        const bytes = await bytesFor(file);
        // No MIDI to play: the tab opens on Original, which is where its recording and sync points are. Synth stays one press
        // away, and opens the panel that links a MIDI file. Opening that panel re-lays-out the page and runs this again, so it
        // leaves the choice alone while the panel is open.
        if (!bytes && getCurrent() === file && !isSynthPlaying() && !synthPlayerState.isOpen) setActiveAudioMode('real');
        if (!bytes || getCurrent() !== file) return;
        await attachMidiSynth(bytes);
        ownFile = file;
        showLinkUi(file);
    } catch (e) {
        console.warn('[MIDI synth]', e);
        showToast(e?.message || 'Could not load the MIDI file.', 'warning');
    }
}

function pickMidi() {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.mid,.midi,audio/midi,audio/x-midi';
        input.addEventListener('change', async () => {
            const f = input.files?.[0];
            resolve(f ? { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) } : null);
        });
        input.addEventListener('cancel', () => resolve(null));
        input.click();
    });
}

/** Wire the Synth panel's link, replace and remove. */
export function initMidiSynthUi(getCurrent) {
    const link = async () => {
        const file = getCurrent();
        if (!isTextOrPdf(file)) return;
        const picked = await pickMidi();
        if (!picked) return;
        try {
            readMidiFile(picked.bytes); // refuse a file that is not MIDI before anything is stored
            file.synthMidiBytes = picked.bytes;
            if (file.librarySongId) await saveSongMidi(file.librarySongId, picked.name, picked.bytes);
            await attachMidiSynth(picked.bytes);
            ownFile = file;
            showLinkUi(file);
        } catch (e) {
            showToast(e?.message || 'Could not use that MIDI file.', 'warning');
        }
    };
    $('synthMidiReplaceBtn')?.addEventListener('click', link);
    $('synthMidiRemoveBtn')?.addEventListener('click', async () => {
        const file = getCurrent();
        if (!file) return;
        delete file.synthMidiBytes;
        delete file.synthMidiLoader;
        if (file.librarySongId) await removeSongMidi(file.librarySongId).catch(() => {});
        removeMidiSynth();
        showLinkUi(file);
    });
    window.addEventListener('majestictab:file-loaded', (e) => {
        const file = e.detail?.file;
        if (file) attachSynthMidiForFile(file, getCurrent);
    });
}
