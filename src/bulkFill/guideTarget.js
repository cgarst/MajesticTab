// guideTarget.js
// The song the "Fill in missing tabs" walkthrough is waiting for a tab for. While it waits, a tab file the user hands to
// the app by any route (open with from the browser's download, a drop, the Open file page) is added to that song instead
// of opening in the reader. Nothing is claimed unless the walkthrough has said it is waiting.

let waiting = null; // { accept(file): Promise<boolean> }

/** Starts claiming files for the song, or stops when given null. `accept` resolves true when it took the file. */
export function setGuideTarget(target) {
    waiting = target;
}

export function hasGuideTarget() {
    return Boolean(waiting);
}

/** True when the walkthrough took the file, so the caller must not open it. */
export async function claimForGuide(file) {
    if (!waiting || !file) return false;
    try { return (await waiting.accept(file)) === true; } catch { return false; }
}
