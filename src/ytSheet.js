// ytSheet.js
// The video sheet: where the YouTube player lives while Original plays from YouTube.
//
// The player must be on the screen the person is looking at while it plays (YouTube's developer policies forbid
// a background player, and its player docs set a 200 x 200 minimum viewport). So the player is not inside a panel
// that other panels close: it has its own sheet, which opens when YouTube starts playing and stays until the
// person closes it (closing pauses), picks the Synth, or leaves the song.
//
// The one thing a person can do is swipe the sheet down (or press its grabber) to a peek: the sheet is pushed down so
// the top slice of the video (its title and the YouTube mark) stays on the screen, over the page.
// That is always the person's own gesture; nothing in the app (a timer, a playback event, another panel) shrinks it.
// The player keeps its full size inside the clip, so the embed's own viewport is never smaller than it needs.
//
// Layout (top to bottom): the grabber row, then the video. The whole sheet moves down by --yt-d (how far it is
// lowered) and is clipped by the same amount at the bottom, where it would pass over the strip. The sheet overlaps the
// page; it never makes the page reflow. Nothing of ours is drawn over the player.

const PEEK_VIDEO_PX = 56; // the top slice of the video that stays visible in the peek
const SNAP_RATIO = 0.4; // dragged past this share of the travel, the sheet snaps the other way

let state = 'hidden'; // 'hidden' | 'open' | 'peek'
let hooks = { onClose: () => {}, onReaderShown: () => {} };
let userPeek = false; // the person lowered it: later plays in this song respect that until the video changes
let dragging = false;
const listeners = new Set();

const $ = (id) => document.getElementById(id);

export const onSheetChange = (cb) => { listeners.add(cb); return () => listeners.delete(cb); };
const moveListeners = new Set();
const startListeners = new Set();
/** Called when a move or fade begins (not only when it ends), so the native player can follow it from the first frame. */
export const onSheetTransition = (cb) => { startListeners.add(cb); return () => startListeners.delete(cb); };
/** Called on every frame of a drag, so the native player (which draws above the page) follows the finger. */
export const onSheetMove = (cb) => { moveListeners.add(cb); return () => moveListeners.delete(cb); };
export const getSheetState = () => state;
/** True while the video is on the screen (open or peeking). Native players use this to decide whether to show. */
export const isVideoShown = () => state !== 'hidden';

