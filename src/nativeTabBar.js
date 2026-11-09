// nativeTabBar.js
// The iOS app's bottom tab bar for the library is the system UITabBar (Liquid Glass on iOS 26 and later) instead of
// the HTML one. Only this system chrome is glass; the web content stays flat. The native side is
// build/tauri/plugins/ios-tabbar. Everywhere else, and on iOS before 26, nothing here runs and the HTML bar stays.
//
// The HTML bar remains the source of truth for what a tap does: a native tap clicks the matching HTML button, so
// navigation, Settings and the "leave Settings" handling stay in one place (libraryModal.js).

const MIN_IOS_MAJOR = 26;
const TABS = [
    { key: 'library', title: 'Library', symbol: 'books.vertical' },
    { key: 'setlists', title: 'Setlists', symbol: 'music.note.list' },
    { key: 'tools', title: 'Tools', symbol: 'wrench.and.screwdriver' },
    { key: 'settings', title: 'Settings', symbol: 'gearshape' }
];

const tauri = () => (typeof window !== 'undefined' ? window.__TAURI__ : undefined);

let state = 'idle'; // idle | starting | on | unsupported
let verticalMode = false; // the system keeps its bars in a vertical strip (iPhone Duo); the native side reports it
let activeKey = 'library';
let wantVisible = false;
let shown = null; // what the native bar was last told (true = hidden), to skip repeats

function invoke(cmd, args) {
    return tauri().core.invoke(`plugin:ios-tabbar|${cmd}`, args);
}

