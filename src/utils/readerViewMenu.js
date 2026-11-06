// readerViewMenu.js
// The reader's View menu. Holds the options you change while playing: size, paper tone
// (Auto, Light, Dark, Theme) and the page layout. The controls live in the settings markup
// (#readerViewOptions) with their original ids so the modules that bind to them keep working;
// this file moves that block into the menu and handles open, close and placement.

import { gamepadManager } from './gamepadManager.js';
import { showPanel, hidePanel, isShown, placePanel } from './readerPanels.js';
const $ = (id) => document.getElementById(id);

export function initReaderViewMenu() {
    initPhoneChrome();
    initTracksMenu();
    arrangeSongPanel();
    initPracticePanels();
    const toggleBtn = $('viewToggleBtn');
    const menu = $('viewMenu');
    const options = $('readerViewOptions');
    if (!toggleBtn || !menu || !options) return;

    arrangeViewOptions(options);
    menu.appendChild(options);

    const isOpen = () => isShown(menu);

    const place = () => placePanel(menu, toggleBtn);

    function open() {
        showPanel(menu);
        place();
        toggleBtn.setAttribute('aria-expanded', 'true');
        window.refreshSlidingPills?.(menu, true);
    }

    function close() {
        if (!isOpen()) return;
        hidePanel(menu);
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


// ---- Tracks: the labelled button opens the track list (show, hear, levels, color). The Song menu (recording, section
// marks, PDF, save and share) opens from the song's name in the top bar and is the original score options panel.
function initTracksMenu() {
    const btn = $('tracksToggleBtn');
    const menu = $('tracksMenu');
    const tracks = $('synthTrackVisibilitySection');
    if (!btn || !menu || !tracks) return;

    const head = document.createElement('div');
    head.className = 'tracks-title';
    head.textContent = 'Tracks';
    const tracksLabel = tracks.querySelector('label.form-label');
    if (tracksLabel) tracksLabel.textContent = 'Show and hear';
    menu.replaceChildren(head, tracks);

    const isOpen = () => isShown(menu);
    const place = () => placePanel(menu, btn);
    function open() { showPanel(menu); place(); btn.setAttribute('aria-expanded', 'true'); }
    function close() { if (!isOpen()) return; hidePanel(menu); btn.setAttribute('aria-expanded', 'false'); }
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => { e.stopPropagation(); if (btn.disabled) return; if (isOpen()) close(); else open(); });
    document.addEventListener('pointerdown', (e) => { if (isOpen() && !menu.contains(e.target) && !btn.contains(e.target)) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) { close(); btn.focus(); } });
    window.addEventListener('resize', () => { if (isOpen()) place(); });

    // The track list only exists for Guitar Pro files; the button follows it
    const sync = () => {
        const available = tracks.style.display !== 'none';
        btn.disabled = !available;
        if (!available) close();
    };
    new MutationObserver(sync).observe(tracks, { attributes: true, attributeFilter: ['style'] });
    sync();
}

