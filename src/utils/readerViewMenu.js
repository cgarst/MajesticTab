// readerViewMenu.js
// The reader's View menu. Holds the options you change while playing: size, paper tone
// (Auto, Light, Dark, Theme) and the page layout. The controls live in the settings markup
// (#readerViewOptions) with their original ids so the modules that bind to them keep working;
// this file moves that block into the menu and handles open, close and placement.

const $ = (id) => document.getElementById(id);

export function initReaderViewMenu() {
    initMoreMenu();
    initPracticeButton();
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


// ---- More: file verbs (save, setlist, export) and a way to Settings. The buttons are the originals, moved here,
// so their handlers and ids keep working.
function initMoreMenu() {
    const toggle = $('moreToggleBtn');
    const menu = $('moreMenu');
    if (!toggle || !menu) return;
    const section = $('scoreOptionsExportSection');
    const details = $('scoreOptionsMoreDetails');
    if (section) {
        menu.appendChild(section);
        section.classList.remove('pt-2');
        section.classList.add('more-menu-list');
    }
    details?.remove();
    const settings = document.createElement('button');
    settings.type = 'button';
    settings.className = 'btn btn-theme-outline more-menu-settings';
    settings.id = 'moreSettingsBtn';
    settings.innerHTML = '<i class="bi-gear text-info"></i> Settings';
    settings.addEventListener('click', () => { close(); $('menuToggleBtn')?.click(); });
    (section || menu).appendChild(settings);

    const isOpen = () => menu.style.display !== 'none';
    function place() {
        const rect = toggle.getBoundingClientRect();
        menu.style.top = `${Math.round(rect.bottom + 8)}px`;
        menu.style.right = '12px';
    }
    function open() { place(); menu.style.display = ''; toggle.setAttribute('aria-expanded', 'true'); }
    function close() { if (!isOpen()) return; menu.style.display = 'none'; toggle.setAttribute('aria-expanded', 'false'); }
    toggle.addEventListener('click', (e) => { e.stopPropagation(); if (isOpen()) close(); else open(); });
    document.addEventListener('pointerdown', (e) => { if (isOpen() && !menu.contains(e.target) && !toggle.contains(e.target)) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) { close(); toggle.focus(); } });
    menu.addEventListener('click', (e) => { if (e.target.closest('button') && !e.target.closest('#exportProgressContainer')) setTimeout(close, 0); });
    window.addEventListener('resize', () => { if (isOpen()) place(); });
}

// ---- Practice: opens the panel for the sound that is active (recording if it was last used, else the synth)
function initPracticeButton() {
    const btn = $('practiceToggleBtn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        const yt = $('ytToggleBtn');
        const synth = $('synthToggleBtn');
        const useRecording = yt && yt.style.display !== 'none' && (yt.classList.contains('active-audio-mode') || yt.classList.contains('active'));
        (useRecording ? yt : (synth && synth.style.display !== 'none' ? synth : yt))?.click();
    });
}


// The View menu reads: Layout, pages shown in landscape, page turn, Size, Paper, then a way to Settings.
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

    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'btn view-more-settings';
    more.textContent = 'More in Settings';
    more.addEventListener('click', () => { $('menuToggleBtn')?.click(); });

    const order = [layout, landscape, advance, size, paper, more].filter(Boolean);
    root.innerHTML = '';
    order.forEach((el) => root.appendChild(el));
}
