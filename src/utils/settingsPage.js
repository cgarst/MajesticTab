// settingsPage.js
// Settings as a page: a title, a section list (Player, Appearance, Reading, Controls, Sound, Library and backup,
// About) and grouped rows (title, one line of help, the control). The controls are the ones already in the
// settings markup, moved into rows, so their ids and handlers keep working. Things you change while playing
// (size, paper, pages) live in the reader's View menu, not here. Notation and the usual guitar are defaults here; the
// reader's View and Guitar panels override them for the song that is open.

import { getDefaultGpNotationMode, setGpNotationMode } from '../gpProcessor/gpProcessor.js';
import { brandMarkSvg } from '../brandMark.js';
import { canQuitApp } from './quitApp.js';
import { isNative } from '../tabDownloader.js';
import { initWebSearchSettings } from './webSearchSettings.js';
import { isHideNoTabSongsEnabled, setHideNoTabSongsEnabled } from '../libraryModal.js';

const $ = (id) => document.getElementById(id);

const SECTIONS = [
    { id: 'player', label: 'Player', icon: 'bi-person' },
    { id: 'appearance', label: 'Appearance', icon: 'bi-palette' },
    { id: 'reading', label: 'Reading', icon: 'bi-book' },
    { id: 'controls', label: 'Controls', icon: 'bi-controller' },
    { id: 'websearch', label: 'Web search', icon: 'bi-globe2', nativeOnly: true },
    { id: 'sound', label: 'Sound', icon: 'bi-soundwave' },
    { id: 'library', label: 'Library and backup', icon: 'bi-collection' },
    { id: 'updates', label: 'Updates', icon: 'bi-arrow-repeat' },
    { id: 'about', label: 'About', icon: 'bi-info-circle' }
];

function el(tag, className, html) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (html !== undefined) node.innerHTML = html;
    return node;
}

function row(title, help, ...controls) {
    const r = el('div', 'srow');
    const text = el('div', 'st');
    text.appendChild(el('b', '', title));
    if (help) text.appendChild(el('span', '', help));
    r.appendChild(text);
    const sc = el('div', 'sc');
    controls.filter(Boolean).forEach((c) => sc.appendChild(c));
    r.appendChild(sc);
    return r;
}

function group(title, ...children) {
    const g = el('div', 'sgroup');
    if (title) g.appendChild(el('h3', '', title));
    const rows = el('div', 'srows');
    children.filter(Boolean).forEach((c) => rows.appendChild(c));
    g.appendChild(rows);
    return g;
}

function note(text) {
    return el('p', 'snote', text);
}


// ---- Defaults for every song: notation, and the usual guitar ----
function makeNotationDefault() {
    let current = getDefaultGpNotationMode();
    const seg = el('div', 'hud-pill-group');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', 'Notation');
    [['Tab only', 'tab'], ['Tab and standard', 'scoreTab']].forEach(([label, val]) => {
        const b = el('button', 'btn btn-sm' + (val === current ? ' active' : ''));
        b.type = 'button';
        b.textContent = label;
        b.addEventListener('click', () => {
            current = val;
            setGpNotationMode(val);
            seg.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
        });
        seg.appendChild(b);
    });
    return seg;
}

// ---- Neck preferences: one place for the fretboard dock and the reference library's chord diagrams ----
const LH_KEY = 'majestictab_fretboard_left_handed';
const FLIP_KEY = 'majestictab_fretboard_flip_strings';

function readFlag(key, defaultVal = false) {
    try {
        const v = localStorage.getItem(key);
        return v === null ? defaultVal : v === 'true';
    } catch (_) {
        return defaultVal;
    }
}

