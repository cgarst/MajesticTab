import { applyGpScoreTransforms } from '../fileAdapters.js';
import { showToast } from '../utils/toast.js';
import { applyScoreAdaptation, getTabAdaptPref } from '../utils/tabAdapter.js';
import { applyTabTrackColors, tintTrackCurves } from '../utils/trackColors.js';
import { createCustomCursorHandler } from './gpPlayer.js';
import { applySoundFontsToApi } from '../soundFontStore.js';
import { applyProgramMapping } from '../soundFontProgramMap.js';
import {
    getInstrumentMode,
    getGuitarTracks,
    getBassTracks,
    getActiveInstrumentTracks,
    GUITAR_PROGRAM_WHITELIST,
    BASS_PROGRAM_WHITELIST,
    applyScoreStringCount,
    getGpStringCountPreference,
    getEffectiveGpStringCount,
    getTabStorageId
} from '../utils/tuningUtils.js';

export {
    getGuitarTracks,
    getBassTracks,
    getActiveInstrumentTracks,
    GUITAR_PROGRAM_WHITELIST,
    BASS_PROGRAM_WHITELIST,
    applyScoreStringCount,
    getGpStringCountPreference,
    getEffectiveGpStringCount,
    getTabStorageId
};

export const DEFAULT_GP_DISPLAY_SCALE = 1.0;
export let GP_DISPLAY_SCALE = DEFAULT_GP_DISPLAY_SCALE;

export function getGpDisplayScalePercent() {
    if (typeof localStorage === 'undefined') {
        return Math.round(DEFAULT_GP_DISPLAY_SCALE * 100);
    }

    const raw = localStorage.getItem('gpSheetScale');
    if (raw === null || raw === '') {
        return Math.round(DEFAULT_GP_DISPLAY_SCALE * 100);
    }

    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value)) {
        return Math.round(DEFAULT_GP_DISPLAY_SCALE * 100);
    }

    return Math.min(150, Math.max(50, value));
}

export function setGpDisplayScale(percent) {
    const numeric = Number.parseInt(percent, 10);
    const safePercent = Number.isFinite(numeric)
        ? Math.min(150, Math.max(50, numeric))
        : Math.round(DEFAULT_GP_DISPLAY_SCALE * 100);

    GP_DISPLAY_SCALE = safePercent / 100;
    if (typeof document !== 'undefined') {
        document.documentElement.style.setProperty('--text-scale', String(GP_DISPLAY_SCALE));
    }
    if (typeof localStorage !== 'undefined') {
        localStorage.setItem('gpSheetScale', String(safePercent));
    }
    return safePercent;
}

export function applySavedGpDisplayScale() {
    return setGpDisplayScale(getGpDisplayScalePercent());
}

export const DEFAULT_GP_NOTATION_MODE = 'tab';

export function getGpNotationMode() {
    if (typeof localStorage === 'undefined') return DEFAULT_GP_NOTATION_MODE;
    const saved = localStorage.getItem('gpNotationMode');
    return saved === 'scoreTab' ? 'scoreTab' : DEFAULT_GP_NOTATION_MODE;
}

export function setGpNotationMode(mode) {
    const safeMode = mode === 'scoreTab' ? 'scoreTab' : 'tab';
    if (typeof localStorage !== 'undefined') {
        localStorage.setItem('gpNotationMode', safeMode);
    }
    return safeMode;
}

export function getGpStaveProfile(mode = getGpNotationMode()) {
    const isScoreTab = mode === 'scoreTab';
    if (typeof alphaTab !== 'undefined' && alphaTab.StaveProfile) {
        return isScoreTab ? alphaTab.StaveProfile.ScoreTab : alphaTab.StaveProfile.Tab;
    }
    return isScoreTab ? 1 : 3;
}

