// foldState.js
// The fold of a foldable iPhone (the iPhone Duo), as the layout needs it. WKWebView does not expose Device Posture or
// Viewport Segments, so the native side (build/tauri/plugins/ios-fold) reads the division region and the hinge and
// sends them here. Nothing else in the app should ask the platform about the fold.
//
// Poses: 'none' (no fold, or not iOS), 'flat' (a fold that is not folded), 'tabletop' (crease across: content on the
// top half, controls on the bottom half) and 'book' (crease up and down: one page per half).
//
// The pose is applied once the fold has stopped moving (SETTLE_MS), not on every hinge update: re-laying out the score
// for every degree of the hinge would thrash AlphaTab and make the page jump while the player is still folding.
// Applying sets, on <html>:
//   class  duo-tabletop | duo-book
//   --fold-top / --fold-h   (tabletop) where the crease starts from the top, and how tall it is
//   --fold-left / --fold-w  (book)     where the crease starts from the left, and how wide it is
// and fires 'foldchange' on window with { pose, x, y, w, h }.
//
// Developing without the device: add ?fold=tabletop or ?fold=book to the page URL (optional fold_size=<px>, default
// 28). It centres the crease in the window and follows the window size, so the layout can be driven in a plain browser.

const SETTLE_MS = 300;
const DEFAULT_DEV_FOLD = 28;
const MIN_FOLDED_SIDE = 600; // a crease can only be a tabletop or a book on a display this wide

const tauri = () => (typeof window !== 'undefined' ? window.__TAURI__ : undefined);

let applied = { pose: 'none', x: 0, y: 0, w: 0, h: 0 };
let pending = null;
let settleTimer = 0;
let started = false;
let devPose = null;
let devSize = DEFAULT_DEV_FOLD;

export function getFold() {
    return { ...applied };
}
export function isTabletop() {
    return applied.pose === 'tabletop';
}
export function isBook() {
    return applied.pose === 'book';
}

function apply(next) {
    if (next.pose === applied.pose && next.x === applied.x && next.y === applied.y && next.w === applied.w && next.h === applied.h) return;
    applied = next;
    const root = document.documentElement;
    root.classList.toggle('duo-tabletop', next.pose === 'tabletop');
    root.classList.toggle('duo-book', next.pose === 'book');
    root.dataset.foldPose = next.pose;
    if (next.pose === 'tabletop') {
        root.style.setProperty('--fold-top', `${next.y}px`);
        root.style.setProperty('--fold-h', `${next.h}px`);
        root.style.removeProperty('--fold-left');
        root.style.removeProperty('--fold-w');
    } else if (next.pose === 'book') {
        root.style.setProperty('--fold-left', `${next.x}px`);
        root.style.setProperty('--fold-w', `${next.w}px`);
        root.style.removeProperty('--fold-top');
        root.style.removeProperty('--fold-h');
    } else {
        for (const name of ['--fold-top', '--fold-h', '--fold-left', '--fold-w']) root.style.removeProperty(name);
    }
    window.dispatchEvent(new CustomEvent('foldchange', { detail: { ...next } }));
    // One deliberate refit: the score area just changed size, and AlphaTab and the page layout measure on 'resize'
    requestAnimationFrame(() => requestAnimationFrame(() => window.dispatchEvent(new Event('resize'))));
}

// A change is held until the fold has stopped for SETTLE_MS; going back to an unfolded pose applies the same way
function schedule(next) {
    pending = next;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
        const value = pending;
        pending = null;
        if (value) apply(value);
    }, SETTLE_MS);
}

function fromNative(msg) {
    if (!msg || msg.type !== 'fold') return;
    const winW = Number(msg.winW);
    const winH = Number(msg.winH);
    let pose = msg.pose;
    if ((pose === 'tabletop' || pose === 'book') && Math.min(winW, winH) < MIN_FOLDED_SIDE) pose = 'flat';
    schedule({ pose, x: Number(msg.x), y: Number(msg.y), w: Number(msg.w), h: Number(msg.h) });
}

function fromDev() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (devPose === 'tabletop') {
        schedule({ pose: 'tabletop', x: 0, y: Math.round((h - devSize) / 2), w, h: devSize });
    } else {
        schedule({ pose: 'book', x: Math.round((w - devSize) / 2), y: 0, w: devSize, h });
    }
}

export async function initFoldState() {
    if (started) return;
    started = true;
    const params = new URLSearchParams(window.location.search);
    const dev = params.get('fold');
    if (dev === 'tabletop' || dev === 'book') {
        devPose = dev;
        const size = Number(params.get('fold_size'));
        if (size > 0 && size < 200) devSize = size;
        window.addEventListener('resize', fromDev);
        fromDev();
        return;
    }
    try {
        if (!tauri()?.core?.Channel) return;
        const channel = new (tauri().core.Channel)();
        channel.onmessage = fromNative;
        await tauri().core.invoke('plugin:ios-fold|start', { onEvent: channel });
    } catch (_) {
        // Not the iOS app, or the plugin is missing: the normal layout stays
    }
}