function onEvent(msg) {
    if (!msg) return;
    if (msg.type === 'height') {
        document.documentElement.style.setProperty('--native-tabbar-h', `${Math.round(msg.value)}px`);
    } else if (msg.type === 'corner') {
        // The system's status cluster sits in the top-right corner (iPhone Duo upright); the reader's top bar stays left of it
        const width = Math.round(Number(msg.value));
        document.documentElement.classList.toggle('native-status-corner', width > 0);
        document.documentElement.style.setProperty('--native-status-r', `${width}px`);
    } else if (msg.type === 'top') {
        // Room the native search field takes at the top of the window (0 when it is hidden)
        const top = Math.round(msg.value);
        if (top > 0) lastSearchTop = top;
        document.documentElement.style.setProperty('--native-search-top', `${top}px`);
    } else if (msg.type === 'side') {
        // Room the vertical rail takes at the screen's left or right edge (0 when the bar is horizontal)
        const root = document.documentElement.style;
        root.setProperty('--native-rail-left', `${Math.round(Number(msg.left))}px`);
        root.setProperty('--native-rail-right', `${Math.round(Number(msg.right))}px`);
    } else if (msg.type === 'mode') {
        verticalMode = msg.vertical === '1';
        document.documentElement.classList.toggle('native-vertical', verticalMode);
        refresh();
    } else if (msg.type === 'search') {
        // The web field keeps the logic (filtering, catalogue lookups, clear); the native field only types into it
        const input = searchInput();
        if (input && input.value !== msg.text) {
            input.value = msg.text;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
    } else if (msg.type === 'submit') {
        // The return key on the native field: the page's own form (Open file's web search) runs as if submitted
        searchInput()?.form?.requestSubmit();
    } else if (msg.type === 'selected') {
        // Same path as a tap on the HTML bar
        const selector = msg.key === 'settings' ? '#libraryNavSettingsBtn' : `[data-lib-tab="${msg.key}"]`;
        document.querySelector(selector)?.click();
    }
}

// The bar follows the app's theme: dark or light from the page ground, and the selected item in the ink colour
function resolveColor(cssColor) {
    const probe = document.createElement('span');
    probe.style.cssText = `color:${cssColor};display:none`;
    document.body.appendChild(probe);
    const rgb = getComputedStyle(probe).color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    probe.remove();
    return rgb && rgb.length === 3 ? rgb : null;
}

let lastStyle = '';
function syncAppearance() {
    if (state !== 'on') return;
    const ground = resolveColor('var(--ground)') || resolveColor(getComputedStyle(document.body).backgroundColor);
    const ink = resolveColor('var(--ink)');
    if (!ground || !ink) return;
    const dark = (0.2126 * ground[0] + 0.7152 * ground[1] + 0.0722 * ground[2]) < 128;
    const tint = '#' + ink.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
    const key = `${dark}${tint}`;
    if (key === lastStyle) return;
    lastStyle = key;
    invoke('appearance', { dark, tint }).catch(() => {});
}

// The library's search field (the page has one on Library and Setlists, none inside an open pane or on Tools)
// (or the Classical tab's list and Open file's web search inside a Tools pane)
function searchInput() {
    return document.querySelector('.library-page-view .library-search-bar .search-input:not([disabled]), .classtab-tool-embedded .ct-search:not([disabled])');
}

// Inside a Tools pane the native field sits where the page's own field is, under the pane's header, instead of in the
// top band. The page's field keeps its space (design.css hides it with visibility) and the native one is laid over it.
// Returns null outside a pane, and 'hidden' once the page has scrolled the field up under the header.
function paneSearchY(input) {
    const host = input.closest('.tool-pane-host');
    if (!host) return null;
    const box = input.closest('.library-search-box') || input;
    const rect = box.getBoundingClientRect();
    if (rect.height === 0) return 'hidden';
    // Pulling down at the top rubber-bands the scroller (scrollTop goes negative on iOS), which carries the page's
    // field down with it. The field stays with the header, so take that overscroll back out.
    let bounce = 0;
    for (let el = input.parentElement; el && el !== document.documentElement; el = el.parentElement) {
        if (el.scrollTop < 0) bounce += el.scrollTop;
    }
    const top = rect.top + bounce;
    return top < host.getBoundingClientRect().top - 4 ? 'hidden' : Math.round(top);
}

let lastSearchTop = 0;
let lastSearch = '';
function syncSearch() {
    if (state !== 'on') return;
    const input = wantVisible ? searchInput() : null;
    const y = input ? paneSearchY(input) : null;
    const visible = Boolean(input) && y !== 'hidden';
    document.body.classList.toggle('native-search-pane', Boolean(input) && y !== null);
    // The native field reports its height a moment after it shows. Until then the page would pad by 0 and the content
    // would sit under the field for a frame, then jump down; the field's height does not change, so reuse the last one.
    if (visible && lastSearchTop > 0 && !document.body.classList.contains('native-search')) {
        document.documentElement.style.setProperty('--native-search-top', `${lastSearchTop}px`);
    }
    document.body.classList.toggle('native-search', visible);
    const args = { visible, placeholder: input?.placeholder || 'Search', text: input?.value || '' };
    if (typeof y === 'number') args.y = y;
    const key = JSON.stringify(args);
    if (key === lastSearch) return;
    lastSearch = key;
    invoke('search', args).catch(() => {});
}

function applyVisibility() {
    if (state !== 'on') return;
    document.body.classList.toggle('native-tabbar', wantVisible);
    if (shown === !wantVisible) return;
    shown = !wantVisible;
    invoke('visibility', { hidden: !wantVisible }).catch(() => {});
}

function refreshAll() {
    applyVisibility();
    syncSearch();
}

// The native bar belongs to the library at every width (phones, iPads, the iPhone Duo in portrait): the system bottom
// bar, as on a regular iPhone. Only where the system wants a vertical bar (the Duo in landscape) is it a side rail.
// A dialog floating over the library (the From URL box, the S3 and WebDAV browsers, the Drive picker): the glass bar and
// field are native views above the page, so they would sit on top of it. Embedded Tools panes are not floating.
const FLOATING_DIALOG = '.theme-modal-backdrop:not(.tool-embedded):not(.is-closing), .picker-dialog, .picker-dialog-bg';
function dialogOpen() {
    return Array.from(document.querySelectorAll(FLOATING_DIALOG)).some(el => el.style.display !== 'none' && el.getClientRects().length > 0);
}

function currentlyWanted() {
    return document.body.classList.contains('library-view-active') && !document.body.classList.contains('downloader-active') && !dialogOpen();
}

async function start() {
    state = 'starting';
    try {
        const channel = new (tauri().core.Channel)();
        channel.onmessage = onEvent;
        const index = Math.max(0, TABS.findIndex(t => t.key === activeKey));
        const result = await invoke('configure', { items: TABS, selected: index, minMajor: MIN_IOS_MAJOR, onEvent: channel });
        state = result?.supported ? 'on' : 'unsupported';
        verticalMode = Boolean(result?.vertical);
        document.documentElement.classList.toggle('native-vertical', verticalMode);
    } catch (err) {
        console.warn('Native tab bar unavailable:', err);
        state = 'unsupported';
    }
    if (state === 'on') {
        shown = null;
        lastStyle = '';
        syncAppearance();
        applyVisibility();
        syncSearch();
        invoke('select', { index: TABS.findIndex(t => t.key === activeKey) }).catch(() => {});
    }
}

function refresh() {
    wantVisible = currentlyWanted();
    // Started on any page, not only a library one: the native side must hear that this page wants no bar (a score is open),
    // and a wide layout learns from it whether the system keeps its bars in a vertical strip
    if (state === 'idle') start().then(refresh);
    else refreshAll();
}

// Call once. Cheap off iOS: it returns before observing anything.
export function initNativeTabBar() {
    const isNativeIOS = document.documentElement.classList.contains('tauri-ios') && Boolean(tauri()?.core?.Channel);
    if (!isNativeIOS || initNativeTabBar.done) return;
    initNativeTabBar.done = true;
    // The bar belongs to the library: the reader, the downloader and wide layouts (the rail) hide it
    new MutationObserver(refresh).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    // Dialogs are added to and removed from the body itself
    new MutationObserver(refresh).observe(document.body, { childList: true });
    // The page re-renders its search field when the destination changes, so look again (once per frame)
    let frame = 0;
    new MutationObserver(() => {
        if (frame || state !== 'on' || !document.body.classList.contains('library-view-active')) return;
        frame = requestAnimationFrame(() => { frame = 0; syncSearch(); });
    }).observe(document.body, { childList: true, subtree: true });
    // A pane's field follows the page's own as it scrolls
    let scrollFrame = 0;
    document.addEventListener('scroll', () => {
        if (scrollFrame || state !== 'on' || !document.body.classList.contains('native-search-pane')) return;
        scrollFrame = requestAnimationFrame(() => { scrollFrame = 0; syncSearch(); });
    }, { capture: true, passive: true });
    // A theme change sets data-theme (and classes) on the root or body
    const themeChanged = new MutationObserver(syncAppearance);
    themeChanged.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    themeChanged.observe(document.body, { attributes: true, attributeFilter: ['data-theme'] });
    refresh();
}

// Mirror the current destination ('library', 'setlists', 'tools', 'settings', or null for none)
export function setNativeTabActive(key) {
    activeKey = TABS.some(t => t.key === key) ? key : null;
    if (state !== 'on') return;
    invoke('select', { index: TABS.findIndex(t => t.key === activeKey) }).catch(() => {});
}
