// gpProcessor.js
export function loadGuitarPro(file, container, { shrink = true, debug = false } = {}) {
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
                display: { staveProfile: "Tab", layoutMode: alphaTab.LayoutMode.Page }
            });

            api.postRenderFinished.on(() => {
                if (shrink || debug) {
                    container.querySelectorAll("svg").forEach(svg => processStaves(svg, debug, shrink));

                    if (shrink) {
                        // remove positional hardcoding from divs
                        container.querySelectorAll("div").forEach(div => {
                            div.style.position = "";
                            div.style.top = "";
                            div.style.left = "";
                            div.style.width = "";
                            div.style.height = "";
                            div.style.overflow = "";
                            div.style.display = "";
                            div.style.zIndex = "";
                            div.style.paddingBottom = "10px";
                        });
                    }

                    // debugging
                    if (debug) {
                        console.log("AlphaTab postRenderFinished fired");
                        console.log('Container height after render:', container.offsetHeight);
                    }
                    
                    //freezeAlphaTab(container.id);

                    resolve(api);
                }

                resolve(api);
            });
        });
    });
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

function processStaves(svg, debug = false, shrink = true) {
    const MIN_STAFF_HEIGHT = 40;
    const STAFF_GAP = 20;
    const PADDING = 2;

    // Helper: get vertical position of element
    const getY = (el) => {
        if (el.tagName === "rect" || el.tagName === "text") return parseFloat(el.getAttribute("y") || 0);
        if (el.tagName === "g" && el.hasAttribute("transform")) {
            const match = el.getAttribute("transform").match(/translate\(([\d.\-]+) ([\d.\-]+)\)/);
            if (match) return parseFloat(match[2]);
        }
        return null;
    };

    const getBBoxSafe = (el) => {
        try { return el.getBBox(); } catch { return { x: 0, y: 0, width: 0, height: 0 }; }
    };

    // --- Step 1: Collect y positions of staff elements ---
    const staffElements = Array.from(svg.querySelectorAll("rect, g.at"));
    const yPositions = staffElements.map(getY).filter(y => y !== null).sort((a, b) => a - b);

    // --- Step 2: Group y positions into staffs ---
    const staffs = [];
    let currentStaff = [];
    yPositions.forEach(y => {
        if (!currentStaff.length || y - currentStaff[currentStaff.length - 1] <= STAFF_GAP) {
            currentStaff.push(y);
        } else {
            const yMin = Math.min(...currentStaff), yMax = Math.max(...currentStaff);
            if (yMax - yMin >= MIN_STAFF_HEIGHT) staffs.push({ yMin, yMax });
            currentStaff = [y];
        }
    });
    if (currentStaff.length) {
        const yMin = Math.min(...currentStaff), yMax = Math.max(...currentStaff);
        if (yMax - yMin >= MIN_STAFF_HEIGHT) staffs.push({ yMin, yMax });
    }

    // --- Step 3: Wrap each staff ---
    let remainingElements = Array.from(svg.querySelectorAll("rect, g, text, path"))
        .filter(el => !el.classList?.contains("staff-wrapper") && el.parentNode === svg);

    const staffWrappers = [];

    staffs.forEach((staff, idx) => {
        const wrapper = document.createElementNS("http://www.w3.org/2000/svg", "g");
        wrapper.setAttribute("class", "staff-wrapper");
        wrapper.setAttribute("id", `staff-wrapper-${idx + 1}`);
        svg.appendChild(wrapper);

        const wrapperTop = staff.yMin - PADDING;
        const wrapperBottom = staff.yMax + PADDING;

        // Staff elements within bounds
        const staffEls = Array.from(svg.querySelectorAll("rect, g.at, text, path")).filter(el => {
            const yTop = getY(el);
            const yBottom = yTop + (el.getBBox?.().height || 0);
            return yTop !== null && yBottom >= wrapperTop && yTop <= wrapperBottom;
        });
        staffEls.forEach(el => wrapper.appendChild(el));

        // Other-elements within bounds
        const overlappingEls = remainingElements.filter(el => {
            const yTop = getY(el);
            const yBottom = yTop + (el.getBBox?.().height || 0);
            return yTop !== null && yBottom >= wrapperTop && yTop <= wrapperBottom;
        });
        if (overlappingEls.length) {
            const otherWrapper = document.createElementNS("http://www.w3.org/2000/svg", "g");
            otherWrapper.setAttribute("class", "other-elements");
            otherWrapper.setAttribute("id", `other-elements-${idx + 1}`);
            wrapper.appendChild(otherWrapper);
            overlappingEls.forEach(el => {
                otherWrapper.appendChild(el);
                remainingElements = remainingElements.filter(r => r !== el);
            });
        }

        // --- Determine if staff has notes ---
        const noteTexts = Array.from(wrapper.querySelectorAll("text")).filter(t => {
            const y = getY(t);
            return y !== null && !t.closest("g.other-elements") && y >= wrapperTop && y <= wrapperBottom && /\d/.test(t.textContent);
        });
        const notePaths = Array.from(wrapper.querySelectorAll("path")).filter(p => {
            const y = getY(p);
            return y !== null && !p.closest("g.other-elements") && y + (p.getBBox?.().height || 0) >= wrapperTop && y <= wrapperBottom;
        });
        const hasNotes = noteTexts.length > 0 || notePaths.length > 0;

        // --- Debug overlay: red/green ---
        if (debug) {
            const bbox = getBBoxSafe(wrapper);
            const overlay = document.createElementNS("http://www.w3.org/2000/svg", "rect");
            overlay.setAttribute("x", bbox.x);
            overlay.setAttribute("y", wrapperTop);
            overlay.setAttribute("width", bbox.width);
            overlay.setAttribute("height", wrapperBottom - wrapperTop);
            overlay.setAttribute("fill", hasNotes ? "rgba(0,255,0,0.2)" : "rgba(255,0,0,0.3)");
            overlay.setAttribute("stroke", "none");
            wrapper.insertBefore(overlay, wrapper.firstChild);
        }

        wrapper.dataset.hasNotes = hasNotes ? "true" : "false";
        staffWrappers.push(wrapper);
    });

    // --- Step 4: Global other-elements ---
    let globalOtherWrapper = null;
    if (remainingElements.length) {
        globalOtherWrapper = document.createElementNS("http://www.w3.org/2000/svg", "g");
        globalOtherWrapper.setAttribute("class", "other-elements");
        globalOtherWrapper.setAttribute("id", "other-elements-global");
        svg.appendChild(globalOtherWrapper);
        remainingElements.forEach(el => globalOtherWrapper.appendChild(el));

        if (debug) {
            const bbox = getBBoxSafe(globalOtherWrapper);
            const overlay = document.createElementNS("http://www.w3.org/2000/svg", "rect");
            overlay.setAttribute("x", bbox.x);
            overlay.setAttribute("y", bbox.y);
            overlay.setAttribute("width", bbox.width);
            overlay.setAttribute("height", bbox.height);
            overlay.setAttribute("fill", "none");
            overlay.setAttribute("stroke", "orange");
            overlay.setAttribute("stroke-width", "2");
            svg.appendChild(overlay);
        }
    }

    // --- Step 5: Purple wrappers around contiguous green staffs + orange ---
    let currentBlockTop = null;
    let currentBlockBottom = null;
    let currentPurpleWrapper = null;

    staffWrappers.forEach((wrapper, idx) => {
        const hasNotes = wrapper.dataset.hasNotes === "true";
        const bbox = getBBoxSafe(wrapper);

        if (hasNotes) {
            if (!currentPurpleWrapper) {
                currentPurpleWrapper = document.createElementNS("http://www.w3.org/2000/svg", "g");
                currentPurpleWrapper.setAttribute("class", "kept-wrapper");
                svg.appendChild(currentPurpleWrapper);
                currentBlockTop = bbox.y;
            }

            // Update bottom of current block
            let blockBottom = bbox.y + bbox.height;
            const otherWrapper = wrapper.querySelector("g.other-elements");
            if (otherWrapper) blockBottom = Math.max(blockBottom, otherWrapper.getBBox().y + otherWrapper.getBBox().height);
            currentBlockBottom = currentPurpleWrapper.dataset.blockBottom ? Math.max(currentBlockBottom, blockBottom) : blockBottom;

            // Move wrapper + other-elements into purple wrapper
            currentPurpleWrapper.appendChild(wrapper);
            const ow = wrapper.querySelector("g.other-elements");
            if (ow) currentPurpleWrapper.appendChild(ow);

            // Check next staff: if red or end of list → finalize purple wrapper
            const nextWrapper = staffWrappers[idx + 1];
            const nextIsRed = nextWrapper && nextWrapper.dataset.hasNotes === "false";
            if (!nextWrapper || nextIsRed) {
                if (debug) {
                    const overlay = document.createElementNS("http://www.w3.org/2000/svg", "rect");
                    overlay.setAttribute("x", 0);
                    overlay.setAttribute("y", currentBlockTop);
                    overlay.setAttribute("width", svg.viewBox.baseVal.width || svg.clientWidth);
                    overlay.setAttribute("height", currentBlockBottom - currentBlockTop);
                    overlay.setAttribute("fill", "none");
                    overlay.setAttribute("stroke", "purple");
                    overlay.setAttribute("stroke-width", "2");
                    svg.appendChild(overlay);
                }
                currentPurpleWrapper.dataset.blockBottom = currentBlockBottom;
                currentPurpleWrapper = null;
                currentBlockTop = null;
                currentBlockBottom = null;
            }
        }
    });

    // --- Step 6: Shrink mode ---
    if (!debug) {
        // Gather all elements inside purple wrappers
        const purpleWrappers = Array.from(svg.querySelectorAll("g.kept-wrapper"));
        const keptElements = new Set();
        purpleWrappers.forEach(pw => {
            Array.from(pw.querySelectorAll("*")).forEach(el => keptElements.add(el));
        });

        // Remove all top-level staff-wrappers and other-elements not inside purple wrappers
        Array.from(svg.querySelectorAll("g.staff-wrapper, g.other-elements")).forEach(wrapper => {
            if (!keptElements.has(wrapper) && !wrapper.closest("g.kept-wrapper")) {
                wrapper.remove();
            }
        });

        // Remove all overlay rects (debug artifacts)
        Array.from(svg.querySelectorAll("rect")).forEach(rect => {
            if (rect.getAttribute("fill")?.includes("rgba") || rect.getAttribute("stroke") === "purple") {
                rect.remove();
            }
        });

        // Flatten purple wrappers: move their children up to svg
        purpleWrappers.forEach(pw => {
            while (pw.firstChild) {
                svg.appendChild(pw.firstChild);
            }
            pw.remove();
        });

        
        // --- Final Step: Clamp SVG vertically ---
        const allContent = Array.from(svg.querySelectorAll("*")).filter(el => el.getBBox);
        if (allContent.length) {
            let minY = Infinity, maxY = -Infinity;
            allContent.forEach(el => {
                const bb = getBBoxSafe(el);
                if (bb.height === 0) return;
                minY = Math.min(minY, bb.y);
                maxY = Math.max(maxY, bb.y + bb.height);
            });

            if (minY !== Infinity) {
                const width = svg.viewBox.baseVal.width || svg.clientWidth;
                const height = maxY - minY;
                const minX = svg.viewBox.baseVal.x || 0;
                svg.setAttribute("viewBox", `${minX} ${minY} ${width} ${height}`);
                svg.setAttribute("height", height);
            }
        }
        
    }
    
}