async function applyNeckFlag(kind, value) {
    try {
        const { fretboardController } = await import('../fretboard/fretboardController.js');
        if (kind === 'lh') fretboardController.setLeftHanded(value); else fretboardController.setFlipped(value);
    } catch (_) { /* the fretboard may not be loaded; the stored value is read the next time it opens */ }
    try {
        const ref = await import('../referenceLibrary.js');
        if (kind === 'lh') ref.setIsLeftHanded(value); else ref.setIsFlipped(value);
    } catch (_) {}
}

function makeLeftHandedRow() {
    const sw = el('input', 'form-check-input theme-switch');
    sw.type = 'checkbox';
    sw.checked = readFlag(LH_KEY, false);
    sw.setAttribute('aria-label', 'Left-handed guitar');
    sw.addEventListener('change', () => applyNeckFlag('lh', sw.checked));
    const wrap = el('div', 'form-check form-switch mb-0');
    wrap.appendChild(sw);
    return row('Left-handed guitar', 'Flips the fretboard and chord diagrams for a left-handed guitar.', wrap);
}

function makeStringingRow() {
    let flipped = readFlag(FLIP_KEY, false);
    const seg = el('div', 'hud-pill-group');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', 'Stringing');
    [['Standard', false], ['Upside down', true]].forEach(([label, val]) => {
        const b = el('button', 'btn btn-sm' + (val === flipped ? ' active' : ''));
        b.type = 'button';
        b.textContent = label;
        b.addEventListener('click', () => {
            flipped = val;
            seg.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
            applyNeckFlag('flip', val);
        });
        seg.appendChild(b);
    });
    return row('Stringing', 'Standard puts the high string on top, as in tab; upside down puts the low string on top.', seg);
}

function proxyButton(label, targetId, className = 'btn btn-sm btn-theme-outline') {
    const b = el('button', className);
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', () => $(targetId)?.click());
    return b;
}

function makeHideNoTabSongsRow() {
    const sw = el('input', 'form-check-input theme-switch');
    sw.type = 'checkbox';
    sw.id = 'hideNoTabSongsSwitch';
    sw.checked = isHideNoTabSongsEnabled();
    sw.setAttribute('aria-label', 'Hide songs without tabs');
    sw.addEventListener('change', () => {
        setHideNoTabSongsEnabled(sw.checked);
        window.dispatchEvent(new CustomEvent('library:refresh'));
    });
    const wrap = el('div', 'form-check form-switch mb-0');
    wrap.appendChild(sw);
    const r = row('Hide songs without tabs', 'Only show songs in the library that have at least one tab attached.', wrap);
    r.style.cursor = 'pointer';
    r.addEventListener('click', (e) => {
        if (e.target !== sw) {
            sw.checked = !sw.checked;
            sw.dispatchEvent(new Event('change', { bubbles: true }));
        }
    });
    return r;
}