function syncSwitch() {
    document.querySelectorAll('[data-yt-show]').forEach((b) => {
        const on = (b.dataset.ytShow === 'fretboard') === (state === 'peek');
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
}

function emit() {
    syncSwitch();
    listeners.forEach((cb) => { try { cb(state); } catch (e) { console.error('[ytSheet]', e); } });
}

/**
 * The player is kept at YouTube's minimum viewport, 200 x 200, as a 16:9 player: 356 x 200 (see --yt-w in design.css).
 * No layout makes it wider. YouTube gives no way to learn a video's real shape, so it is not matched to the content.
 */
function videoHeight() {
    return 200;
}

function metrics() {
    const sheet = $('ytSheet');
    if (!sheet) return null;
    const h = videoHeight();
    return { sheet, h, travel: Math.max(0, h - PEEK_VIDEO_PX) };
}

/** Sets the lowered distance (px), the video height, and publishes the height the sheet takes from the score. */
function apply(d, { animate = true } = {}) {
    const m = metrics();
    if (!m) return;
    const { sheet, h } = m;
    sheet.style.setProperty('--yt-h', `${h}px`);
    sheet.classList.toggle('is-dragging', !animate);
    sheet.style.setProperty('--yt-d', `${Math.round(d)}px`);
    const list = animate ? startListeners : moveListeners;
    list.forEach((cb) => { try { cb(); } catch (e) { console.error('[ytSheet]', e); } });
}

function publishHeight() {
    const root = document.documentElement.style;
    const sheet = $('ytSheet');
    if (state === 'hidden' || !sheet) {
        root.setProperty('--yt-sheet-h', '0px');
        root.setProperty('--yt-sheet-w', '0px');
        document.body.classList.remove('yt-sheet-open');
        return;
    }
    const m = metrics();
    const d = state === 'peek' ? m.travel : 0;
    const grab = $('ytSheetGrab')?.offsetHeight || 0;
    root.setProperty('--yt-sheet-h', `${grab + (m.h - d)}px`);
    root.setProperty('--yt-sheet-w', `${sheet.offsetWidth}px`);
    document.body.classList.add('yt-sheet-open');
    document.body.classList.toggle('yt-sheet-peek', state === 'peek');
}

function settle() {
    publishHeight(); // panels end above the sheet; the page itself does not move
    emit();
}

function setState(next) {
    if (next === state) return;
    const sheet = $('ytSheet');
    if (!sheet) return;
    const prev = state;
    state = next;
    sheet.dataset.state = next;
    const grab = $('ytSheetGrab');
    if (next === 'hidden') {
        sheet.setAttribute('inert', '');
        sheet.classList.remove('is-shown');
        grab?.setAttribute('aria-expanded', 'false');
        publishHeight();
        emit();
        return;
    }
    sheet.removeAttribute('inert');
    const m = metrics();
    grab?.setAttribute('aria-expanded', next === 'open' ? 'true' : 'false');
    grab?.setAttribute('aria-label', next === 'open' ? 'Video, shown. Press to lower it' : 'Video, lowered. Press to raise it');
    if (prev === 'hidden') {
        // Enter: the sheet is placed at its state first, then fades and rises in (transform and opacity).
        apply(next === 'peek' ? m.travel : 0, { animate: false });
        sheet.classList.add('is-shown');
    } else {
        apply(next === 'peek' ? m.travel : 0);
    }
    // Publish the height once the sheet has settled; reduced motion and a first show have no travel to wait for.
    const wait = prev === 'hidden' || matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 260;
    setTimeout(settle, wait);
    publishHeight();
}

/** The sheet opens when YouTube starts playing. It comes back lowered only if the person lowered it for this video. */
export function showSheet() {
    if (state !== 'hidden') return;
    setState(userPeek ? 'peek' : 'open');
}

/** Lower (peek) or raise the sheet. Only the person's gesture or a press on the grabber calls this. */
export function setPeek(peek) {
    if (state === 'hidden') return;
    userPeek = peek;
    setState(peek ? 'peek' : 'open');
}

/** A new video or a new song opens the sheet fully again. */
export function resetPeek() {
    userPeek = false;
    if (state === 'peek') setState('open');
}

/** Close the sheet. The video is paused first by the hook, since a player that is not shown must not play. */
export function closeSheet() {
    if (state === 'hidden') return;
    hooks.onClose();
    setState('hidden');
}

export function initYtSheet({ onClose, onReaderShown } = {}) {
    if (onClose) hooks.onClose = onClose;
    if (onReaderShown) hooks.onReaderShown = onReaderShown;
    // The library has no reader chrome: going back to it closes the video (which pauses), and coming back to the reader
    // with Original selected shows it again.
    let inLibrary = document.body.classList.contains('library-view-active');
    new MutationObserver(() => {
        const now = document.body.classList.contains('library-view-active');
        if (now === inLibrary) return;
        inLibrary = now;
        if (now) closeSheet(); else hooks.onReaderShown();
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    const sheet = $('ytSheet');
    const grab = $('ytSheetGrab');
    if (!sheet || !grab) return;
    sheet.setAttribute('inert', '');

    // Tabletop: Video | Fretboard. The fretboard is the person's choice; it leaves the video as the peek.
    document.querySelectorAll('[data-yt-show]').forEach((b) => b.addEventListener('click', () => setPeek(b.dataset.ytShow === 'fretboard')));

    // A press (no drag) toggles; a drag follows the finger and snaps on release.
    let startY = 0;
    let startD = 0;
    let moved = false;
    let pid = null;
    grab.addEventListener('pointerdown', (e) => {
        if (state === 'hidden' || e.button > 0) return;
        const m = metrics();
        if (!m) return;
        pid = e.pointerId;
        startY = e.clientY;
        startD = state === 'peek' ? m.travel : 0;
        moved = false;
        dragging = true;
        grab.setPointerCapture?.(pid);
    });
    grab.addEventListener('pointermove', (e) => {
        if (!dragging || e.pointerId !== pid) return;
        const m = metrics();
        const dy = e.clientY - startY;
        if (!moved && Math.abs(dy) < 6) return; // a threshold keeps a tap a tap
        moved = true;
        apply(Math.max(0, Math.min(m.travel, startD + dy)), { animate: false });
    });
    const end = (e) => {
        if (!dragging || e.pointerId !== pid) return;
        dragging = false;
        grab.releasePointerCapture?.(pid);
        const m = metrics();
        if (!moved) { setPeek(state !== 'peek'); return; }
        const cur = parseFloat(sheet.style.getPropertyValue('--yt-d')) || 0;
        const wasPeek = state === 'peek';
        const crossed = wasPeek ? (m.travel - cur) > m.travel * SNAP_RATIO : cur > m.travel * SNAP_RATIO;
        const peek = wasPeek ? !crossed : crossed;
        userPeek = peek;
        sheet.classList.remove('is-dragging');
        if (peek === wasPeek) apply(peek ? m.travel : 0); else setState(peek ? 'peek' : 'open');
    };
    grab.addEventListener('pointerup', end);
    grab.addEventListener('pointercancel', end);
    grab.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setPeek(true); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setPeek(false); }
    });
    // Enter and Space press the button, which toggles (the click is the keyboard path; a pointer press handled above
    // would also fire a click, so the click handler ignores pointer-initiated ones).
    grab.addEventListener('click', (e) => { if (e.detail === 0) setPeek(state !== 'peek'); });

    // The width changes the video's height: keep the clip and the published height right.
    if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(() => {
            if (state === 'hidden' || dragging) return;
            const m = metrics();
            apply(state === 'peek' ? m.travel : 0, { animate: false });
            publishHeight();
            emit();
        }).observe(sheet);
    }
}

/**
 * Where the video is on the screen, for the native player. `rect` is the visible slice of the video; `fullHeight`
 * is the height the player keeps inside it (it is the slice's height when nothing is lowered).
 */
export function visibleVideoRect() {
    const wrap = $('ytPlayerWrapper');
    const sheet = $('ytSheet');
    if (!wrap || !sheet || state === 'hidden') return null;
    const r = wrap.getBoundingClientRect();
    // How far the sheet is pushed down right now (mid-transition included), from its real transform and not the target
    const d = Math.max(0, new DOMMatrix(getComputedStyle(sheet).transform).m42 || 0);
    // The sheet is pushed down by d, so the wrapper's own rect already sits where the top slice shows
    return { left: r.left, top: r.top, width: r.width, height: Math.max(0, r.height - d), fullHeight: r.height };
}
