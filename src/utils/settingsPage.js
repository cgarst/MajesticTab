// settingsPage.js
// Settings as a page: a title, a section list (Player, Appearance, Reading, Controls, Sound, Library and backup,
// About) and grouped rows (title, one line of help, the control). The controls are the ones already in the
// settings markup, moved into rows, so their ids and handlers keep working. Things you change while playing
// (size, paper, pages) live in the reader's View menu, not here. Notation and the usual guitar are defaults here; the
// reader's View and Guitar panels override them for the song that is open.

import { getDefaultGpNotationMode, setGpNotationMode } from '../gpProcessor/gpProcessor.js';
import { getUsualGuitar, setUsualGuitar, getAdaptTuningOptions } from './tabAdapter.js';
import { getInstrumentMode } from './tuningUtils.js';

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

/** Tuning, method and capo of the guitar every song opens on. "As written" means no fit. */
function makeUsualGuitar() {
    const wrap = el('div', 'usual-guitar');
    const usual = getUsualGuitar();
    const select = el('select', 'form-select form-select-sm');
    select.setAttribute('aria-label', 'Usual tuning');
    select.innerHTML = '<option value="">As written</option>' + getAdaptTuningOptions(getInstrumentMode())
        .map((t) => `<option value="${t.shortName}"${usual?.tuningName === t.shortName ? ' selected' : ''}>${t.name}</option>`).join('');
    const method = el('select', 'form-select form-select-sm');
    method.setAttribute('aria-label', 'How to fit');
    [['shift', 'Shift frets'], ['capo', 'Capo'], ['transpose', 'Transpose']].forEach(([v, label]) => {
        const o = el('option'); o.value = v; o.textContent = label; if ((usual?.method || 'shift') === v) o.selected = true; method.appendChild(o);
    });
    const save = () => {
        method.disabled = !select.value;
        setUsualGuitar(select.value ? { enabled: true, tuningName: select.value, method: method.value, capo: 'auto' } : null);
    };
    select.addEventListener('change', save);
    method.addEventListener('change', save);
    method.disabled = !select.value;
    wrap.append(select, method);
    return wrap;
}

// ---- Neck preferences: one place for the fretboard dock and the reference library's chord diagrams ----
const LH_KEY = 'majestictab_fretboard_left_handed';
const FLIP_KEY = 'majestictab_fretboard_flip_strings';

function readFlag(key) {
    try { return localStorage.getItem(key) === 'true'; } catch (_) { return false; }
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
    sw.checked = readFlag(LH_KEY);
    sw.setAttribute('aria-label', 'Left-handed neck');
    sw.addEventListener('change', () => applyNeckFlag('lh', sw.checked));
    const wrap = el('div', 'form-check form-switch mb-0');
    wrap.appendChild(sw);
    return row('Left-handed neck', 'Mirror the fretboard and the chord diagrams.', wrap);
}

function makeStringOrderRow() {
    let flipped = readFlag(FLIP_KEY);
    const seg = el('div', 'hud-pill-group');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', 'String order');
    [['High string on top', false], ['Low string on top', true]].forEach(([label, val]) => {
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
    return row('String order', 'Tab view puts the high string on top; player view puts the low string on top.', seg);
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
    panes.player.appendChild(group('Your neck', makeLeftHandedRow(), makeStringOrderRow()));

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
        const stringGroup = defaultRows('Usual strings', 1, ['Show 6 strings, or 7 or 8 for extended range guitars. "From file" keeps what the tab was saved with.', 'Show 4 strings, or 5 or 6 for extended range basses.']);
        if (viewGroup) panes.reading.appendChild(viewGroup);
        panes.reading.appendChild(group('Notation', row('A new tab shows', 'Tab only, or tab with the standard staff above it. Change it for one song in View.', makeNotationDefault())));
        panes.reading.appendChild(group('Usual guitar', row('Every song opens fitted to', 'Pick the tuning of the guitar you normally play and songs in other tunings are re-fingered for it. Change it for one song in Guitar.', makeUsualGuitar())));
        if (stringGroup) panes.reading.appendChild(stringGroup);
        const resetBtn = $('defaultsResetBtn');
        if (resetBtn) {
            resetBtn.className = 'btn btn-sm btn-theme-outline';
            resetBtn.textContent = 'Reset';
            panes.reading.appendChild(group('', row('Reset these defaults', 'Back to Scroll for score and text, Page for PDF, and strings from the file.', resetBtn)));
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

    // Controls
    const ctl = [];
    if (keysBtn) { keysBtn.classList.remove('w-50', 'py-2'); keysBtn.classList.add('btn-sm'); ctl.push(row('Keys, pedals and gamepad', 'See and test what each key, foot pedal or button does.', keysBtn)); }
    if (convertersBtn) { convertersBtn.classList.remove('w-50', 'py-2'); convertersBtn.classList.add('btn-sm'); ctl.push(row('File converters', 'Extensions that open other tab formats and import from websites.', convertersBtn)); }
    if (ctl.length) panes.controls.appendChild(group('Input', ...ctl));

    // Sound
    const soundRows = [];
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
    // The data tasks are rows like every other setting. Choosing one opens it in place under its row, and only one
    // is open at a time. They are the same screens the old popup had.
    const taskRow = (tab, title, help, label, danger) => {
        const btn = el('button', 'btn btn-sm ' + (danger ? 'btn-theme-danger' : 'btn-theme-outline'), label);
        btn.type = 'button';
        btn.setAttribute('aria-expanded', 'false');
        const slot = el('div', 'data-task-slot');
        slot.dataset.task = tab;
        slot.hidden = true;
        btn.addEventListener('click', async () => {
            const mod = await import('../backupRestore.js');
            if (btn.getAttribute('aria-expanded') === 'true') mod.closeBackupModal();
            else mod.openBackupModal(tab);
        });
        return [row(title, help, btn), slot];
    };
    const taskGroup = (title, ...tasks) => {
        const g = group(title, ...tasks.flat());
        return g;
    };
    if (lib.length) panes.library.appendChild(group('Sync', ...lib));
    panes.library.appendChild(taskGroup('Back up and restore',
        ...[taskRow('backup', 'Create a backup', 'Save everything to a file, a folder or your cloud.', 'Open'),
            taskRow('restore', 'Restore from a backup', 'Bring a backup or snapshot back.', 'Open')]));
    panes.library.appendChild(taskGroup('Upkeep',
        ...[taskRow('reload', 'Reload library metadata', 'Refresh covers, durations and album details.', 'Open'),
            taskRow('orphans', 'Orphaned files', 'Find stored tabs that no library song uses.', 'Open')]));
    const danger = taskGroup('Danger zone',
        ...[taskRow('cache', 'Clear cached data', 'Covers and downloads, kept only to load faster.', 'Open', true),
            taskRow('delete', 'Delete all data', 'Removes your library, setlists and settings from this device.', 'Open', true)]);
    danger.classList.add('danger');
    panes.library.appendChild(danger);
    // keep the originals referenced so their ids stay unique if anything still looks them up
    void moreData; void clearCache; void deleteAll; void backupBtn; void restoreBtn;

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