export function initSettingsPage() {
    const panel = $('fileMenu');
    const body = panel?.querySelector('.page-body');
    if (!panel || !body || panel.dataset.pageBuilt) return;
    panel.dataset.pageBuilt = '1';

    // ---- gather the existing controls before the old cards are taken apart ----
    const take = (id) => $(id);
    const instrumentGroup = take('instrumentModeGuitar')?.closest('.hud-pill-group');
    const finishGrid = take('themeModalGrid');
    const finishCurrent = take('finishCurrent');
    const swatch = take('drawerThemeSwatch');
    const themeName = take('drawerThemeName');
    const defaultsBtn = take('defaultsModalBtn');
    const syncBtn = take('syncDataBtn');
    const syncStatus = take('syncStatusLine');
    const backupBtn = take('backupDataBtn');
    const restoreBtn = take('restoreDataBtn');
    const moreData = body.querySelector('.settings-advanced-details');
    const updates = take('updateSettingsCard');
    const quitBtn = take('menuQuitAppBtn');
    const aboutBtn = take('aboutModalBtn');
    const privacy = body.querySelector('a[href*="privacy"]');
    const support = body.querySelector('a[href*="issues"]');
    const clearCache = take('clearCacheBtn');
    const deleteAll = take('deleteAllDataBtn');

    // ---- build the page ----
    const shell = el('div', 'setshell');
    shell.dataset.pane = 'list';
    const head = el('div', 'sethead');
    head.setAttribute('data-tauri-drag-region', '');
    const back = el('button', 'btn btn-sm setback');
    back.type = 'button';
    back.setAttribute('aria-label', 'Back to Settings');
    back.innerHTML = '<i class="bi-chevron-left" aria-hidden="true"></i> <span>Settings</span>';
    const sectionTitle = el('h2', 'sethead-section');
    sectionTitle.setAttribute('data-tauri-drag-region', '');
    head.appendChild(back);
    head.appendChild(sectionTitle);
    const wrap = el('div', 'setwrap');
    wrap.dataset.pane = 'list';
    const nav = el('nav', 'setnav');
    nav.setAttribute('aria-label', 'Settings sections');
    const page = el('div', 'setpage');
    const panes = {};
    SECTIONS.forEach((s) => {
        if (s.nativeOnly && !isNative()) return;
        const b = el('button', '', `<i class="${s.icon}" aria-hidden="true"></i><span>${s.label}</span><i class="bi-chevron-right chev" aria-hidden="true"></i>`);
        b.type = 'button';
        b.dataset.section = s.id;
        nav.appendChild(b);
        const p = el('section', 'setsec');
        p.dataset.section = s.id;
        p.hidden = true;
        page.appendChild(p);
        panes[s.id] = p;
    });

    // Player
    if (instrumentGroup) {
        instrumentGroup.classList.remove('w-100');
        instrumentGroup.querySelectorAll('i').forEach((ic) => ic.remove());
        panes.player.appendChild(group('Who is playing',
            row('Preferred instrument', 'Sets the instrument the app assumes.', instrumentGroup)));
    }
    panes.player.appendChild(group('Your instrument', makeLeftHandedRow(), makeStringingRow()));

    // Appearance
    if (finishGrid) {
        const sc = el('div', 'fin-ctl');
        if (swatch) sc.appendChild(swatch);
        if (themeName) sc.appendChild(themeName);
        finishCurrent?.remove();
        panes.appearance.appendChild(group('Theme', row('App theme', 'Pick the color theme for the app.', sc)));
        const g = el('div', 'sgroup');
        g.appendChild(finishGrid);
        panes.appearance.appendChild(g);
    }

    // Reading: how a new tab opens. The defaults modal's own rows live here now, so there is no second Settings
    if (defaultsBtn) {
        const defaultsModal = $('defaultsModal');
        const defaultRows = (title, sectionIndex, helps) => {
            const sec = defaultsModal?.querySelectorAll('.defaults-section')[sectionIndex];
            if (!sec) return null;
            const rows = [...sec.querySelectorAll('.defaults-row')].map((r, i) => {
                const label = r.querySelector('.defaults-row-label')?.textContent.trim() || '';
                const pills = r.querySelector('.defaults-pills');
                pills?.querySelectorAll('i').forEach((ic) => ic.remove());
                return row(label, helps[i] || '', pills);
            });
            return group(title, ...rows);
        };
        const viewGroup = defaultRows('A new tab opens as', 0, ['', '', '']);
        const stringGroup = defaultRows('Default strings', 1, [
            'Always show 6 strings, or 7 or 8 for extended range guitars. "From file" keeps what the tab was saved with.',
            'Always show 4 strings, or 5 or 6 for extended range basses.'
        ]);
        if (viewGroup) panes.reading.appendChild(viewGroup);
        panes.reading.appendChild(group('Notation', row('A new tab shows', 'Tab only, or tab with the standard staff above it. Change it for one song in View.', makeNotationDefault())));
        if (stringGroup) panes.player.appendChild(stringGroup);
        const resetBtn = $('defaultsResetBtn');
        if (resetBtn) {
            resetBtn.className = 'btn btn-sm srow-ghost';
            resetBtn.textContent = 'Reset';
            panes.reading.appendChild(group('', row('Reset these defaults', 'Back to Scroll for score and text, Page for PDF, and default string counts from the file (in Player).', resetBtn)));
        }
        defaultsBtn.remove();
        defaultsModal?.remove();
        panes.reading.appendChild(note('Size, paper and pages shown are in the reader’s View menu, next to the score.'));

        const makeMinBarsSelector = () => {
            let current = 4;
            try {
                const stored = parseInt(localStorage.getItem('majestictab.sectionMinBars'), 10);
                if ([1, 2, 4, 8].includes(stored)) current = stored;
            } catch (_) {}
            const seg = el('div', 'hud-pill-group');
            seg.setAttribute('role', 'radiogroup');
            seg.setAttribute('aria-label', 'Minimum section size');
            [1, 2, 4, 8].forEach(val => {
                const b = el('button', 'btn btn-sm' + (val === current ? ' active' : ''));
                b.type = 'button';
                b.textContent = `${val} ${val === 1 ? 'bar' : 'bars'}`;
                b.addEventListener('click', () => {
                    try { localStorage.setItem('majestictab.sectionMinBars', String(val)); } catch (_) {}
                    seg.querySelectorAll('button').forEach(btn => btn.classList.remove('active'));
                    b.classList.add('active');
                    window.dispatchEvent(new Event('resize'));
                });
                seg.appendChild(b);
            });
            return seg;
        };
        panes.reading.appendChild(group('Song sections', row('Minimum section size', 'Shorter labeled sections are joined with adjacent parts.', makeMinBarsSelector())));
    }

    // Controls: the key, pedal and gamepad reference lives in the page, not in a popup
    const controlsRef = take('controllerHelpModal');
    if (controlsRef) {
        const g = el('div', 'sgroup');
        g.appendChild(el('h3', '', 'Keys, pedals and gamepad'));
        g.appendChild(el('p', 'snote', 'What each key, foot pedal or controller button does.'));
        g.appendChild(controlsRef);
        panes.controls.appendChild(g);
    }

    // Web search: adblocking and tab search providers (native clients only)
    if (panes.websearch) {
        initWebSearchSettings(panes.websearch);
    }

    // Sound
    const soundRows = [];
    if ($('soundFontModalBtn')) soundRows.push(row('SoundFonts', 'Choose and manage the instrument sounds.', proxyButton('Manage', 'soundFontModalBtn')));
    if ($('latencyModalBtn')) soundRows.push(row('Audio latency', 'Delay the cursor to match Bluetooth speakers.', proxyButton('Adjust', 'latencyModalBtn')));
    if (soundRows.length) panes.sound.appendChild(group('Playback', ...soundRows));

    // Library and backup
    // The data tasks are rows like every other setting. Choosing one opens it in place under its row, and only one
    // is open at a time. They are the same screens the old popup had.
    const taskRow = (tab, title, help, label, danger, name = title) => {
        const isSync = tab === 'sync';
        // The verb is the visible action; the button stretches over its row so the whole row is the target
        const btn = el('button', 'btn btn-sm srow-ghost srow-hit' + (danger ? ' is-danger' : ''), label);
        btn.type = 'button';
        btn.dataset.label = label;
        btn.setAttribute('aria-label', name);
        btn.setAttribute('aria-expanded', 'false');
        // The first open reads every stored tab once; start that as soon as the pointer is near
        const warm = () => import('../fileStore.js').then((m) => m.prewarmStoredFiles()).catch(() => {});
        btn.addEventListener('pointerenter', warm, { once: true });
        btn.addEventListener('focus', warm, { once: true });
        const slot = el('div', 'data-task-slot');
        slot.dataset.task = tab;
        slot.hidden = true;
        btn.addEventListener('click', async () => {
            if (isSync) {
                const sync = await import('../syncUi.js');
                return btn.getAttribute('aria-expanded') === 'true' ? sync.closeSyncModal() : sync.openSyncModal();
            }
            const mod = await import('../backupRestore.js');
            if (btn.getAttribute('aria-expanded') === 'true') mod.closeBackupModal();
            else mod.openBackupModal(tab);
        });
        const r = row(title, help, btn);
        r.classList.add('srow-task');
        return [r, slot];
    };
    const taskGroup = (title, ...tasks) => {
        const g = group(title, ...tasks.flat());
        return g;
    };
    const syncTask = taskRow('sync', 'Sync', 'Keep this device and your backup location matching.', 'Sync');
    if (syncStatus) syncTask[0].querySelector('.st').appendChild(syncStatus);
    panes.library.appendChild(group('Library', makeHideNoTabSongsRow()));
    panes.library.appendChild(group('Sync', ...syncTask));
    panes.library.appendChild(taskGroup('Back up and restore',
        ...[taskRow('backup', 'Create a backup', 'Save everything to a file, a folder or your cloud.', 'Create'),
            taskRow('restore', 'Restore from a backup', 'Bring a backup or snapshot back.', 'Restore')]));
    panes.library.appendChild(taskGroup('Upkeep',
        ...[taskRow('reload', 'Reload library metadata', 'Refresh covers, durations and album details.', 'Reload'),
            taskRow('orphans', 'Orphaned files', 'Find stored tabs that no library song uses.', 'Review', false, 'Review orphaned files')]));
    const danger = taskGroup('Danger zone',
        ...[taskRow('cache', 'Clear cached data', 'Covers and downloads, kept only to load faster.', 'Clear', true),
            taskRow('delete', 'Delete all data', 'Removes your library, setlists and settings from this device.', 'Delete', true)]);
    danger.classList.add('danger');
    panes.library.appendChild(danger);
    // keep the originals referenced so their ids stay unique if anything still looks them up
    void syncBtn; void moreData; void clearCache; void deleteAll; void backupBtn; void restoreBtn;

    // Updates: its own section above About. The card is kept as the container because updater.js shows it
    // (self-updating builds) or removes it (store builds); the section follows it.
    if (updates) {
        const channelGroup = updates.querySelector('.hud-pill-group');
        channelGroup?.classList.remove('w-100', 'mb-2');
        channelGroup?.querySelectorAll('label').forEach((l) => l.classList.remove('w-33'));
        const checkBtn = $('updateCheckBtn');
        const status = $('updateStatus');
        if (checkBtn) { checkBtn.className = 'btn btn-sm srow-ghost srow-hit'; checkBtn.textContent = 'Check'; checkBtn.setAttribute('aria-label', 'Check for updates'); }
        const checkRow = row('Check for updates', 'Look for a newer version now.', checkBtn);
        checkRow.classList.add('srow-task');
        if (status) { status.className = 'small text-white-50 mt-1'; checkRow.querySelector('.st').appendChild(status); }
        updates.className = '';
        updates.removeAttribute('style');
        updates.replaceChildren(group('App updates',
            row('Update channel', 'None turns automatic checks off. Canary gets early builds.', channelGroup),
            checkRow));
        panes.updates.appendChild(updates);
    }

    // About
    const abt = [];
    if (aboutBtn) { aboutBtn.className = 'btn btn-sm btn-theme-outline'; aboutBtn.innerHTML = 'About MajesticTab'; abt.push(row('About', 'Credits and licences.', aboutBtn)); }
    if (privacy) { privacy.className = 'btn btn-sm btn-theme-outline'; privacy.textContent = 'Read'; abt.push(row('Privacy policy', 'What stays on your device.', privacy)); }
    if (support) { support.className = 'btn btn-sm btn-theme-outline'; support.textContent = 'Report'; abt.push(row('Support', 'Report a problem or ask for a feature.', support)); }
    if (quitBtn && canQuitApp()) {
        // Quitting is not destructive: a plain row at the end of the list, not a colored button or its own group
        quitBtn.className = 'btn btn-sm btn-theme-outline';
        quitBtn.textContent = 'Quit';
        abt.push(row('Quit', 'Close MajesticTab.', quitBtn));
    }
    $('fileMenuFooter')?.remove();
    const brand = el('div', 'about-brand', brandMarkSvg('about-mark') + '<span class="about-wordmark">Majestic<b>Tab</b></span>');
    panes.about.appendChild(brand);
    if (abt.length) {
        const aboutGroup = group('', ...abt);
        panes.about.appendChild(aboutGroup);
        // The version is the first row. Only the native apps carry build-info.js; the web build has no row.
        import('../build-info.js').then(async ({ default: info }) => {
            const { formatBuildVersion } = await import('../updater.js');
            const v = el('span', 'small text-white-50', formatBuildVersion(info));
            aboutGroup.querySelector('.srows')?.prepend(row('Version', '', v));
        }).catch(() => {});
    }

    // ---- put it together; the old cards are emptied of their controls and removed ----
    wrap.appendChild(nav);
    wrap.appendChild(page);
    shell.appendChild(head);
    shell.appendChild(wrap);
    body.querySelectorAll(':scope > .settings-card, :scope > #secondaryUtilities, :scope > .mt-auto').forEach((n) => n.remove());
    body.appendChild(shell);

    // The Updates entry shows only while the update card is there and visible
    const updatesNav = nav.querySelector('button[data-section="updates"]');
    const syncUpdatesNav = () => { if (updatesNav) updatesNav.hidden = !updates || !updates.isConnected || updates.hidden; };
    syncUpdatesNav();
    if (updates) {
        const watch = new MutationObserver(syncUpdatesNav);
        watch.observe(updates, { attributes: true, attributeFilter: ['hidden'] });
        watch.observe(panes.updates, { childList: true });
    }

    function show(id, { focus = false } = {}) {
        if (!panes[id]) return;
        const sec = SECTIONS.find((s) => s.id === id);
        if (sec) sectionTitle.textContent = sec.label;
        nav.querySelectorAll('button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.section === id)));
        Object.entries(panes).forEach(([k, p]) => { p.hidden = k !== id; });
        wrap.dataset.pane = 'page';
        shell.dataset.pane = 'page';
        wrap.dataset.section = id;
        shell.dataset.section = id;
        // The data screens count every stored tab; read them while the page is being looked at
        if (id === 'library') (window.requestIdleCallback || setTimeout)(() => import('../fileStore.js').then((m) => m.prewarmStoredFiles()).catch(() => {}));
        if (focus) page.scrollTop = 0;
    }
    nav.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-section]');
        if (b) show(b.dataset.section, { focus: true });
    });
    // Other code can open a section: panel.dispatchEvent(new CustomEvent('settings:section', { detail: 'appearance' }))
    panel.addEventListener('settings:section', (e) => show(e.detail, { focus: true }));
    back.addEventListener('click', () => {
        wrap.dataset.pane = 'list';
        shell.dataset.pane = 'list';
    });
    // Wide: a section is always showing. Narrow: start on the list.
    const wide = () => window.matchMedia('(min-width: 900px)').matches;
    show('player');
    if (!wide()) {
        wrap.dataset.pane = 'list';
        shell.dataset.pane = 'list';
    }
    window.matchMedia('(min-width: 900px)').addEventListener?.('change', (e) => {
        if (e.matches && wrap.dataset.pane === 'list') {
            wrap.dataset.pane = 'page';
            shell.dataset.pane = 'page';
        }
    });

    // Settings is a page wherever it opens from
    panel.addEventListener('settings:show', () => {
        if (!wide()) {
            wrap.dataset.pane = 'list';
            shell.dataset.pane = 'list';
        }
    });
}
