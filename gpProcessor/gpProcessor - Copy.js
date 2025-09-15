// gpProcessor.js
export async function gpProcessor(file, options = {}) {
    const { shrink = true, debug = false } = options;

    return new Promise((resolve, reject) => {
        // Create a hidden container
        const container = document.createElement("div");
        container.style.position = "absolute";
        container.style.width = "1024px";
        container.style.height = "0";
        container.style.overflow = "hidden";
        document.body.appendChild(container);

        // Step 1: Temporary instance to read the score
        const tempApi = new alphaTab.AlphaTabApi(container, {
            core: { file: file, enableLazyLoading: false },
            display: { staveProfile: 'tab' }
        });

        tempApi.scoreLoaded.on((score) => {
            if (debug) console.log("Tracks: ", score.tracks);

            // Step 2: Filter guitar tracks by MIDI program
            const guitarProgramWhitelist = [24, 25, 26, 27, 28, 29, 30, 31];
            const guitarTrackIndices = score.tracks
                .map((track, index) => ({ track, index }))
                .filter(ti => {
                    const program = ti.track.playbackInfo?.program ?? ti.track.program;
                    return guitarProgramWhitelist.includes(program);
                })
                .map(ti => ti.index);

            if (debug) console.log("Guitar tracks found:", guitarTrackIndices.length);

            // Step 3: Dispose of temporary API
            tempApi.destroy();

            // Step 4: Re-create API instance with filtered tracks
            const api = new alphaTab.AlphaTabApi(container, {
                core: {
                    file: file,
                    tracks: guitarTrackIndices,
                    enableLazyLoading: false
                },
                player: { enablePlayer: false },
                display: { staveProfile: 'Tab', layoutMode: alphaTab.LayoutMode.Page }
            });

            api.postRenderFinished.on(() => {
                if (shrink) {
                    document.querySelectorAll("svg").forEach(svg => removeEmptyStaffs(svg, debug));
                }

                const svgs = Array.from(container.querySelectorAll("svg"));

                // Cleanup
                container.remove();

                resolve(svgs);
            });
        });
        
    });
}


// --- Utilities ---

function removeEmptyStaffs(svg, debug = false) {
    const MIN_STAFF_HEIGHT = 40;

    const elements = Array.from(svg.querySelectorAll("rect, g.at"));
    let yPositions = [];
    elements.forEach(el => {
        let y = null;
        if (el.tagName === "rect") y = parseFloat(el.getAttribute("y"));
        if (el.tagName === "g" && el.hasAttribute("transform")) {
            const match = el.getAttribute("transform").match(/translate\(([\d.\-]+) ([\d.\-]+)\)/);
            if (match) y = parseFloat(match[2]);
        }
        if (y !== null) yPositions.push(y);
    });

    yPositions.sort((a,b)=>a-b);
    const staffGap = 20;
    let staffs = [], currentStaff = [];
    yPositions.forEach(y => {
        if (!currentStaff.length || y - currentStaff[currentStaff.length-1] <= staffGap) {
            currentStaff.push(y);
        } else {
            const yMin = Math.min(...currentStaff), yMax = Math.max(...currentStaff);
            if (yMax - yMin >= MIN_STAFF_HEIGHT) staffs.push({yMin, yMax});
            currentStaff = [y];
        }
    });
    if (currentStaff.length) {
        const yMin = Math.min(...currentStaff), yMax = Math.max(...currentStaff);
        if (yMax - yMin >= MIN_STAFF_HEIGHT) staffs.push({yMin, yMax});
    }

    const emptyStaffs = staffs.filter(staff => {
        const textsInStaff = Array.from(svg.querySelectorAll("text")).filter(t => {
            const y = parseFloat(t.getAttribute("y")||0);
            return y >= staff.yMin && y <= staff.yMax;
        });
        return !textsInStaff.some(t => /\d/.test(t.textContent));
    });

    emptyStaffs.forEach(staff => {
        const elementsToRemove = Array.from(svg.querySelectorAll("rect, g, path, text")).filter(el => {
            let y = null;
            if (el.tagName === "rect" || el.tagName === "text") y = parseFloat(el.getAttribute("y")||0);
            if (el.tagName === "g" && el.hasAttribute("transform")) {
                const match = el.getAttribute("transform").match(/translate\(([\d.\-]+) ([\d.\-]+)\)/);
                if (match) y = parseFloat(match[2]);
            }
            return y !== null && y >= staff.yMin && y <= staff.yMax;
        });

        if (!elementsToRemove.length) return;

        const heightToShift = Math.max(...elementsToRemove.map(el => {
            if (el.tagName === "rect") return parseFloat(el.getAttribute("y")) + parseFloat(el.getAttribute("height")||0);
            if (el.tagName === "g") {
                const match = el.getAttribute("transform").match(/translate\(([\d.\-]+) ([\d.\-]+)\)/);
                if (match) return parseFloat(match[2]);
            }
            return 0;
        })) - staff.yMin;

        if (debug) {
            elementsToRemove.forEach(el => {
                if (el.tagName === "rect") {
                    el.setAttribute("stroke", "red");
                    el.setAttribute("stroke-width", "2");
                    el.setAttribute("fill", "rgba(255,0,0,0.1)");
                } else {
                    el.style.outline = "2px solid red";
                }
            });
        } else {
            elementsToRemove.forEach(el => el.remove());
        }

        Array.from(svg.querySelectorAll("rect, text, g, path")).forEach(el => {
            let y = null;
            if (el.tagName === "rect" || el.tagName === "text") y = parseFloat(el.getAttribute("y")||0);
            if (el.tagName === "g" && el.hasAttribute("transform")) {
                const match = el.getAttribute("transform").match(/translate\(([\d.\-]+) ([\d.\-]+)\)/);
                if (match) y = parseFloat(match[2]);
            }
            if (y !== null && y > staff.yMax) {
                if (el.tagName === "rect" || el.tagName === "text") el.setAttribute("y", y - heightToShift);
                else if (el.tagName === "g") {
                    const match = el.getAttribute("transform").match(/translate\(([\d.\-]+) ([\d.\-]+)\)/);
                    if (match) {
                        const x = parseFloat(match[1]), newY = parseFloat(match[2]) - heightToShift;
                        el.setAttribute("transform", `translate(${x} ${newY})`);
                    }
                }
            }
        });
    });

    let maxY = 0;
    Array.from(svg.querySelectorAll("rect, text, g")).forEach(el => {
        let y=0, h=0;
        if(el.tagName==="rect"){y=parseFloat(el.getAttribute("y")); h=parseFloat(el.getAttribute("height")||0);}
        else if(el.tagName==="text") y=parseFloat(el.getAttribute("y"));
        else if(el.tagName==="g" && el.hasAttribute("transform")) {
            const match=el.getAttribute("transform").match(/translate\(([\d.\-]+) ([\d.\-]+)\)/);
            if(match) y=parseFloat(match[2]);
        }
        if(y+h>maxY) maxY=y+h;
    });
    svg.setAttribute("height", maxY);
}
