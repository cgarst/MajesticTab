// songTabPicker.js
// The one panel behind a library song row's tab actions: "Add tab" on a song with none, "2 tabs" on a song with
// several, and "Manage tabs" in the row menu. A floating panel beside the control on wide windows, a sheet above the
// tab bar on phones. The row itself never grows; the choice is made here, on demand.

const SHEET_QUERY = '(max-width: 576px)';
// Sources shown first, as the intent ("find it" or "I have it"); the rest sit under "More sources"
const PRIMARY_PROVIDERS = ['tab-downloader', 'local'];
const SOURCE_ORDER = ['google-drive', 'icloud-drive', 's3', 'webdav', 'url'];
const PROVIDER_LABELS = { 'tab-downloader': 'Search the web', local: 'Choose a file' };

let openPicker = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function closeSongTabPicker({ restoreFocus = true } = {}) {
    const p = openPicker;
    if (!p) return;
    openPicker = null;
    document.removeEventListener('keydown', p.onKey, true);
    document.removeEventListener('pointerdown', p.onOutside, true);
    window.removeEventListener('resize', p.onResize);
    p.anchor?.setAttribute?.('aria-expanded', 'false');
    p.root.classList.add('is-closing');
    p.scrim?.classList.add('is-closing');
    const done = () => { p.root.remove(); p.scrim?.remove(); };
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) done(); else setTimeout(done, 160);
    if (restoreFocus && p.anchor?.isConnected) p.anchor.focus({ preventScroll: true });
}

function placePanel(p) {
    const { root, anchor } = p;
    if (window.matchMedia(SHEET_QUERY).matches || !anchor?.isConnected) { root.style.cssText = ''; return; }
    const r = anchor.getBoundingClientRect();
    const w = root.offsetWidth || 320;
    const h = root.offsetHeight || 200;
    const left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
    const below = r.bottom + 4;
    const top = below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 4) : below;
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
}

/**
 * @param {Object} o
 * @param {Element} o.anchor        control that opened it (gets focus back and aria-expanded)
 * @param {Object}  o.song          { id, title, tabOptions, defaultTabId }
 * @param {'list'|'manage'|'add'} o.mode
 * @param {Array}   o.providers     [{ id, name }] sources, already filtered for this client
 * @param {function(tab):string} o.tabMeta   grey meta text for a tab (pages, tuning)
 * @param {function(tab):boolean} o.isSynced
 * @param {boolean} o.canEditRange  show "Edit pages" for album-PDF tabs in manage mode
 * @param {Object}  o.on            { openTab(tab), makeDefault(tabId), removeTab(tabId), editRange(tab), addFrom(providerId), listSongs(), moveTab(tabId, songId) }
 *                                  listSongs (optional) returns [{ id, title, artist, album }] to choose from; with it, manage mode offers "Move"
 */
