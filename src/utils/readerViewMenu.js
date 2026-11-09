// readerViewMenu.js
// The reader's View menu. Holds the options you change while playing: size, paper tone
// (Auto, Light, Dark, Theme) and the page layout. The controls live in the settings markup
// (#readerViewOptions) with their original ids so the modules that bind to them keep working;
// this file moves that block into the menu and handles open, close and placement.

import { gamepadManager, READING_MODE_KEY } from './gamepadManager.js';
import { PHONE_READER_QUERY } from './viewModeUtils.js';
import { isTabletop } from '../foldState.js';
import { showPanel, hidePanel, isShown, placePanel, outsideTapCloses } from './readerPanels.js';
const $ = (id) => document.getElementById(id);

export function initReaderViewMenu() {
    initPhoneChrome();
    initSoundButton();
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
        if (outsideTapCloses() && isOpen() && !menu.contains(event.target) && !toggleBtn.contains(event.target)) close();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && isOpen()) { close(); toggleBtn.focus(); }
    });
    window.addEventListener('resize', () => { if (isOpen()) place(); });
}


// ---- Sound: the labelled button opens the settings of the sound selected in the dock (Synth audio or Original audio).
// The two panels keep their own contents and chrome; this only chooses which one the word opens, and the dock's switch
// decides the selection.
function initSoundButton() {
    const btn = $('soundToggleBtn');
    const synthPanel = $('synthDropdownPanel');
    const originalPanel = $('ytDropdownPanel');
    const synthSwitch = $('mobileSynthToggleBtn');
    const originalSwitch = $('mobileYtToggleBtn');
    if (!btn || !synthPanel || !originalPanel) return;

    const visible = (el) => Boolean(el) && el.style.display !== 'none';
    const selected = () => {
        if (originalSwitch?.classList.contains('active-audio-mode')) return 'original';
        if (synthSwitch?.classList.contains('active-audio-mode')) return 'synth';
        return visible(synthSwitch) ? 'synth' : 'original';
    };

    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (btn.disabled) return;
        const original = selected() === 'original';
        const panel = original ? originalPanel : synthPanel;
        // Each panel opens and closes through its own button and close control (they also pause the other sound)
        if (isShown(panel)) $(original ? 'ytPanelCloseBtn' : 'synthPanelCloseBtn')?.click();
        else $(original ? 'ytToggleBtn' : 'synthToggleBtn')?.click();
    });

    // Like the other menus: a press outside or Escape closes it. The Synth | Original switch is left alone, since it
    // swaps the panel to the other sound.
    const closeOpen = () => {
        if (isShown(synthPanel)) $('synthPanelCloseBtn')?.click();
        if (isShown(originalPanel)) $('ytPanelCloseBtn')?.click();
    };
    document.addEventListener('pointerdown', (e) => {
        if (!outsideTapCloses() || !(isShown(synthPanel) || isShown(originalPanel))) return;
        if (synthPanel.contains(e.target) || originalPanel.contains(e.target) || btn.contains(e.target) || e.target.closest('.dock-src')) return;
        closeOpen();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && (isShown(synthPanel) || isShown(originalPanel))) { closeOpen(); btn.focus(); }
    });

    const sync = () => {
        const available = visible(synthSwitch) || visible(originalSwitch);
        btn.disabled = !available;
        btn.title = available ? 'Sound: settings for the selected sound, Synth or Original' : 'Sound: nothing to play for this file';
        btn.setAttribute('aria-expanded', String(isShown(synthPanel) || isShown(originalPanel)));
    };
    const watch = (el, filter) => { if (el) new MutationObserver(sync).observe(el, { attributes: true, attributeFilter: filter }); };
    [synthSwitch, originalSwitch].forEach((el) => watch(el, ['style', 'class']));
    [synthPanel, originalPanel].forEach((el) => watch(el, ['style', 'class']));
    sync();
}

