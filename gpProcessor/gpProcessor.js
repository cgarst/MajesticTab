// gpVisible.js
export function loadGuitarPro(file, container, { shrink = true, debug = false } = {}) {
    return new Promise((resolve, reject) => {
        if (!container) {
            reject(new Error("Container element is required"));
            return;
        }

        // Step 1: temporary instance to read the score
        const tempApi = new alphaTab.AlphaTabApi(container, {
            core: { file, enableLazyLoading: false },
            display: { staveProfile: "tab" }
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
                display: { staveProfile: "Tab", layoutMode: alphaTab.LayoutMode.Page }
            });

            api.postRenderFinished.on(() => {
                if (shrink) {
                    container.querySelectorAll("svg").forEach(svg => removeEmptyStaffs(svg, debug));

                    // clean div layout
                    container.querySelectorAll("div").forEach(div => {
                        div.style.position = "";
                        div.style.top = "";
                        div.style.left = "";
                        div.style.width = "";
                        div.style.height = "";
                        div.style.overflow = "";
                        div.style.display = "";
                        div.style.zIndex = "1";
                        div.style.paddingBottom = "10px";
                    });

                    //freezeAlphaTab(container.id);

                    // remove tiny 1x1 dots
                    container.querySelectorAll("path").forEach(path => {
                        const d = path.getAttribute("d");
                        if (d && d.includes("A1,1")) path.remove();
                    });

                    // final cleanup
                    container.querySelectorAll("svg").forEach(svg => removeEmptyStaffs(svg, debug));

                    // debugging
                    console.log("AlphaTab postRenderFinished fired");
                    console.log('Container height after render:', container.offsetHeight);

                    resolve(api); // keep the Promise resolving
                }

                resolve(api);
            });
        });
    });
}

// --- keep your removeEmptyStaffs and freezeAlphaTab helpers ---
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

function freezeAlphaTab(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const rect = container.getBoundingClientRect();
    let blocker = document.getElementById("alphaTabBlocker");
    if (!blocker) {
        blocker = document.createElement("div");
        blocker.id = "alphaTabBlocker";
        blocker.style.position = "absolute";
        blocker.style.top = rect.top + "px";
        blocker.style.left = rect.left + "px";
        blocker.style.width = rect.width + "px";
        blocker.style.height = "100%";
        blocker.style.zIndex = "999";
        blocker.style.background = "transparent";
        document.body.appendChild(blocker);
    }
}
