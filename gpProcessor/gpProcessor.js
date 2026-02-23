// gpProcessor.js
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
                alert("Unable to load this Guitar Pro file. Ensure the tab is not locked.");
            } else {
                alert("AlphaTab error: " + (error.message));
            }

            tempApi.destroy();
            reject(error)
        });

        tempApi.scoreLoaded.on((score) => {
            if (debug) console.log("Tracks:", score.tracks);

            // Step 2: filter guitar tracks by MIDI program
            const guitarProgramWhitelist = [24, 25, 26, 27, 28, 29, 30, 31];
            const guitarTrackIndices = score.tracks
                .map((track, index) => ({ track, index }))
                .filter(ti => {
                    const program = ti.track.playbackInfo?.program ?? ti.track.program;
                    return guitarProgramWhitelist.includes(program);
                })
                .map(ti => ti.index);

            if (debug) {
                console.log("Guitar tracks found:", guitarTrackIndices.length);
                console.log("Guitar track indices:", guitarTrackIndices);
            }

            // Step 3: dispose of temporary API
            tempApi.destroy();

            // Step 4: re-create API with filtered tracks
            const api = new alphaTab.AlphaTabApi(container, {
                core: { file, tracks: guitarTrackIndices, enableLazyLoading: false },
                player: { enablePlayer: true },
                display: { staveProfile: "Tab", layoutMode: alphaTab.LayoutMode.Page },
                notation: {
                    hideEmptyStaves: true
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