export function openSongTabPicker(o) {
    closeSongTabPicker({ restoreFocus: false });
    const tabs = Array.isArray(o.song.tabOptions) ? o.song.tabOptions : [];
    const defaultId = o.song.defaultTabId || tabs[0]?.id || null;
    const startMode = tabs.length === 0 ? 'add' : o.mode;
    let mode = startMode;

    const root = document.createElement('div');
    root.className = 'tabpick';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', `Tabs for ${o.song.title}`);
    const isSheet = window.matchMedia(SHEET_QUERY).matches;
    const scrim = isSheet ? Object.assign(document.createElement('div'), { className: 'tabpick-scrim' }) : null;
    if (scrim) document.body.appendChild(scrim);
    document.body.appendChild(root);

    const p = { root, scrim, anchor: o.anchor };

    const sourceRow = (prov) => `<li><button type="button" class="tabpick-row" data-act="add" data-provider-id="${esc(prov.id)}">${esc(PROVIDER_LABELS[prov.id] || prov.name)}</button></li>`;

    function addView() {
        const byId = new Map(o.providers.map((x) => [x.id, x]));
        const primary = PRIMARY_PROVIDERS.map((id) => byId.get(id)).filter(Boolean);
        const more = SOURCE_ORDER.map((id) => byId.get(id)).filter(Boolean);
        const dropHint = window.matchMedia('(hover: hover) and (pointer: fine)').matches
            ? '<p class="tabpick-note">You can also drop a file on the song.</p>' : '';
        return `
          ${tabs.length ? '<div class="tabpick-bar"><button type="button" class="tabpick-back" data-act="back">Back</button></div>' : ''}
          ${isSheet ? `<h2 class="tabpick-title">${tabs.length ? 'Add another tab' : 'Add a tab'}</h2>` : ''}
          <ul class="tabpick-list">${primary.map(sourceRow).join('')}</ul>
          ${more.length ? `<p class="tabpick-label" id="tabpickMore">More sources</p><ul class="tabpick-list" aria-labelledby="tabpickMore">${more.map(sourceRow).join('')}</ul>` : ''}
          ${dropHint}`;
    }

    function listView() {
        const manage = mode === 'manage';
        return `
          ${isSheet ? `<h2 class="tabpick-title">${manage ? 'Manage tabs' : 'Tabs'}<span class="tabpick-sub"> · ${esc(o.song.title)}</span></h2>` : ''}
          <ul class="tabpick-list">
            ${tabs.map((t) => {
                const isDef = t.id === defaultId;
                const meta = o.tabMeta(t);
                const canRange = manage && o.canEditRange && Boolean(t.isAlbumRange || t.startPage);
                return `<li class="tabpick-item${isDef ? ' is-default' : ''}" data-tab-id="${esc(t.id)}">
                  <button type="button" class="tabpick-row tabpick-open" data-act="open" data-tab-id="${esc(t.id)}">
                    <span class="tabpick-name">${esc(t.name)}</span>
                    ${o.isSynced(t) ? '<span class="sync-dot" title="Synced audio" role="img" aria-label="Synced audio"></span>' : ''}
                    ${meta ? `<span class="tabpick-meta">${esc(meta)}</span>` : ''}
                  </button>
                  ${manage ? `
                    ${canRange ? `<button type="button" class="tabpick-act" data-act="range" data-tab-id="${esc(t.id)}">Edit pages</button>` : ''}
                    ${o.on.listSongs && o.on.moveTab ? `<button type="button" class="tabpick-act" data-act="move" data-tab-id="${esc(t.id)}">Move</button>` : ''}
                    <button type="button" class="tabpick-act tabpick-danger" data-act="remove" data-tab-id="${esc(t.id)}" data-name="${esc(t.name)}">Remove</button>`
                  : (isDef
                      ? '<span class="tabpick-state">Opens first</span>'
                      : `<button type="button" class="tabpick-act tabpick-makedef" data-act="default" data-tab-id="${esc(t.id)}" aria-label="Make ${esc(t.name)} the default tab">Make default</button>`)}
                </li>`;
            }).join('')}
          </ul>
          ${manage ? '' : '<div class="tabpick-foot"><button type="button" class="tabpick-row" data-act="more">Add another tab</button></div>'}`;
    }

    let moveTabId = null;
    let moveSongs = [];
    const songMeta = (x) => [x.artist, x.album].filter(Boolean).join(' \u00b7 ');
    function moveRows(query) {
        const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
        const hits = moveSongs.filter((x) => {
            const hay = `${x.title} ${x.artist || ''} ${x.album || ''}`.toLowerCase();
            return words.every((w) => hay.includes(w));
        });
        if (!hits.length) return '<li class="tabpick-note">No song matches.</li>';
        return hits.slice(0, 40).map((x) => `<li><button type="button" class="tabpick-row tabpick-song" data-act="moveto" data-song-id="${esc(x.id)}">
            <span class="tabpick-name">${esc(x.title)}</span>${songMeta(x) ? `<span class="tabpick-meta">${esc(songMeta(x))}</span>` : ''}</button></li>`).join('')
            + (hits.length > 40 ? '<li class="tabpick-note">Keep typing to narrow the list.</li>' : '');
    }
    function moveView() {
        const tab = tabs.find((t) => t.id === moveTabId);
        return `
          <div class="tabpick-bar"><button type="button" class="tabpick-back" data-act="back-manage">Back</button></div>
          <p class="tabpick-label" id="tabpickMoveLabel">Move ${esc(tab?.name || 'tab')} to</p>
          <input type="search" class="tabpick-search" aria-labelledby="tabpickMoveLabel" placeholder="Search songs" autocomplete="off" spellcheck="false">
          <ul class="tabpick-list" id="tabpickMoveList">${moveRows('')}</ul>`;
    }

    function paint(focusSel) {
        root.innerHTML = mode === 'add' ? addView() : mode === 'move' ? moveView() : listView();
        placePanel(p);
        const target = (focusSel && root.querySelector(focusSel)) || root.querySelector('.tabpick-row, .tabpick-back');
        target?.focus({ preventScroll: true });
    }

    async function onClick(e) {
        const btn = e.target.closest('[data-act]');
        if (!btn || !root.contains(btn)) return;
        const act = btn.dataset.act;
        const tab = tabs.find((t) => t.id === btn.dataset.tabId);
        if (act === 'back') { mode = startMode === 'add' ? 'list' : startMode; paint('[data-act="more"]'); return; }
        if (act === 'back-manage') { mode = 'manage'; paint(`[data-act="move"][data-tab-id="${moveTabId}"]`); return; }
        if (act === 'move' && tab) {
            moveTabId = tab.id;
            moveSongs = (await o.on.listSongs()).filter((x) => x.id !== o.song.id);
            mode = 'move';
            paint('.tabpick-search');
            return;
        }
        if (act === 'moveto' && moveTabId) {
            const tabId = moveTabId;
            closeSongTabPicker({ restoreFocus: false });
            o.on.moveTab(tabId, btn.dataset.songId);
            return;
        }
        if (act === 'more') { mode = 'add'; paint(); return; }
        if (act === 'add') { closeSongTabPicker({ restoreFocus: false }); o.on.addFrom(btn.dataset.providerId); return; }
        if (act === 'open' && tab) { closeSongTabPicker({ restoreFocus: false }); o.on.openTab(tab); return; }
        if (act === 'default' && tab) { closeSongTabPicker({ restoreFocus: false }); o.on.makeDefault(tab.id); return; }
        if (act === 'range' && tab) { closeSongTabPicker({ restoreFocus: false }); o.on.editRange(tab); return; }
        if (act === 'remove' && tab) {
            // Destructive: the second press confirms
            if (btn.dataset.confirming !== 'true') {
                btn.dataset.confirming = 'true';
                btn.textContent = 'Press again to remove';
                btn.setAttribute('aria-label', `Press again to remove ${btn.dataset.name}`);
                return;
            }
            closeSongTabPicker({ restoreFocus: false });
            o.on.removeTab(tab.id);
        }
    }
    root.addEventListener('click', onClick);
    root.addEventListener('input', (e) => {
        if (!e.target.classList?.contains('tabpick-search')) return;
        const list = root.querySelector('#tabpickMoveList');
        if (list) list.innerHTML = moveRows(e.target.value);
    });

    p.onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSongTabPicker(); return; }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            const items = [...root.querySelectorAll('.tabpick-search, .tabpick-row, .tabpick-act, .tabpick-back')];
            if (!items.length) return;
            e.preventDefault();
            const i = items.indexOf(document.activeElement);
            const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1);
            items[next].focus();
            return;
        }
        if (e.key === 'Tab') {
            const items = [...root.querySelectorAll('button, input')];
            if (!items.length) return;
            const first = items[0], last = items[items.length - 1];
            if (!root.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
            else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
    };
    p.onOutside = (e) => {
        if (root.contains(e.target) || o.anchor?.contains?.(e.target)) return;
        closeSongTabPicker({ restoreFocus: false });
    };
    p.onResize = () => placePanel(p);
    document.addEventListener('keydown', p.onKey, true);
    document.addEventListener('pointerdown', p.onOutside, true);
    window.addEventListener('resize', p.onResize);
    o.anchor?.setAttribute?.('aria-expanded', 'true');
    openPicker = p;
    paint(mode === 'list' ? `.tabpick-item.is-default .tabpick-open` : null);
    return p;
}

export function isSongTabPickerOpen() { return Boolean(openPicker); }
