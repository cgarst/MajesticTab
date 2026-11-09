// pageStrip.js
// The bottom strip for PDF and text tabs: one segment per page, the current page marked, drag or tap to jump. In Scroll
// mode it follows the scroll position. PDF bookmarks and outline entries show as labels on it, like the song parts on the
// bar ruler. Guitar Pro files keep the bar ruler in the playback dock; this strip is for files with no bars.
import { getScrubState, applyScrubValue, scrubLabel } from './pageScrubber.js';

const $ = (id) => document.getElementById(id);

export function initPageStrip(getConfig) {
    const strip = $('pageStrip');
    if (!strip) return;
    const track = strip.querySelector('.page-strip-track');
    const marksEl = strip.querySelector('.page-strip-marks');
    let marks = [];
    let drawn = { total: -1, continuous: null };
    let dragging = false;
    // Page turns on the strip show at once and the page itself renders once, for the last target, after the taps stop.
    // Rendering a page is slow, so taps made faster than it renders would otherwise each wait for a render.
    let pending = null;
    let applyTimer = 0;

    // The strip takes the ruler's place in the dock, like the bar ruler on Guitar Pro files, so the bottom is one strip on
    // every platform (on a phone it is the thin row above the controls).
    const slot = $('dockRulerSlot');
    if (slot) slot.appendChild(strip);
    strip.classList.toggle('in-dock', strip.parentNode === slot);

    const isScore = () => Boolean(getConfig().gpState?.canvases?.[0]);

    function applyMarks() {
        import('../pdfProcessor/pdfBookmarks.js').then((m) => { marks = m.getPdfBookmarkMarks(); drawn = { total: -1, continuous: null }; render(); }).catch(() => {});
    }
    document.addEventListener('pdfbookmarks:changed', applyMarks);

    function build(state) {
        track.replaceChildren();
        if (!state.continuous) {
            const frag = document.createDocumentFragment();
            for (let i = 0; i < state.total; i++) {
                const seg = document.createElement('i');
                seg.className = 'page-strip-seg';
                frag.appendChild(seg);
            }
            track.appendChild(frag);
            track.style.setProperty('--pages', String(state.total));
            // A long book has more pages than the strip has pixels for gaps: drop the gaps so it never outgrows the track
            track.style.setProperty('--seg-gap', state.total * 4 > (track.clientWidth || 600) ? '0px' : '2px');
        } else {
            const fill = document.createElement('i');
            fill.className = 'page-strip-fill';
            const head = document.createElement('i');
            head.className = 'page-strip-head';
            track.append(fill, head);
        }
        // labels: bookmarks and outline entries, as many as fit without touching
        marksEl.replaceChildren();
        if (!state.continuous && marks.length) {
            const width = track.clientWidth || 600;
            let lastRight = -Infinity;
            marks.forEach((mk) => {
                const left = (mk.pageIndex / state.total) * width;
                const w = Math.min(160, mk.title.length * 7 + 12);
                if (left < lastRight + 6 || left + w > width + 40) return;
                lastRight = left + w;
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'page-strip-mark';
                b.style.left = `${(mk.pageIndex / state.total) * 100}%`;
                b.textContent = mk.title;
                b.title = `${mk.title}, page ${mk.pageIndex + 1}`;
                b.addEventListener('click', () => jump(mk.pageIndex));
                marksEl.appendChild(b);
            });
        }
        drawn = { total: state.total ?? 0, continuous: state.continuous };
    }

    function render() {
        const cfg = getConfig();
        const state = (!isScore() && cfg.currentFile) ? getScrubState(cfg) : null;
        if (state && pending !== null && !state.continuous) state.value = Math.max(state.min, Math.min(state.max, pending));
        const show = Boolean(state) && (state.continuous || state.total > 1) && !document.body.classList.contains('library-view-active');
        strip.hidden = !show;
        document.body.classList.toggle('page-strip-on', show);
        if (!show) return;
        if (drawn.total !== (state.total ?? 0) || drawn.continuous !== state.continuous) build(state);
        track.setAttribute('aria-valuemin', String(state.min));
        track.setAttribute('aria-valuemax', String(state.max));
        track.setAttribute('aria-valuenow', String(state.value));
        track.setAttribute('aria-valuetext', state.continuous ? `${state.value}% of the way down` : `Page ${scrubLabel(state, state.value)}`);
        if (state.continuous) {
            track.querySelector('.page-strip-fill').style.transform = `scaleX(${state.value / 100})`;
            track.querySelector('.page-strip-head').style.left = `${state.value}%`;
        } else {
            const segs = track.children;
            for (let i = 0; i < segs.length; i++) segs[i].classList.toggle('is-current', i >= state.value && i < state.value + state.perView);
        }
    }

    function valueAt(clientX, state) {
        const r = track.getBoundingClientRect();
        const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
        return state.continuous ? Math.round(f * 100) : Math.max(state.min, Math.min(state.max, Math.floor(f * state.total)));
    }
    function jump(v) {
        const cfg = getConfig();
        const state = getScrubState(cfg);
        if (!state) return;
        const target = Math.max(state.min, Math.min(state.max, v));
        if (state.continuous) { applyScrubValue(cfg, state, target); render(); return; }
        pending = target;
        render();
        clearTimeout(applyTimer);
        applyTimer = setTimeout(() => {
            const goal = pending;
            const cur = getConfig();
            const st = getScrubState(cur);
            if (st && goal !== null) applyScrubValue(cur, st, Math.max(st.min, Math.min(st.max, goal)));
            pending = null;
            render();
        }, 80);
    }
    // Where the next relative step starts from: the page already shown on the strip, not the one last rendered
    const baseValue = (state) => (pending !== null && !state.continuous ? pending : state.value);
    track.addEventListener('pointerdown', (e) => {
        const state = getScrubState(getConfig());
        if (!state) return;
        dragging = true;
        track.setPointerCapture(e.pointerId);
        jump(valueAt(e.clientX, state));
    });
    track.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const state = getScrubState(getConfig());
        if (state) jump(valueAt(e.clientX, state));
    });
    const stop = () => { dragging = false; };
    track.addEventListener('pointerup', stop);
    track.addEventListener('pointercancel', stop);
    track.addEventListener('keydown', (e) => {
        const state = getScrubState(getConfig());
        if (!state) return;
        const step = state.continuous ? 5 : 1;
        const map = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step, PageUp: -step * 5, PageDown: step * 5 };
        if (e.key in map) { e.preventDefault(); e.stopPropagation(); jump(baseValue(state) + map[e.key]); }
        else if (e.key === 'Home') { e.preventDefault(); jump(state.min); }
        else if (e.key === 'End') { e.preventDefault(); jump(state.max); }
    });

    applyMarks();
    setInterval(() => { if (!dragging) render(); }, 300);
    render();
}
