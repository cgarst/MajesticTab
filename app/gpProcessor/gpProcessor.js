// gpProcessor.js
import { applyGpScoreTransforms } from '../fileAdapters.js';
import { showToast } from '../utils/toast.js';

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

export function loadGuitarPro(file, container, { debug = false } = {}) {
    return new Promise((resolve, reject) => {
        if (!container) {
            reject(new Error("Container element is required"));
            return;
        }

        // Create AlphaTab API
        const tempApi = new alphaTab.AlphaTabApi(container, {
            core: { file, enableLazyLoading: false },
            display: { staveProfile: "tab" }
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

            // Step 2: filter guitar tracks by MIDI program
            const guitarProgramWhitelist = [24, 25, 26, 27, 28, 29, 30, 31];
            const guitarTrackIndices = score.tracks
                .map((track, index) => ({ track, index }))
                .filter(ti => {
                    const isPercussion = ti.track.isPercussion
                        || ti.track.playbackInfo?.isPercussion
                        || ti.track.staves?.some(staff => staff.isPercussion);
                    const program = ti.track.playbackInfo?.program ?? ti.track.program;
                    return !isPercussion && guitarProgramWhitelist.includes(program);
                })
                .map(ti => ti.index);

            if (debug) {
                console.log("Guitar tracks found:", guitarTrackIndices.length);
                console.log("Guitar track indices:", guitarTrackIndices);
            }

            // Step 3: dispose of temporary API
            tempApi.destroy();

            // Step 4: re-create API with filtered tracks and SoundFont synth player
            const api = new alphaTab.AlphaTabApi(container, {
                core: { file, tracks: guitarTrackIndices, enableLazyLoading: false },
                player: {
                    enablePlayer: true,
                    playerMode: alphaTab.PlayerMode.EnabledSynthesizer,
                    soundFont: 'https://cdn.jsdelivr.net/npm/@coderline/alphatab@1.8.4/dist/soundfont/sonivox.sf2',
                    enableCursor: true,
                    enableElementHighlighting: true,
                    scrollMode: alphaTab.ScrollMode.Off
                },
                display: { staveProfile: "Tab", layoutMode: alphaTab.LayoutMode.Page, scale: GP_DISPLAY_SCALE },
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