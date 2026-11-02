// settingsPage.js
// Settings as a page: a title, a section list (Player, Appearance, Reading, Controls, Sound, Library and backup,
// About) and grouped rows (title, one line of help, the control). The controls are the ones already in the
// settings markup, moved into rows, so their ids and handlers keep working. Things you change while playing
// (size, paper, pages) live in the reader's View menu, not here.

const $ = (id) => document.getElementById(id);

const SECTIONS = [
    { id: 'player', label: 'Player', icon: 'bi-person' },
    { id: 'appearance', label: 'Appearance', icon: 'bi-palette' },
    { id: 'reading', label: 'Reading', icon: 'bi-book' },
    { id: 'controls', label: 'Controls', icon: 'bi-controller' },
    { id: 'sound', label: 'Sound', icon: 'bi-soundwave' },
    { id: 'library', label: 'Library and backup', icon: 'bi-collection' },
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

/** A switch row whose state mirrors an existing menu item (role menuitemcheckbox) and which clicks it. */
function proxySwitch(sourceId) {
    const src = $(sourceId);
    if (!src) return null;
    const sw = el('input', 'form-check-input theme-switch');
    sw.type = 'checkbox';
    const read = () => { sw.checked = src.getAttribute('aria-checked') === 'true'; };
    read();
    sw.addEventListener('change', () => { src.click(); setTimeout(read, 0); });
    new MutationObserver(read).observe(src, { attributes: true, attributeFilter: ['aria-checked'] });
    const wrap = el('div', 'form-check form-switch mb-0');
    wrap.appendChild(sw);
    return wrap;
}

function proxyButton(label, targetId, className = 'btn btn-sm btn-theme-outline') {
    const b = el('button', className);
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', () => $(targetId)?.click());
    return b;
}

export function initSettingsPage() {
    const panel = $('fileMenu');
    const body = panel?.querySelector('.offcanvas-body');
    if (!panel || !body || panel.dataset.pageBuilt) return;
    panel.dataset.pageBuilt = '1';

    // ---- gather the existing controls before the old cards are taken apart ----
    const take = (id) => $(id);
    const instrumentGroup = take('instrumentModeGuitar')?.closest('.hud-pill-group');
    const finishBlock = take('drawerThemeSwatch')?.closest('.d-flex.align-items-center.justify-content-between');
    const finishChange = finishBlock?.querySelector('button');
    const swatch = take('drawerThemeSwatch');
    const themeName = take('drawerThemeName');
    const defaultsBtn = take('defaultsModalBtn');
    const keysBtn = take('openControllerHelpMenuBtn');
    const convertersBtn = take('openExtensions');
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
    const openFile = take('openFileMenuBtn');
    const clearCache = take('clearCacheBtn');
    const deleteAll = take('deleteAllDataBtn');

    // ---- build the page ----
    const shell = el('div', 'setshell');
    const head = el('div', 'sethead');
    head.innerHTML = '<h1>Settings</h1><p>Set these once. What you change while playing is in the reader’s View menu.</p>';
    const wrap = el('div', 'setwrap');
    wrap.dataset.pane = 'list';
    const nav = el('nav', 'setnav');
    nav.setAttribute('aria-label', 'Settings sections');
    const page = el('div', 'setpage');
    const back = el('button', 'btn btn-sm setback');
    back.type = 'button';
    back.innerHTML = '<i class="bi-chevron-left"></i> Settings';
    page.appendChild(back);
    const panes = {};
    SECTIONS.forEach((s) => {
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
        panes.player.appendChild(group('Who is playing',
            row('I play', 'Guitar or bass. Sets the instrument the app assumes.', instrumentGroup)));
    }

    // Appearance
    if (finishChange) {
        const sc = el('div', 'fin-ctl');
        if (swatch) sc.appendChild(swatch);
        if (themeName) {
            themeName.classList.remove('small', 'text-white');
            sc.appendChild(themeName);
        }
        finishChange.classList.add('btn-theme-outline');
        panes.appearance.appendChild(group('Finish', row('Guitar finish', 'Nine finishes, each a flat colour ground and two hues.', sc, finishChange)));
    }

    // Reading
    if (defaultsBtn) {
        defaultsBtn.classList.remove('w-100', 'py-2');
        defaultsBtn.classList.add('btn-sm');
        panes.reading.appendChild(group('New tabs',
            row('Defaults', 'How a tab opens the first time: layout, strings and notation.', defaultsBtn)));
        panes.reading.appendChild(note('Size, paper and pages shown are in the reader’s View menu, next to the score.'));
    }

    // Controls
    const ctl = [];
    if (keysBtn) { keysBtn.classList.remove('w-50', 'py-2'); keysBtn.classList.add('btn-sm'); ctl.push(row('Keys, pedals and gamepad', 'See and test what each key, foot pedal or button does.', keysBtn)); }
    if (convertersBtn) { convertersBtn.classList.remove('w-50', 'py-2'); convertersBtn.classList.add('btn-sm'); ctl.push(row('File converters', 'Extensions that open other tab formats and import from websites.', convertersBtn)); }
    if (ctl.length) panes.controls.appendChild(group('Input', ...ctl));

    // Sound
    const dockSwitch = proxySwitch('dockToggleBtn');
    const soundRows = [];
    if (dockSwitch) soundRows.push(row('Playback controls dock', 'Keep the transport at the bottom of the reader.', dockSwitch));
    if ($('soundFontModalBtn')) soundRows.push(row('SoundFonts', 'Choose and manage the instrument sounds.', proxyButton('Manage', 'soundFontModalBtn')));
    if ($('mixerModalBtn')) soundRows.push(row('Mixer', 'Volume, pan, mute and solo for each track.', proxyButton('Open', 'mixerModalBtn')));
    if ($('latencyModalBtn')) soundRows.push(row('Audio latency', 'Delay the cursor to match Bluetooth speakers.', proxyButton('Adjust', 'latencyModalBtn')));
    if (soundRows.length) panes.sound.appendChild(group('Playback', ...soundRows));

    // Library and backup
    const lib = [];
    if (syncBtn) {
        syncBtn.classList.remove('w-100', 'py-2', 'mb-1');
        syncBtn.classList.add('btn-sm');
        const r = row('Sync', 'Keep this device and your backup location matching.', syncBtn);
        if (syncStatus) r.querySelector('.st').appendChild(syncStatus);
        lib.push(r);
    }
    if (backupBtn && restoreBtn) {
        const pair = el('div', 'd-flex gap-2');
        [backupBtn, restoreBtn].forEach((b) => { b.classList.add('btn-sm'); b.classList.remove('py-2'); pair.appendChild(b); });
        pair.style.gridTemplateColumns = '';
        lib.push(row('Backup and restore', 'Save everything to a file or your cloud, or bring it back.', pair));
    }
    if (lib.length) panes.library.appendChild(group('Your data', ...lib));
    if (moreData) {
        moreData.open = false;
        const inner = moreData.querySelector('.d-flex.flex-column');
        // Destructive actions get their own group, with a second press to confirm (the modal still asks)
        const dangerRows = [];
        if (clearCache) { clearCache.classList.add('btn-theme-danger'); clearCache.classList.remove('btn-theme-outline'); dangerRows.push(row('Clear cached data', 'Covers and downloads, kept only to load faster.', clearCache)); }
        if (deleteAll) { deleteAll.classList.add('btn-theme-danger'); deleteAll.classList.remove('btn-theme-outline'); dangerRows.push(row('Delete all data', 'Removes your library, setlists and settings from this device.', deleteAll)); }
        const more = el('div', 'sgroup');
        more.appendChild(moreData);
        panes.library.appendChild(more);
        if (dangerRows.length) {
            const g = group('Danger zone', ...dangerRows);
            g.classList.add('danger');
            panes.library.appendChild(g);
        }
        inner?.classList.add('gap-2');
    }

    // About
    const abt = [];
    if (updates) { updates.hidden = updates.hidden; abt.push(updates); }
    if (aboutBtn) { aboutBtn.className = 'btn btn-sm btn-theme-outline'; aboutBtn.innerHTML = 'About MajesticTab'; abt.push(row('About', 'Version, credits and licences.', aboutBtn)); }
    if (privacy) { privacy.className = 'btn btn-sm btn-theme-outline'; privacy.textContent = 'Read'; abt.push(row('Privacy policy', 'What stays on your device.', privacy)); }
    if (support) { support.className = 'btn btn-sm btn-theme-outline'; support.textContent = 'Report'; abt.push(row('Support', 'Report a problem or ask for a feature.', support)); }
    if (abt.length) panes.about.appendChild(group('MajesticTab', ...abt));
    if (quitBtn) {
        quitBtn.className = 'btn btn-sm btn-theme-danger';
        quitBtn.textContent = 'Quit';
        const g = group('', row('Quit MajesticTab', 'Close the app.', quitBtn));
        g.classList.add('danger');
        panes.about.appendChild(g);
        $('fileMenuFooter')?.remove();
    }

    // ---- put it together; the old cards are emptied of their controls and removed ----
    wrap.appendChild(nav);
    wrap.appendChild(page);
    shell.appendChild(head);
    shell.appendChild(wrap);
    const openFileRow = openFile;
    body.querySelectorAll(':scope > .settings-card, :scope > #secondaryUtilities, :scope > .mt-auto').forEach((n) => n.remove());
    openFileRow?.remove();
    body.appendChild(shell);

    function show(id, { focus = false } = {}) {
        nav.querySelectorAll('button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.section === id)));
        Object.entries(panes).forEach(([k, p]) => { p.hidden = k !== id; });
        wrap.dataset.pane = 'page';
        wrap.dataset.section = id;
        if (focus) page.scrollTop = 0;
    }
    nav.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-section]');
        if (b) show(b.dataset.section, { focus: true });
    });
    back.addEventListener('click', () => { wrap.dataset.pane = 'list'; });
    // Wide: a section is always showing. Narrow: start on the list.
    const wide = () => window.matchMedia('(min-width: 900px)').matches;
    show('player');
    if (!wide()) wrap.dataset.pane = 'list';
    window.matchMedia('(min-width: 900px)').addEventListener?.('change', (e) => { if (e.matches && wrap.dataset.pane === 'list') wrap.dataset.pane = 'page'; });

    // Settings is a page wherever it opens from
    panel.addEventListener('show.bs.offcanvas', () => { document.body.classList.add('settings-as-page'); if (!wide()) wrap.dataset.pane = 'list'; });
    panel.addEventListener('hidden.bs.offcanvas', () => document.body.classList.remove('settings-as-page'));
}