export function getSavedHiddenTracks(file, instrumentMode = getInstrumentMode()) {
    if (!file || typeof localStorage === 'undefined') return null;
    const fileId = getTabStorageId(file) || file.tabId || file.fileStoreId || file.name;
    if (!fileId) return null;
    const key = `gp_hidden_tracks_${instrumentMode}_${String(fileId).toLowerCase().replace(/[^a-z0-9_-]/g, '_')}`;
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

export function saveHiddenTracks(file, hiddenIndices, activeTracks = [], instrumentMode = getInstrumentMode()) {
    if (!file || typeof localStorage === 'undefined') return;
    const fileId = getTabStorageId(file) || file.tabId || file.fileStoreId || file.name;
    if (!fileId) return;
    const key = `gp_hidden_tracks_${instrumentMode}_${String(fileId).toLowerCase().replace(/[^a-z0-9_-]/g, '_')}`;
    try {
        if (!hiddenIndices || hiddenIndices.length === 0) {
            localStorage.removeItem(key);
            return;
        }
        const hiddenNames = (activeTracks || [])
            .filter(ti => hiddenIndices.includes(ti.index))
            .map(ti => ti.track?.name || `Track ${ti.index + 1}`);
        localStorage.setItem(key, JSON.stringify({ hiddenIndices, hiddenNames }));
    } catch (e) {
        console.warn('Could not save hidden tracks:', e);
    }
}

export function loadGuitarPro(file, container, { debug = false, originalFile = null } = {}) {
    const targetFile = originalFile || (file instanceof File ? file : null) || (window.gpState?.currentFile) || null;
    return new Promise((resolve, reject) => {
        if (!container) {
            reject(new Error("Container element is required"));
            return;
        }

        // Create AlphaTab API
        const tempApi = new alphaTab.AlphaTabApi(container, {
            core: { file, enableLazyLoading: false },
            display: { staveProfile: getGpStaveProfile() }
        });

        // Handle file loading errors
        tempApi.error.on((error) => {
            console.error('[AlphaTab API Error]', error);

            if (error?.message?.includes("No compatible importer found for file")) {
                showToast("Unable to load this Guitar Pro file. Ensure the tab is not locked.", "error");
            } else {
                showToast("AlphaTab error: " + (error.message), "error");
            }

            tempApi.destroy();
            reject(error)
        });

        tempApi.scoreLoaded.on((score) => {
            applyGpScoreTransforms(score);
            if (debug) console.log("Tracks:", score.tracks);

            if (Array.isArray(score.tracks)) {
                for (const track of score.tracks) {
                    if (Array.isArray(track.staves)) {
                        for (const staff of track.staves) {
                            staff.showStandardNotation = true;
                            staff.showTablature = true;
                        }
                    }
                }
            }

            // Step 2: filter tracks by active instrument mode (guitar vs bass)
            const activeTracks = getActiveInstrumentTracks(score);
            let activeTrackIndices = activeTracks.map(ti => ti.index);

            // Step 2b: filter out any saved hidden tracks for this tab file
            const savedHidden = getSavedHiddenTracks(targetFile || file);
            if (savedHidden && Array.isArray(savedHidden.hiddenIndices) && savedHidden.hiddenIndices.length > 0) {
                const remaining = activeTrackIndices.filter(idx => !savedHidden.hiddenIndices.includes(idx));
                if (remaining.length > 0) {
                    activeTrackIndices = remaining;
                }
            }

            if (debug) {
                console.log(`[GP] Active tracks (${getInstrumentMode()} mode) found:`, activeTrackIndices.length);
                console.log("[GP] Active track indices:", activeTrackIndices);
            }

            // Step 2c: detect whether file provides an embedded audio backing track
            const hasAudioSync = Boolean(score?.backingTrack?.rawAudioFile);
            if (debug && hasAudioSync) {
                console.log("[GP] Embedded audio sync track detected in Guitar Pro file");
            }

            // Step 3: dispose of temporary API
            tempApi.destroy();

            // Step 4: re-create API with filtered tracks and SoundFont synth / backing track player
            const initialPlayerMode = hasAudioSync
                ? alphaTab.PlayerMode.EnabledBackingTrack
                : alphaTab.PlayerMode.EnabledSynthesizer;

            const api = new alphaTab.AlphaTabApi(container, {
                core: { file, tracks: activeTrackIndices, enableLazyLoading: false },
                player: {
                    enablePlayer: true,
                    playerMode: initialPlayerMode,
                    // No `soundFont` here: applySoundFontsToApi layers every enabled SoundFont below
                    // Refills relay through the main thread; a larger buffer rides out UI stalls (default 500)
                    bufferTimeInMilliseconds: 1000,
                    enableCursor: true,
                    enableElementHighlighting: true,
                    scrollMode: alphaTab.ScrollMode.Off
                },
                display: { staveProfile: getGpStaveProfile(), layoutMode: alphaTab.LayoutMode.Page, scale: GP_DISPLAY_SCALE },
                notation: {
                    rhythmMode: alphaTab.TabRhythmMode.ShowWithBars,
                    elements: {
                        guitarTuning: true
                    }
                }
            });

            api.customCursorHandler = createCustomCursorHandler(api);
            applySoundFontsToApi(api).catch(err => console.error('[SoundFont] Failed to load SoundFonts:', err));

            // Set stylesheet properties on the new score
            api.scoreLoaded.on((newScore) => {
                applyGpScoreTransforms(newScore);
                applyProgramMapping(newScore, api.soundFontPresets);

                const adaptPref = getTabAdaptPref(targetFile || file);
                if (adaptPref) {
                    const summary = applyScoreAdaptation(newScore, adaptPref);
                    newScore._adaptSummary = summary;
                }

                const stringCountPref = getEffectiveGpStringCount(targetFile || file);
                if (stringCountPref && stringCountPref !== 'native') {
                    applyScoreStringCount(newScore, stringCountPref);
                }

                applyTabTrackColors(newScore, activeTrackIndices);

                newScore.stylesheet.hideEmptyStaves = true;
                newScore.stylesheet.hideEmptyStavesInFirstSystem = true;
                newScore.stylesheet.globalDisplayTuning = true;
                const trackNamePolicy = globalThis.alphaTab?.model?.TrackNamePolicy;
                if (trackNamePolicy) {
                    newScore.stylesheet.singleTrackTrackNamePolicy = trackNamePolicy.Hidden;
                    newScore.stylesheet.multiTrackTrackNamePolicy = trackNamePolicy.Hidden;
                }

                if (Array.isArray(newScore.tracks)) {
                    for (const track of newScore.tracks) {
                        if (Array.isArray(track.staves)) {
                            for (const staff of track.staves) {
                                staff.showStandardNotation = true;
                                staff.showTablature = true;
                            }
                        }
                    }
                }

                if (debug) {
                    console.log("Hide empty staves enabled:", newScore.stylesheet.hideEmptyStaves);
                }
            });

            // Registered before any other render listener so Page mode clones the tinted SVG
            api.postRenderFinished.on(() => tintTrackCurves(api, container));

            api.postRenderFinished.on(() => {
                // debugging
                if (debug) {
                    console.log("AlphaTab postRenderFinished fired");
                    console.log('Container height after render:', container.offsetHeight);
                }

                resolve(api);
            });
        });
    });
}