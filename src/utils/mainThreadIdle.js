// Resolves once the main thread has stopped being busy: several consecutive short timers fire on time. Used to let
// score rendering and page layout finish before the loading card hides, so the user's first play doesn't run
// into that work (measured: up to ~1.4 s of stall in page mode). Always resolves; capped by maxMs.
export async function waitForMainThreadIdle({ stepMs = 50, lateMs = 25, quietSteps = 4, maxMs = 8000 } = {}) {
    const start = performance.now();
    let quiet = 0;
    while (quiet < quietSteps && performance.now() - start < maxMs) {
        const scheduled = performance.now();
        await new Promise((r) => setTimeout(r, stepMs));
        const late = performance.now() - scheduled - stepMs;
        quiet = late <= lateMs ? quiet + 1 : 0;
    }
}
