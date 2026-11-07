// readerViewMenu.js
// The reader's View menu. Holds the options you change while playing: size, paper tone
// (Auto, Light, Dark, Theme) and the page layout. The controls live in the settings markup
// (#readerViewOptions) with their original ids so the modules that bind to them keep working;
// this file moves that block into the menu and handles open, close and placement.

import { gamepadManager, READING_MODE_KEY } from './gamepadManager.js';
import { PHONE_READER_QUERY } from './viewModeUtils.js';
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

    // Window: fullscreen (hidden by main.js where the platform has its own) and Reading mode
    const windowRows = [$('screenRow')].filter(Boolean);
    $('readingToggleBtn')?.addEventListener('click', () => {
        $('viewToggleBtn')?.click();
        gamepadManager.toggleTopBar();
    });
    // Phones have the toggle in the bottom strip, so View does not repeat it
    $('readingCell')?.classList.add('desktop-only-control');

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


// ---- Phone: the top (back, song name, the five words) slides away on a hand scroll down in Scroll mode ----
// The only trigger is the player's own scroll in continuous mode. No timers, no tap zones, no playback events.
// The top overlays the score, so hiding it resizes nothing and nothing is refitted.
const HIDE_AFTER_PX = 48;     // net scroll down before it hides
const SHOW_AFTER_PX = 16;     // scroll up that brings it back
const NEVER_HIDE_WITHIN_PX = 80; // the first 80px of the score keep it
const SHEET_IDS = ['viewMenu', 'practiceMenu', 'guitarMenu', 'toolsMenu', 'tracksMenu', 'scoreOptionsDropdownPanel', 'synthDropdownPanel', 'ytDropdownPanel', 'pdfBookmarksPanel'];

function initPhoneChrome() {
    const output = $('output');
    if (!output) return;
    const body = document.body;
    const narrow = () => window.matchMedia(PHONE_READER_QUERY).matches;
    const anySheetOpen = () => SHEET_IDS.some((id) => {
        const el = $(id); return el && el.style.display !== 'none' && getComputedStyle(el).display !== 'none';
    });
    // body.phone-reader switches on the phone layout in design.css (the same query as isPhoneReader)
    const mq = window.matchMedia(PHONE_READER_QUERY);
    const syncPhoneClass = () => {
        document.body.classList.toggle('phone-reader', mq.matches);
        if (!mq.matches) document.body.classList.remove('top-away');
    };
    // Portrait phone: the five words live in the bottom row, outside the (transformed) top bar
    const portraitMq = window.matchMedia('(max-width: 640px)');
    const placeTabs = () => {
        const zone = $('topFlexZone');
        if (!zone) return;
        if (portraitMq.matches) { if (zone.parentNode !== document.body) document.body.appendChild(zone); }
        else if (zone.parentNode === document.body) $('rightSection')?.insertBefore(zone, $('navButtons'));
    };
    syncPhoneClass();
    placeTabs();
    mq.addEventListener?.('change', () => { syncPhoneClass(); placeTabs(); });
    portraitMq.addEventListener?.('change', placeTabs);
    const setAway = (away) => body.classList.toggle('top-away', away && !body.classList.contains('reading-mode'));

    // Restore Reading mode on phones (silently: the score has not loaded yet, so there is nothing to refit)
    try { if (narrow() && localStorage.getItem(READING_MODE_KEY) === '1') gamepadManager.toggleTopBar(true, { silent: true }); } catch { /* storage blocked */ }

    // Only a hand moves the top. Playback following the cursor, a ruler drag or a jump to a bar also scroll the score.
    let handUntil = 0;
    const hand = () => { handUntil = performance.now() + 1500; };
    ['touchmove', 'wheel'].forEach((ev) => output.addEventListener(ev, hand, { passive: true }));
    document.addEventListener('keydown', (e) => {
        if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key) && !e.target.closest?.('input, textarea, select')) hand();
    }, { passive: true, capture: true });

    let anchor = 0; // scrollTop where the current direction began
    let lastY = 0;
    let dir = 0;
    output.addEventListener('scroll', () => {
        const y = output.scrollTop;
        const delta = y - lastY;
        lastY = y;
        if (!narrow() || !output.classList.contains('continuous-mode')) { setAway(false); anchor = y; dir = 0; return; }
        if (performance.now() > handUntil) { anchor = y; dir = 0; return; }
        if (y <= NEVER_HIDE_WITHIN_PX) { setAway(false); anchor = y; dir = 0; return; }
        const d = Math.sign(delta);
        if (d !== 0 && d !== dir) { dir = d; anchor = y - delta; }
        const net = y - anchor;
        if (dir > 0 && net >= HIDE_AFTER_PX && !anySheetOpen()) { setAway(true); anchor = y; }
        else if (dir < 0 && -net >= SHOW_AFTER_PX) { setAway(false); anchor = y; }
    }, { passive: true });

    $('readingDockBtn')?.addEventListener('click', () => gamepadManager.toggleTopBar());

    // Back in the bar: a sheet opening, the Song menu, or focus entering the top
    const reveal = () => setAway(false);
    const sheetObserver = new MutationObserver(() => { if (anySheetOpen()) reveal(); });
    SHEET_IDS.forEach((id) => { const el = $(id); if (el) sheetObserver.observe(el, { attributes: true, attributeFilter: ['style', 'class'] }); });
    $('topBar')?.addEventListener('focusin', reveal);
    // Leaving the reader (back to the library) starts the next song with the top shown
    new MutationObserver(() => { if (body.classList.contains('library-view-active')) reveal(); }).observe(body, { attributes: true, attributeFilter: ['class'] });
    // Rotation or leaving phone size: the top starts shown
    window.addEventListener('resize', () => { if (!narrow()) { setAway(false); } });
    window.addEventListener('orientationchange', reveal);
    // Switching to Page mode (no scroll) or a new song starts with the top shown
    document.addEventListener('scoreoptions:open', reveal);
}