// The View menu reads: Size, Note spacing, Paper, Layout, Notation, pages shown in landscape, page turn.
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

    // Window: fullscreen (hidden by main.js where the platform has its own) and zen mode
    const windowRows = [$('screenRow')].filter(Boolean);
    const zenLabel = $('zenLabel');
    const syncZenLabel = () => { if (zenLabel) zenLabel.textContent = gamepadManager.isHudHidden ? 'Show bars' : 'Zen mode'; };
    $('viewToggleBtn')?.addEventListener('click', syncZenLabel, true);
    $('zenToggleBtn')?.addEventListener('click', () => {
        $('viewToggleBtn')?.click();
        gamepadManager.toggleTopBar();
        syncZenLabel();
    });

    const density = $('gpDensitySection');
    const order = [...windowRows, size, density, paper, layout, notation, landscape, advance].filter(Boolean);
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
        if (!panel) continue;
        new MutationObserver(updateOpen).observe(panel, { attributes: true, attributeFilter: ['style', 'class'] });
    }
    function updateOpen() {
        const open = panels.some(({ id }) => { const el = $(id); return el && el.style.display !== 'none' && getComputedStyle(el).display !== 'none'; });
        if (document.body.classList.contains('practice-open') === open) return;
        document.body.classList.toggle('practice-open', open);
        // The panel changes the width the pages sit in (see design.css), so text and PDF tabs re-fit their pages:
        // the resize handler in main.js re-paginates them for the new width.
        window.dispatchEvent(new Event('resize'));
    }
    const dock = $('mobilePlaybackDock');
    if (dock && 'ResizeObserver' in window) {
        // --dock-h is the whole stack above the bottom row (transport, plus the page strip on PDF and text tabs);
        // --dock-own-h and --strip-h are its two parts, which the phone chrome needs to hide them one by one.
        const strip = $('pageStrip');
        const syncDock = () => {
            const root = document.documentElement.style;
            const own = dock.offsetHeight;
            const stripH = strip && !strip.hidden && !strip.classList.contains('in-dock') ? strip.offsetHeight : 0;
            root.setProperty('--dock-own-h', `${own}px`);
            root.setProperty('--strip-h', `${stripH}px`);
            root.setProperty('--dock-h', `${own + stripH}px`);
        };
        const ro = new ResizeObserver(syncDock);
        ro.observe(dock);
        if (strip) ro.observe(strip);
        syncDock();
    }
    const bar = $('topBar');
    if (bar && 'ResizeObserver' in window) {
        new ResizeObserver(() => document.documentElement.style.setProperty('--topbar-h', `${bar.offsetHeight}px`)).observe(bar);
    }
}


