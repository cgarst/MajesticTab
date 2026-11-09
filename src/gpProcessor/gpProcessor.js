import { showToast } from '../utils/toast.js';
import { applyScoreAdaptation, getTabAdaptPref } from '../utils/tabAdapter.js';
import { getNotationOverride, beginSong } from '../utils/sessionOverrides.js';
import { applyTabTrackColors, tintTrackCurves } from '../utils/trackColors.js';
import { fitTempoLabels } from '../utils/tempoLabelFit.js';
import { fitScoreText } from '../utils/scoreTextFit.js';
import { createCustomCursorHandler } from './gpPlayer.js';
import { applySoundFontsToApi } from '../soundFontStore.js';
import { applyProgramMapping } from '../soundFontProgramMap.js';
import { beginSynthContextCapture } from '../utils/iosAudioUnlock.js';
import { readGpSoundHints, applyGpSoundHints } from './gpSoundHints.js';
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

export const DEFAULT_GP_DISPLAY_SCALE = 0.8;
export let GP_DISPLAY_SCALE = DEFAULT_GP_DISPLAY_SCALE;

export function getDefaultGpDisplayScalePercent() {
    return Math.round(DEFAULT_GP_DISPLAY_SCALE * 100);
}

export function getGpDisplayScalePercent() {
    if (typeof localStorage === 'undefined') {
        return getDefaultGpDisplayScalePercent();
    }

    const raw = localStorage.getItem('gpSheetScale');
    if (raw === null || raw === '') {
        return getDefaultGpDisplayScalePercent();
    }

    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value)) {
        return getDefaultGpDisplayScalePercent();
    }

    return Math.min(150, Math.max(50, value));
}