// The View menu reads: Size, Note spacing, Paper, Layout, Notation, Tracks (Color by track above the list, only when the file has
// more than one track to show), pages shown in landscape, page turn.
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
    relabel(advance, 'Page turn');
    [landscape, advance].forEach((group) => group?.querySelectorAll('.btn-check + label').forEach((l) => {
        l.textContent = l.textContent.trim();
    }));
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

    // Tracks: which tracks are drawn (remembered for the song) and Color by track. gpHandler shows the section only
    // when the file has more than one; until then it stays hidden, so View never carries a dead control.
    const tracks = $('synthTrackVisibilitySection');
    if (tracks) {
        const tl = tracks.querySelector('label.form-label');
        if (tl) tl.textContent = 'Tracks';
        if (!tracks.querySelector('.view-tracks-note')) {
            const note = document.createElement('div');
            note.className = 'view-tracks-note small text-muted mb-1';
            note.textContent = 'Remembered for this song';
            tracks.querySelector('.d-flex')?.after(note);
        }
        tracks.querySelector('label[for="tabTrackColorSwitch"]')?.setAttribute('title', 'Match the tab colors to the fretboard track colors');
        // Color by track sits above the list it colors
        const colorRow = tracks.querySelector('.form-check.form-switch');
        const list = $('synthTrackList');
        if (colorRow && list) { colorRow.classList.remove('mt-2'); colorRow.classList.add('mb-1'); list.before(colorRow); }
    }

    const density = $('gpDensitySection');
    const order = [...windowRows, size, density, paper, layout, notation, tracks, landscape, advance].filter(Boolean);
    root.innerHTML = '';
    order.forEach((el) => root.appendChild(el));
}


// Tracks the dock and top bar heights (--dock-h, --dock-own-h, --strip-h, --topbar-h) that the panels and the phone chrome stop at.
function initPracticePanels() {
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
        window.addEventListener('resize', syncDock);
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
    // Notation and tracks leave this panel for View, strings and tuning for Guitar; each claims its own. Until they do (they initialise after
    // this), park them in the DOM so they stay reachable by id.
    const parking = document.createElement('div');
    parking.id = 'songPanelParking';
    parking.hidden = true;
    ['scoreOptionsNotationStyleSection', 'scoreOptionsStringCountSection', 'scoreOptionsAdaptSection', 'synthTrackVisibilitySection'].forEach((id) => { const n = $(id); if (n) parking.appendChild(n); });
    document.body.appendChild(parking);
    body.replaceChildren(...[save, altGroup, pdf, marksGroup].filter(Boolean));
}


// ---- Phone: the top (back, song name, the four words) never moves on its own ----
// Only Reading mode hides it. No scroll, timer, tap zone or playback event does.
function initPhoneChrome() {
    const output = $('output');
    if (!output) return;
    const body = document.body;
    const narrow = () => window.matchMedia(PHONE_READER_QUERY).matches;
    // body.phone-reader switches on the phone layout in design.css (the same query as isPhoneReader)
    const mq = window.matchMedia(PHONE_READER_QUERY);
    const syncPhoneClass = () => {
        document.body.classList.toggle('phone-reader', mq.matches || isTabletop());
    };
    // Portrait phone: the four words live in the bottom row, outside the (transformed) top bar
    const portraitMq = window.matchMedia('(max-width: 640px)');
    const placeTabs = () => {
        const zone = $('topFlexZone');
        if (!zone) return;
        if (portraitMq.matches || isTabletop()) { if (zone.parentNode !== document.body) document.body.appendChild(zone); }
        else if (zone.parentNode === document.body) $('rightSection')?.insertBefore(zone, $('navButtons'));
    };
    syncPhoneClass();
    placeTabs();
    mq.addEventListener?.('change', () => { syncPhoneClass(); placeTabs(); });
    portraitMq.addEventListener?.('change', placeTabs);
    // An iPhone Duo folded with the crease across uses the same chrome, Reading mode included
    window.addEventListener('foldchange', () => {
        syncPhoneClass();
        placeTabs();
    });

    // The first render of a file is sized before the bars have settled, so a PDF page sat 9px under the top row
    // until something resized the window: refit once the file has drawn
    window.addEventListener('majestictab:file-loaded', () => {
        if (!body.classList.contains('phone-reader')) return;
        for (const ms of [300, 1000]) setTimeout(() => window.dispatchEvent(new Event('resize')), ms);
    });

    // Restore Reading mode on phones (silently: the score has not loaded yet, so there is nothing to refit)
    try { if (narrow() && localStorage.getItem(READING_MODE_KEY) === '1') gamepadManager.toggleTopBar(true, { silent: true }); } catch { /* storage blocked */ }

    $('readingDockBtn')?.addEventListener('click', () => gamepadManager.toggleTopBar());
}
