// readerViewMenu.js
// The reader's View menu. Holds the options you change while playing: size, paper tone
// (Auto, Light, Dark, Theme) and the page layout. The controls live in the settings markup
// (#readerViewOptions) with their original ids so the modules that bind to them keep working;
// this file moves that block into the menu and handles open, close and placement.

const $ = (id) => document.getElementById(id);

export function initReaderViewMenu() {
    initSongButton();
    initPracticePanels();
    const toggleBtn = $('viewToggleBtn');
    const menu = $('viewMenu');
    const options = $('readerViewOptions');
    if (!toggleBtn || !menu || !options) return;

    arrangeViewOptions(options);
    menu.appendChild(options);

    const isOpen = () => menu.style.display !== 'none';

    function place() {
        const rect = toggleBtn.getBoundingClientRect();
        menu.style.top = `${Math.round(rect.bottom + 8)}px`;
        menu.style.right = '12px';
    }

    function open() {
        place();
        menu.style.display = '';
        toggleBtn.setAttribute('aria-expanded', 'true');
        window.refreshSlidingPills?.(menu, true);
    }

    function close() {
        if (!isOpen()) return;
        menu.style.display = 'none';
        toggleBtn.setAttribute('aria-expanded', 'false');
    }

    toggleBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        if (isOpen()) close(); else open();
    });
    document.addEventListener('pointerdown', (event) => {
        if (isOpen() && !menu.contains(event.target) && !toggleBtn.contains(event.target)) close();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && isOpen()) { close(); toggleBtn.focus(); }
    });
    window.addEventListener('resize', () => { if (isOpen()) place(); });
}


// ---- Song: the labelled button opens the Song panel (tracks, recording, save and share). The panel and its
// open and close logic are the original "This song" panel in gpPlayer.js; this button proxies the (now plain) title.
function initSongButton() {
    const btn = $('songToggleBtn');
    const title = $('topBarSongTitleBtn');
    if (!btn || !title) return;
    // The title is a label now; its old button role stays for code that clicks it programmatically
    title.tabIndex = -1;
    title.setAttribute('aria-hidden', 'true');
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (title.classList.contains('disabled')) return;
        title.click();
    });
    const sync = () => {
        const open = title.getAttribute('aria-expanded') === 'true';
        const off = title.classList.contains('disabled') || title.getAttribute('aria-disabled') === 'true';
        btn.classList.toggle('active', open);
        btn.setAttribute('aria-expanded', String(open));
        btn.disabled = off;
    };
    new MutationObserver(sync).observe(title, { attributes: true, attributeFilter: ['class', 'aria-expanded', 'aria-disabled'] });
    sync();
}