// ---- Song menu (opens from the song's name): save and share, PDF options, section marks ----
// Moves the original controls into place (ids kept). Notation went to View and strings and tuning to Guitar.
function arrangeSongPanel() {
    const body = document.querySelector('#scoreOptionsDropdownPanel .synth-panel-body');
    const tracks = $('synthTrackVisibilitySection');
    if (!body || !tracks) return;

    const group = (id, title, ...nodes) => {
        const g = document.createElement('div');
        g.className = 'score-options-group';
        g.id = id;
        const t = document.createElement('div');
        t.className = 'score-options-group-title';
        t.textContent = title;
        g.append(t, ...nodes.filter(Boolean));
        return g;
    };

    // Hear: Full band, Guitars only, No guitars. It is a synth sound option, so it opens with the Synth button
    const hear = $('synthTrackModeContainer');
    const soundRow = $('soundFontModalBtn')?.closest('.mb-3');
    if (hear && soundRow) {
        const l = hear.querySelector('label.form-label');
        if (l) l.textContent = 'Hear';
        soundRow.before(hear);
    }

    // Recording and sync live with the Recording button in the dock: the embedded-audio sync switch moves into its panel
    const audioSync = $('synthAudioSyncSection');
    const recBody = document.querySelector('#ytDropdownPanel .yt-panel-body');
    if (audioSync && recBody) recBody.appendChild(audioSync);

    // Section marks: what the ruler's labels were read from (only when the file has marks)
    const marksBtn = document.createElement('button');
    marksBtn.type = 'button';
    marksBtn.id = 'songMarksBtn';
    marksBtn.className = 'btn btn-sm song-row-btn';
    marksBtn.innerHTML = '<span><b>Section marks in this file</b><small>See what the ruler\'s part labels were read from</small></span>';
    marksBtn.addEventListener('click', () => {
        $('scoreOptionsPanelCloseBtn')?.click();
        $('barRulerInfoBtn')?.click();
    });
    const marksGroup = group('scoreOptionsMarksGroup', 'Parts', marksBtn);
    const syncMarks = () => { marksGroup.style.display = $('barRulerInfoBtn') && !$('barRulerInfoBtn').hidden ? '' : 'none'; };
    marksGroup.style.display = 'none';
    const watchMarks = () => {
        const info = $('barRulerInfoBtn');
        if (info) { new MutationObserver(syncMarks).observe(info, { attributes: true, attributeFilter: ['hidden'] }); syncMarks(); return true; }
        return false;
    };
    if (!watchMarks()) { const t = setInterval(() => { if (watchMarks()) clearInterval(t); }, 500); setTimeout(() => clearInterval(t), 20000); }

    // Find alternate tab: the same search as the library's "find tab" for this song, to try another version
    const altBtn = document.createElement('button');
    altBtn.type = 'button';
    altBtn.id = 'songFindAltTabBtn';
    altBtn.className = 'btn btn-sm song-row-btn';
    altBtn.innerHTML = '<span><b>Find alternate tab</b><small>Look for another tab of this song</small></span>';
    altBtn.addEventListener('click', async () => {
        const { playerState } = await import('../youtubePlayer.js');
        const { artist, title } = playerState;
        if (!title) return;
        $('scoreOptionsPanelCloseBtn')?.click();
        const { handleGetTabSingleSong } = await import('../libraryModal.js');
        handleGetTabSingleSong({ artist, title });
    });

    // Tab info: web source, file provider used, or unknown; plus tracked added date
    const srcBtn = document.createElement('a');
    srcBtn.id = 'songSourceUrlBtn';
    srcBtn.className = 'btn btn-sm song-row-btn';
    srcBtn.target = '_blank';
    srcBtn.rel = 'noopener noreferrer';

    const providerNames = {
        'local': 'This Device',
        'tab-downloader': 'Web Search',
        'google-drive': 'Google Drive',
        'icloud-drive': 'iCloud Drive',
        's3': 'Amazon S3',
        'webdav': 'WebDAV',
        'url': 'Web URL'
    };

    const formatAddedDate = (ts) => {
        if (!ts) return '';
        try {
            const d = new Date(ts);
            if (isNaN(d.getTime())) return '';
            return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
        } catch {
            return '';
        }
    };

    const escapeText = (str) => {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    };

    const updateSrcBtn = async () => {
        const { getCurrentFile } = await import('../main.js');
        const file = getCurrentFile();
        if (!file) {
            srcBtn.hidden = true;
            return;
        }
        srcBtn.hidden = false;
        const addedStr = formatAddedDate(file.addedAt || file.lastModified);
        const addedMeta = addedStr ? ` · Added ${addedStr}` : '';

        if (file.sourceUrl || file.sourceWebsite) {
            const webSource = file.sourceWebsite || file.sourceUrl;
            const linkUrl = file.sourceUrl || (file.sourceWebsite === 'Classtab' ? 'https://www.classtab.org/' : '');
            if (linkUrl) {
                srcBtn.href = linkUrl;
                srcBtn.style.cursor = 'pointer';
            } else {
                srcBtn.removeAttribute('href');
                srcBtn.style.cursor = 'default';
            }
            srcBtn.innerHTML = `<span><b>Source website</b><small>${escapeText(webSource)}${addedMeta}</small></span>`;
        } else if (file.providerId) {
            srcBtn.removeAttribute('href');
            srcBtn.style.cursor = 'default';
            const pName = providerNames[file.providerId] || file.providerId;
            srcBtn.innerHTML = `<span><b>File provider</b><small>${escapeText(pName)}${addedMeta}</small></span>`;
        } else {
            srcBtn.removeAttribute('href');
            srcBtn.style.cursor = 'default';
            srcBtn.innerHTML = `<span><b>Source</b><small>Unknown${addedMeta}</small></span>`;
        }
    };
    document.addEventListener('scoreoptions:open', updateSrcBtn);
    const altGroup = group('scoreOptionsAltTabGroup', 'Tabs', altBtn, srcBtn);

    const pdf = $('scoreOptionsPdfSection');
    const save = $('scoreOptionsSaveGroup');
    // Notation, strings and tuning leave this panel: View and Guitar claim them. Until they do (they initialise after
    // this), park them in the DOM so they stay reachable by id.
    const parking = document.createElement('div');
    parking.id = 'songPanelParking';
    parking.hidden = true;
    ['scoreOptionsNotationStyleSection', 'scoreOptionsStringCountSection', 'scoreOptionsAdaptSection'].forEach((id) => { const n = $(id); if (n) parking.appendChild(n); });
    document.body.appendChild(parking);
    body.replaceChildren(...[save, altGroup, pdf, marksGroup].filter(Boolean));
}


