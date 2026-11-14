// classtab/midiSynth.js
// Synth & auto-scroll clock for text and PDF tabs.
// - For classical/staff .txt tabs: always attaches a playable Synth transport—either playing a linked .mid file
//   (auto-aligned to the tab's bars via txtMidiAlign.js) or running a steady Bar-Paced Clock in "Silent (scroll only)"
//   mode (with Metronome and Count-in still audible through gpPlayer's clickContext).
// - For PDF or chord/lyric .txt tabs without staff systems: plays a linked .mid file when present, or offers the link action.

import { readMidiFile, createSilentMidiFile } from './midiReader.js';
import { resolveTabTempoAndMeter } from './tabTempoMeta.js';
import { alignTxtAndMidi } from './txtMidiAlign.js';
import { textState } from '../textProcessor/textHandler.js';
import { applySoundFontsToApi } from '../soundFontStore.js';
import { setActiveAudioMode } from '../utils/navigationUtils.js';
import { attachAlphaTabApi, showSynthPlayer, hideSynthPlayer, detachAlphaTabApi, getPlayerContext, isSynthPlaying, synthPlayerState, setSilentSynthMode, updateSynthUI } from '../gpProcessor/gpPlayer.js';
import { saveAudioFile, getAudioFile, putAudioRecord, unlinkAudioFile } from '../audioSync/audioFileStore.js';
import { getLocalRecording } from '../audioSync/audioFilePlayer.js';
import { playerState } from '../youtubePlayer.js';
import { getSongById } from '../libraryStore.js';
import { fretboardController } from '../fretboard/fretboardController.js';
import { showToast } from '../utils/toast.js';

let hostEl = null;
let ownApi = null;
let ownFile = null;
let currentMidiBytes = null;
let currentHearMode = 'midi'; // 'midi' | 'silent'

/** True when this file's MIDI/clock is already the reader's live synth (a re-layout of the same tab must not rebuild it). */
export function midiSynthIsFor(file) {
    return !!file && midiSynthActive && ownFile === file && !!ownApi && window.gpApi === ownApi;
}

/** True when a MIDI or Bar-Paced synth source is loaded as the reader's synth. */
export let midiSynthActive = false;

/** True when an actual .mid file is linked to the current text/PDF tab. */
export let hasLinkedMidiFile = false;

export function getTxtHearMode() {
    return hasLinkedMidiFile ? currentHearMode : 'silent';
}

function buildVirtualScore(baseBpm, visualBars) {
    const bpm = Math.max(20, Math.min(320, Math.round(baseBpm || 100)));
    const bars = Array.isArray(visualBars) && visualBars.length > 0
        ? visualBars
        : [{ startMs: 0, endMs: 2000 }];
    const masterBars = bars.map((vb, idx) => {
        const sMs = typeof vb.startMs === 'number' ? vb.startMs : idx * 2000;
        const eMs = typeof vb.endMs === 'number' && vb.endMs > sMs ? vb.endMs : sMs + 2000;
        const sTick = Math.round(sMs * 0.96);
        const eTick = Math.max(sTick + 1, Math.round(eMs * 0.96));
        return {
            index: idx,
            start: sTick,
            startMs: sMs,
            endMs: eMs,
            calculateDuration: () => eTick - sTick
        };
    });
    return {
        tempo: bpm,
        masterBars
    };
}

/**
 * @param {Uint8Array|null} bytes the MIDI file bytes (or null when `options.parsedMidi` is provided)
 * @param {{ parsedMidi?: object, baseBpm?: number, visualBars?: Array<any>, silent?: boolean }} [options]
 * @returns {Promise<void>} resolves once the synth has been handed to the reader
 */