export function setGpDisplayScale(percent) {
    const numeric = Number.parseInt(percent, 10);
    const safePercent = Number.isFinite(numeric)
        ? Math.min(150, Math.max(50, numeric))
        : getDefaultGpDisplayScalePercent();

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

// Note density: AlphaTab's display.stretchForce (1 is its default). Lower packs more bars on a row, higher spreads them.
export const GP_DENSITY_STEPS = { tight: 0.3, compact: 0.6, normal: 1, roomy: 1.5 };

export function getGpDensity() {
    let raw = null;
    try { raw = typeof localStorage !== 'undefined' ? localStorage.getItem('gpNoteDensity') : null; } catch { /* storage blocked */ }
    if (raw === 'ultra') return 'tight';
    if (raw && (raw === 'auto' || Object.hasOwn(GP_DENSITY_STEPS, raw))) return raw;
    return 'auto';
}

export function getEffectiveGpStretchForce(density = getGpDensity()) {
    if (density === 'ultra') density = 'tight';
    if (density === 'auto') {
        const isMobile = typeof window !== 'undefined' && window.innerWidth <= 576;
        return isMobile ? GP_DENSITY_STEPS.tight : GP_DENSITY_STEPS.normal;
    }
    const safe = Object.hasOwn(GP_DENSITY_STEPS, density) ? density : 'normal';
    return GP_DENSITY_STEPS[safe];
}

export let GP_STRETCH_FORCE = getEffectiveGpStretchForce();

export function setGpDensity(density) {
    if (density === 'ultra') density = 'tight';
    const safe = (density === 'auto' || Object.hasOwn(GP_DENSITY_STEPS, density)) ? density : 'auto';
    GP_STRETCH_FORCE = getEffectiveGpStretchForce(safe);
    try { localStorage.setItem('gpNoteDensity', safe); } catch { /* storage blocked */ }
    return safe;
}

export function applySavedGpDensity() {
    return setGpDensity(getGpDensity());
}

export function updateAutoGpDensity() {
    if (getGpDensity() !== 'auto') return false;
    const nextForce = getEffectiveGpStretchForce('auto');
    if (GP_STRETCH_FORCE !== nextForce) {
        GP_STRETCH_FORCE = nextForce;
        return true;
    }
    return false;
}

export const DEFAULT_GP_NOTATION_MODE = 'tab';

/** The notation for the open song: the temporary choice from View if there is one, otherwise the Settings default. */
export function getGpNotationMode() {
    const temporary = getNotationOverride();
    if (temporary === 'scoreTab' || temporary === 'tab') return temporary;
    return getDefaultGpNotationMode();
}

/** The saved default (Settings, Defaults). */
export function getDefaultGpNotationMode() {
    if (typeof localStorage === 'undefined') return DEFAULT_GP_NOTATION_MODE;
    const saved = localStorage.getItem('gpNotationMode');
    return saved === 'scoreTab' ? 'scoreTab' : DEFAULT_GP_NOTATION_MODE;
}

/** Saves the default. The reader's View menu changes the open song only (see sessionOverrides.js). */
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

// AlphaTab registers its music font ("alphaTab") with the first API created and keeps one shared checker polling until
// the browser reports the font loaded. We create a short-lived API first (loadGuitarPro) and destroy it at once, which
// removes the @font-face while that load is in flight; WebKit then never settles the load and the checker logs "Could
// not load font 'alphaTab'" every 5 seconds forever. Loading the font up front means the checker finds it already
// available. A failure or timeout here is harmless: AlphaTab loads the font itself as before.
let musicFontPromise = null;
function ensureMusicFont() {
    musicFontPromise ||= (async () => {
        try {
            if (typeof FontFace === 'undefined' || !document.fonts) return;
            const script = Array.from(document.scripts).find((el) => /alphaTab(\.min)?\.js/i.test(el.src));
            if (!script) return;
            const face = new FontFace('alphaTab', `url(${JSON.stringify(new URL('font/Bravura.woff2', script.src).href)}) format('woff2')`, {
                weight: 'normal',
                style: 'normal',
                display: 'block'
            });
            await Promise.race([face.load(), new Promise((resolve) => setTimeout(resolve, 3000))]);
            if (face.status === 'loaded') document.fonts.add(face);
        } catch (error) {
            console.warn('[GP] Could not preload the AlphaTab music font:', error);
        }
    })();
    return musicFontPromise;
}

export function loadGuitarPro(file, container, options) {
    return ensureMusicFont().then(() => loadGuitarProScore(file, container, options));
}

function loadGuitarProScore(file, container, { debug = false, originalFile = null } = {}) {
    const targetFile = originalFile || (file instanceof File ? file : null) || (window.gpState?.currentFile) || null;
    // A different song starts with no temporary overrides (notation, strings, guitar fit)
    if (targetFile) beginSong(targetFile);
    const soundHintsPromise = readGpSoundHints(originalFile || file);
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

        tempApi.scoreLoaded.on(async (score) => {
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

            const soundHints = await soundHintsPromise;

            // Step 3: dispose of temporary API
            tempApi.destroy();

            // Step 4: re-create API with filtered tracks and SoundFont synth / backing track player
            // Synth always means the synthesizer. A file's embedded audio is not one of the Original sources and
            // the switch that chose it is gone, so using the backing track here left it playing under Synth.
            const initialPlayerMode = alphaTab.PlayerMode.EnabledSynthesizer;

            if (getGpDensity() === 'auto') {
                GP_STRETCH_FORCE = getEffectiveGpStretchForce('auto');
            }

            // The AudioContext AlphaTab opens for the synth is tagged, so a closed or interrupted one is noticed on its own
            beginSynthContextCapture();
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
                display: { staveProfile: getGpStaveProfile(), layoutMode: alphaTab.LayoutMode.Page, scale: GP_DISPLAY_SCALE, stretchForce: GP_STRETCH_FORCE, padding: (typeof window !== 'undefined' && window.innerWidth <= 576) ? [4, 18, 4, 16] : [20, 20, 20, 20] },
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
                applyGpSoundHints(newScore, soundHints);
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
                // AlphaTab stacks one italic tuning line per track above the first system; on a phone that
                // pushes the first bar down by hundreds of pixels. The tuning stays in the Guitar panel.
                const isPhoneWidth = typeof window !== 'undefined' && window.innerWidth <= 576;
                newScore.stylesheet.globalDisplayTuning = !(isPhoneWidth && newScore.tracks.length > 1);
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
            api.postRenderFinished.on(() => fitTempoLabels(container));
            api.postRenderFinished.on(() => fitScoreText(container));

            // iPhone Duo tabletop: once the score has drawn, put the cursor's system at the top of the score half. The player
            // may not have taken the score yet on the first draw, so it is tried again a little later.
            let openedAtCursor = false;
            api.postRenderFinished.on(() => {
                if (openedAtCursor || !(document.documentElement.classList.contains('duo-tabletop') && !document.body.classList.contains('reading-mode'))) return;
                for (const delay of [80, 400, 1200]) {
                    setTimeout(() => {
                        if (openedAtCursor) return;
                        const output = document.getElementById('output');
                        if (!output || output.scrollTop > 0 || typeof window.__majesticUpdateContinuousPlaybackScroll !== 'function') return;
                        window.__majesticUpdateContinuousPlaybackScroll(api.tickPosition || 0, true, null, null, true);
                        if (output.scrollTop > 0) openedAtCursor = true;
                    }, delay);
                }
            });

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