// ---- Phone: the bottom row of words slides away while you scroll down in Scroll mode and returns on scroll up ----
function initPhoneChrome() {
    const output = $('output');
    if (!output) return;
    let last = 0;
    const narrow = () => window.matchMedia('(max-width: 640px), (pointer: coarse) and (orientation: landscape) and (max-height: 500px)').matches;
    // Only a hand moves the chrome. Playback following the cursor, a ruler drag or a jump to a bar also scroll the
    // score, and the bottom row (with the fretboard) must not come and go because of those.
    let handUntil = 0;
    // Idle timer: with no touch, key or pointer input for a few seconds the bars slide away; any input brings them back
    const IDLE_MS = 4000;
    let idleTimer = 0;
    // never hide it while one of its sheets is open
    const anySheetOpen = () => ['viewMenu', 'practiceMenu', 'guitarMenu', 'toolsMenu', 'tracksMenu', 'scoreOptionsDropdownPanel', 'synthDropdownPanel', 'ytDropdownPanel', 'pdfBookmarksPanel'].some((id) => {
        const el = $(id); return el && el.style.display !== 'none' && getComputedStyle(el).display !== 'none';
    });
    const armIdle = () => {
        clearTimeout(idleTimer);
        if (!narrow() || document.body.classList.contains('library-view-active')) return;
        idleTimer = setTimeout(() => {
            if (narrow() && !document.body.classList.contains('library-view-active') && !anySheetOpen()) document.body.classList.add('chrome-hidden');
            else armIdle();
        }, IDLE_MS);
    };
    ['pointerdown', 'touchstart', 'keydown'].forEach((ev) => document.addEventListener(ev, () => {
        document.body.classList.remove('chrome-hidden');
        armIdle();
    }, { passive: true, capture: true }));
    armIdle();
    // A sheet opened without a touch (keyboard, gamepad, a script) must still bring the bars back: the sheet sits
    // above the dock and bottom row, so it cannot stand without them
    const revealForSheet = () => { if (anySheetOpen()) document.body.classList.remove('chrome-hidden'); };
    const sheetObserver = new MutationObserver(revealForSheet);
    ['viewMenu', 'practiceMenu', 'guitarMenu', 'toolsMenu', 'tracksMenu', 'scoreOptionsDropdownPanel', 'synthDropdownPanel', 'ytDropdownPanel', 'pdfBookmarksPanel'].forEach((id) => {
        const el = $(id); if (el) sheetObserver.observe(el, { attributes: true, attributeFilter: ['style', 'class'] });
    });
    let lastH = output.clientHeight;
    const hand = () => { handUntil = performance.now() + 1500; };
    // A plain tap is not a hand scroll: counting touchstart/pointerdown let playback's own autoscroll within the next
    // 1.5s hide the bars again right after the tap brought them back
    ['touchmove', 'wheel'].forEach((ev) => output.addEventListener(ev, hand, { passive: true }));
    output.addEventListener('scroll', () => {
        if (!narrow()) { document.body.classList.remove('chrome-hidden'); return; }
        const y = output.scrollTop;
        // Hiding the chrome makes the score taller; at the end of the song the browser then pulls scrollTop back
        // by itself, which is not the reader scrolling up
        if (output.clientHeight !== lastH) { lastH = output.clientHeight; last = y; return; }
        if (performance.now() > handUntil) { last = y; return; }
        const delta = y - last;
        if (Math.abs(delta) < 12) return;
        const sheetOpen = anySheetOpen();
        document.body.classList.toggle('chrome-hidden', delta > 0 && y > 80 && !sheetOpen);
        last = y;
        armIdle();
    }, { passive: true });
    window.addEventListener('resize', () => { if (!narrow()) document.body.classList.remove('chrome-hidden'); });
}
