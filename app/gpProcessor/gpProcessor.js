import { applyGpScoreTransforms } from '../fileAdapters.js';
import { showToast } from '../utils/toast.js';
import {
    getInstrumentMode,
    getGuitarTracks,
    getBassTracks,
    getActiveInstrumentTracks,
    GUITAR_PROGRAM_WHITELIST,
    BASS_PROGRAM_WHITELIST
} from '../utils/tuningUtils.js';

export {
    getGuitarTracks,
    getBassTracks,
    getActiveInstrumentTracks,
    GUITAR_PROGRAM_WHITELIST,
    BASS_PROGRAM_WHITELIST
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

export function loadGuitarPro(file, container, { debug = false } = {}) {
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
            const activeTrackIndices = activeTracks.map(ti => ti.index);

            if (debug) {
                console.log(`[GP] Active tracks (${getInstrumentMode()} mode) found:`, activeTrackIndices.length);
                console.log("[GP] Active track indices:", activeTrackIndices);
            }

            // Step 3: dispose of temporary API
            tempApi.destroy();

            // Step 4: re-create API with filtered tracks and SoundFont synth player
            const api = new alphaTab.AlphaTabApi(container, {
                core: { file, tracks: activeTrackIndices, enableLazyLoading: false },
                player: {
                    enablePlayer: true,
                    playerMode: alphaTab.PlayerMode.EnabledSynthesizer,
                    soundFont: 'https://cdn.jsdelivr.net/npm/@coderline/alphatab@1.8.4/dist/soundfont/sonivox.sf2',
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

            // Set stylesheet properties on the new score
            api.scoreLoaded.on((newScore) => {
                applyGpScoreTransforms(newScore);
                newScore.stylesheet.hideEmptyStaves = true;
                newScore.stylesheet.hideEmptyStavesInFirstSystem = true;
                newScore.stylesheet.globalDisplayTuning = true;

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