export async function attachMidiSynth(bytes, options = {}) {
    const at = globalThis.alphaTab;
    const parsed = options.parsedMidi || readMidiFile(bytes, at);
    const { file, clicks } = parsed;
    const baseBpm = Math.max(20, Math.min(320, Math.round(options.baseBpm || parsed.primaryBpm || 100)));
    const virtualScore = buildVirtualScore(baseBpm, options.visualBars || parsed.bars || []);
    const isSilent = Boolean(options.silent);

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
    api.tex(`\\tempo ${baseBpm} . 3.3.4`);
    api.keepPositionOnPause = true; // pausing a MIDI file would reset its player to 0:00 (gpPlayer restores the spot)
    api.followDisabled = true; // its placeholder score has no page to scroll to (gpPlayer's playback follow skips it)
    api.virtualScore = virtualScore;
    window.gpApi = api;
    ownApi = api;
    midiSynthActive = true;
    applySoundFontsToApi(api).catch((e) => console.error('[SoundFont] Failed to load SoundFonts:', e));
    attachAlphaTabApi(api, { clicks, silent: isSilent, virtualScore });
    setSilentSynthMode(isSilent);
    // The fretboard shows Guitar Pro notes only; this placeholder score has none
    const noFretboard = () => { if (ownApi === api) fretboardController.onScoreClosed(); };
    noFretboard();
    api.scoreLoaded.on(noFretboard);
    api.renderFinished?.on(noFretboard);
    showSynthPlayer();
    // The placeholder score generates its own MIDI at first and again whenever the reader rebuilds it (a track mode
    // or SoundFont change); the file replaces it every time.
    let ours = false;
    const load = () => {
        if (ownApi !== api) return;
        noFretboard();
        ours = true;
        try {
            api.player?.loadMidiFile(file);
            setSilentSynthMode(isSilent);
        } catch (e) { ours = false; console.warn('[MIDI synth]', e); }
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
    hasLinkedMidiFile = false;
    currentMidiBytes = null;
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
const isStaffTxt = (file) => /\.txt$/i.test(file?.name || '') && Boolean(textState.hasSystems);
const $ = (id) => document.getElementById(id);

let bare = false;

function showLinkUi(file) {
    const eligible = isTextOrPdf(file);
    const staffTxt = isStaffTxt(file);
    const active = midiSynthActive;
    const linked = hasLinkedMidiFile;

    document.body.classList.toggle('midi-synth-source', active);
    document.body.classList.toggle('txt-has-bars', staffTxt);

    if (eligible && !active) {
        bare = true;
        showSynthPlayer();
    } else if (bare && !active && !getPlayerContext().api) {
        bare = false;
        hideSynthPlayer();
    } else if (!eligible || active) {
        bare = false;
    }
    document.body.classList.toggle('midi-synth-none', eligible && !active);

    // Configure Sound -> Hear (#synthTrackModeContainer) for GP vs staff .txt vs PDF
    const trackContainer = $('synthTrackModeContainer');
    const gpGroup = $('synthTrackGpGroup');
    const midiGroup = $('synthHearMidiGroup');
    const midiRadio = $('synthHearMidiAudio');
    const silentRadio = $('synthHearSilentScroll');

    if (gpGroup) gpGroup.style.display = eligible ? 'none' : '';
    if (midiGroup) midiGroup.style.display = staffTxt ? '' : 'none';
    if (trackContainer) trackContainer.style.display = (!eligible || staffTxt) ? '' : 'none';

    if (staffTxt && midiRadio && silentRadio) {
        const effectiveSilent = !linked || currentHearMode === 'silent';
        midiRadio.disabled = !linked;
        silentRadio.disabled = false;
        midiRadio.checked = !effectiveSilent;
        silentRadio.checked = effectiveSilent;
        window.refreshSlidingPills?.($('synthDropdownPanel'), true);
    }

    if ($('synthMidiSection')) $('synthMidiSection').style.display = eligible || active ? '' : 'none';
    if ($('synthMidiNote')) {
        if (staffTxt && linked) {
            $('synthMidiNote').textContent = currentHearMode === 'silent'
                ? 'Silent bar-by-bar auto-scroll. The linked MIDI audio is muted.'
                : 'Plays the linked MIDI file, auto-synced to the tab bars.';
        } else if (staffTxt) {
            $('synthMidiNote').textContent = 'Silent bar-by-bar auto-scroll is active. Link a MIDI file if you also want synth audio.';
        } else {
            $('synthMidiNote').textContent = linked
                ? "Plays the MIDI file. It isn't synced to the tab."
                : "Link a MIDI file to hear this tab. It isn't synced to the tab.";
        }
    }
    if ($('synthMidiReplaceBtn')) $('synthMidiReplaceBtn').textContent = linked ? 'Link another MIDI file\u2026' : 'Link a MIDI file\u2026';
    if ($('synthMidiRemoveBtn')) $('synthMidiRemoveBtn').style.display = linked ? '' : 'none';
}

/**
 * Configures and attaches the aligned MIDI or Bar-Paced Clock synth for a staff `.txt` tab.
 */
async function setupStaffTxtSynth(file, bytes) {
    const at = globalThis.alphaTab;
    let midiData = null;
    if (bytes) {
        midiData = readMidiFile(bytes, at);
        hasLinkedMidiFile = true;
        currentMidiBytes = bytes;
    } else {
        hasLinkedMidiFile = false;
        currentMidiBytes = null;
    }

    const effectiveMode = (hasLinkedMidiFile && currentHearMode !== 'silent') ? 'midi' : 'silent';
    const tempoMeta = resolveTabTempoAndMeter({
        headerText: textState.rawText,
        blocks: textState.blocks,
        midiMeta: midiData
    });
    const aligned = alignTxtAndMidi({
        blocks: textState.blocks,
        midiData,
        tuning: textState.tuning,
        capoFret: textState.capoFret,
        baseBpm: tempoMeta.baseBpm,
        beatUnit: tempoMeta.beatUnit,
        timeSig: tempoMeta.timeSig,
        mode: effectiveMode,
        version: textState.activeVersion || 1
    });

    textState.tempoMeta = tempoMeta;
    textState.alignment = aligned;

    if (effectiveMode === 'silent') {
        const silentParsed = createSilentMidiFile(aligned.barTimeline, tempoMeta.timeSig, tempoMeta.baseBpm, at);
        await attachMidiSynth(null, {
            parsedMidi: silentParsed,
            baseBpm: tempoMeta.baseBpm,
            visualBars: aligned.visualBars,
            silent: true
        });
    } else {
        await attachMidiSynth(bytes, {
            parsedMidi: midiData,
            baseBpm: tempoMeta.baseBpm,
            visualBars: aligned.visualBars,
            silent: false
        });
    }

    hasLinkedMidiFile = Boolean(bytes);
    currentMidiBytes = bytes || null;
    ownFile = file;
    showLinkUi(file);
    updateSynthUI();

    window.dispatchEvent(new CustomEvent('majestictab:txt-aligned', {
        detail: {
            file,
            aligned,
            tempoMeta,
            mode: effectiveMode,
            hasLinkedMidi: hasLinkedMidiFile
        }
    }));
}

/** After a text or PDF tab is on screen: give it the MIDI or Bar-Paced Clock it has. */
export async function attachSynthMidiForFile(file, getCurrent) {
    if (midiSynthIsFor(file)) { showLinkUi(file); return; }
    removeMidiSynth();
    showLinkUi(file);
    if (!isTextOrPdf(file)) return;
    try {
        const bytes = await bytesFor(file);
        if (getCurrent() !== file) return;

        if (isStaffTxt(file)) {
            if (bytes) currentHearMode = 'midi';
            await setupStaffTxtSynth(file, bytes);
            // If no MIDI is linked and the song has a real recording (YouTube / local audio), let Original lead;
            // otherwise select Synth so Space/Play immediately drives the Bar-Paced auto-scroll clock.
            const hasRealRecording = Boolean(playerState.videoId || getLocalRecording());
            if (!bytes && hasRealRecording && !isSynthPlaying() && !synthPlayerState.isOpen) {
                setActiveAudioMode('real');
            } else if (!isSynthPlaying()) {
                setActiveAudioMode('synth');
            }
            return;
        }

        if (!bytes && getCurrent() === file && !isSynthPlaying() && !synthPlayerState.isOpen) setActiveAudioMode('real');
        if (!bytes || getCurrent() !== file) return;
        hasLinkedMidiFile = true;
        currentMidiBytes = bytes;
        await attachMidiSynth(bytes);
        hasLinkedMidiFile = true;
        currentMidiBytes = bytes;
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

/** Wire the Synth panel's link, replace, remove, and Hear mode switch. */
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
            currentHearMode = 'midi';
            if (isStaffTxt(file)) {
                await setupStaffTxtSynth(file, picked.bytes);
            } else {
                await attachMidiSynth(picked.bytes);
                hasLinkedMidiFile = true;
                currentMidiBytes = picked.bytes;
                ownFile = file;
                showLinkUi(file);
            }
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
        if (isStaffTxt(file)) {
            await setupStaffTxtSynth(file, null);
        } else {
            removeMidiSynth();
            showLinkUi(file);
        }
    });

    // Wire Sound -> Hear: [ MIDI audio ] [ Silent (scroll only) ] on staff .txt tabs
    document.querySelectorAll('input[name="synthHearMidiMode"]').forEach((radio) => {
        radio.addEventListener('change', async () => {
            if (!radio.checked) return;
            const file = getCurrent();
            if (!isStaffTxt(file)) return;
            currentHearMode = radio.value === 'silent' ? 'silent' : 'midi';
            const wasPlaying = isSynthPlaying();
            const prevTime = synthPlayerState.currentTime || 0;
            await setupStaffTxtSynth(file, currentMidiBytes);
            if (prevTime > 0 && window.gpApi) {
                try {
                    window.gpApi.timePosition = prevTime;
                    synthPlayerState.currentTime = prevTime;
                } catch (_) {}
            }
            if (wasPlaying && window.gpApi) {
                try { window.gpApi.play(); } catch (_) {}
            }
        });
    });

    window.addEventListener('majestictab:txt-version-changed', async () => {
        const file = getCurrent();
        if (isStaffTxt(file)) {
            await setupStaffTxtSynth(file, currentMidiBytes);
        }
    });

    window.addEventListener('majestictab:file-loaded', (e) => {
        const file = e.detail?.file;
        if (file) attachSynthMidiForFile(file, getCurrent);
    });
}