// The View menu reads: Layout, pages shown in landscape, page turn, Size, Paper.
// The four original groups keep their controls and ids; this only reorders and relabels them.
function arrangeViewOptions(root) {
    const groups = Array.from(root.children).filter((el) => el.tagName === 'DIV');
    const find = (sel) => groups.find((g) => g.querySelector(sel));
    const paper = find('#drawerSheetModeAuto');
    const size = find('#gpSheetScale');
    const landscape = find('#landscapeLayoutDual');
    const advance = find('#pageAdvance1');

    const relabel = (group, text) => {
        const label = group?.querySelector('label.form-label');
        if (label) label.textContent = text;
    };
    relabel(paper, 'Paper');
    relabel(landscape, 'Pages shown in landscape');
    relabel(advance, 'A page turn advances');
    const lowercasePages = (group) => group?.querySelectorAll('.btn-check + label').forEach((l) => {
        l.textContent = l.textContent.replace(/\s+/g, ' ').trim().replace('Pages', 'pages').replace('Page', 'page');
    });
    lowercasePages(landscape);
    lowercasePages(advance);
    paper?.querySelectorAll('.btn-check + label').forEach((l) => { l.textContent = l.textContent.trim(); });

    // Size: the label row carries the value
    if (size) {
        const label = size.querySelector('label.form-label');
        const value = $('gpSheetScaleValue');
        const scaleRow = size.querySelector('.d-flex.justify-content-between');
        if (label && value) {
            label.classList.add('view-size-label');
            label.textContent = 'Size';
            label.appendChild(value);
        }
        scaleRow?.remove();
    }

    // Layout proxies the Page / Scroll radios in the top bar
    const layout = document.createElement('div');
    layout.innerHTML = '<label class="form-label d-block mb-1 small text-white-50">Layout</label>'
        + '<div class="hud-pill-group w-100" role="group" aria-label="Layout">'
        + '<button type="button" class="btn btn-sm w-50" data-layout="page">Page</button>'
        + '<button type="button" class="btn btn-sm w-50" data-layout="scroll">Scroll</button></div>';
    const pageRadio = $('pageModeRadio');
    const scrollRadio = $('continuousModeRadio');
    const syncLayout = () => {
        layout.querySelector('[data-layout="page"]').classList.toggle('active', Boolean(pageRadio?.checked));
        layout.querySelector('[data-layout="scroll"]').classList.toggle('active', Boolean(scrollRadio?.checked));
    };
    layout.addEventListener('click', (e) => {
        const b = e.target.closest('[data-layout]');
        if (!b) return;
        (b.dataset.layout === 'page' ? pageRadio : scrollRadio)?.click();
        setTimeout(syncLayout, 0);
    });
    [pageRadio, scrollRadio].forEach((r) => r?.addEventListener('change', syncLayout));
    document.addEventListener('click', () => setTimeout(syncLayout, 0), true);
    syncLayout();

    // Notation: tab only, or tab with the standard staff. A temporary override of the Settings default.
    const notation = $('scoreOptionsNotationStyleSection');
    if (notation) {
        const nl = notation.querySelector('label.form-label');
        if (nl) nl.textContent = 'Notation';
        notation.querySelectorAll('.btn-check + label i').forEach((i) => i.remove());
        notation.querySelectorAll('.btn-check + label').forEach((l) => {
            l.textContent = l.textContent.trim().replace('Tab Only', 'Tab only').replace('Tab + Standard', 'Tab and standard');
        });
    }

    const order = [layout, notation, landscape, advance, size, paper].filter(Boolean);
    root.innerHTML = '';
    order.forEach((el) => root.appendChild(el));
}


// The Synth and Recording panels share one chrome: a right-hand "Practice" panel beside the score with a
// Synth | Recording switch on top. Their controls and handlers are unchanged; this adds the switch, keeps the
// score clear of the panel, and tracks the dock height so the panel stops above it.
function initPracticePanels() {
    const panels = [
        { id: 'synthDropdownPanel', which: 'synth' },
        { id: 'ytDropdownPanel', which: 'recording' }
    ];
    const toggles = { synth: $('synthToggleBtn'), recording: $('ytToggleBtn') };
    for (const { id, which } of panels) {
        const panel = $(id);
        const body = panel?.querySelector('.synth-panel-body, .yt-panel-body');
        if (!panel || !body) continue;
        const seg = document.createElement('div');
        seg.className = 'hud-pill-group practice-seg';
        seg.setAttribute('role', 'group');
        seg.setAttribute('aria-label', 'Sound');
        seg.innerHTML = `<button type="button" class="btn btn-sm${which === 'synth' ? ' active' : ''}" data-which="synth">Synth</button>`
            + `<button type="button" class="btn btn-sm${which === 'recording' ? ' active' : ''}" data-which="recording">Recording</button>`;
        seg.addEventListener('click', (e) => {
            e.stopPropagation();
            const b = e.target.closest('[data-which]');
            if (!b || b.dataset.which === which) return;
            toggles[b.dataset.which]?.click();
        });
        body.insertBefore(seg, body.firstChild);
        new MutationObserver(updateOpen).observe(panel, { attributes: true, attributeFilter: ['style', 'class'] });
    }
    function updateOpen() {
        const open = panels.some(({ id }) => { const el = $(id); return el && el.style.display !== 'none' && getComputedStyle(el).display !== 'none'; });
        document.body.classList.toggle('practice-open', open);
    }
    const dock = $('mobilePlaybackDock');
    if (dock && 'ResizeObserver' in window) {
        new ResizeObserver(() => document.documentElement.style.setProperty('--dock-h', `${dock.offsetHeight}px`)).observe(dock);
    }
    const bar = $('topBar');
    if (bar && 'ResizeObserver' in window) {
        new ResizeObserver(() => document.documentElement.style.setProperty('--topbar-h', `${bar.offsetHeight}px`)).observe(bar);
    }
}
