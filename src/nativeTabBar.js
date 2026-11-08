// nativeTabBar.js
// The iOS app's bottom tab bar for the library is the system UITabBar (Liquid Glass on iOS 26 and later) instead of
// the HTML one. Only this system chrome is glass; the web content stays flat. The native side is
// build/tauri/plugins/ios-tabbar. Everywhere else, and on iOS before 26, nothing here runs and the HTML bar stays.
//
// The HTML bar remains the source of truth for what a tap does: a native tap clicks the matching HTML button, so
// navigation, Settings and the "leave Settings" handling stay in one place (libraryModal.js).

const MIN_IOS_MAJOR = 26;
const PHONE_QUERY = '(max-width: 576px)';
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
    } else if (msg.type === 'side') {
        // Room the vertical rail takes at the screen's left or right edge (0 when the bar is horizontal)
        const root = document.documentElement.style;
        root.setProperty('--native-rail-left', `${Math.round(Number(msg.left))}px`);
        root.setProperty('--native-rail-right', `${Math.round(Number(msg.right))}px`);
    } else if (msg.type === 'mode') {
        verticalMode = msg.vertical === '1';
        refresh();
    } else if (msg.type === 'search') {
        // The web field keeps the logic (filtering, catalogue lookups, clear); the native field only types into it
        const input = searchInput();
        if (input && input.value !== msg.text) {
            input.value = msg.text;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
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
function searchInput() {
    return document.querySelector('.library-page-view .library-search-bar .search-input:not([disabled])');
}

let lastSearch = '';
function syncSearch() {
    if (state !== 'on') return;
    const input = wantVisible ? searchInput() : null;
    const visible = Boolean(input);
    document.body.classList.toggle('native-search', visible);
    const args = { visible, placeholder: input?.placeholder || 'Search', text: input?.value || '' };
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

// The native bar belongs to the library, on phones and wherever the system wants a vertical bar (the iPhone Duo's
// outer display and its inner display in landscape, which are wider than a phone). Wide layouts keep the web rail.
function currentlyWanted() {
    return document.body.classList.contains('library-view-active') && (window.matchMedia(PHONE_QUERY).matches || verticalMode);
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
    // Started on any library page, not only a wanted one: a wide layout learns from the native side that it is vertical
    if (state === 'idle' && document.body.classList.contains('library-view-active')) start().then(refresh);
    else refreshAll();
}

// Call once. Cheap off iOS: it returns before observing anything.
export function initNativeTabBar() {
    const isNativeIOS = document.documentElement.classList.contains('tauri-ios') && Boolean(tauri()?.core?.Channel);
    if (!isNativeIOS || initNativeTabBar.done) return;
    initNativeTabBar.done = true;
    // The bar belongs to the library: the reader, the downloader and wide layouts (the rail) hide it
    new MutationObserver(refresh).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    // The page re-renders its search field when the destination changes, so look again (once per frame)
    let frame = 0;
    new MutationObserver(() => {
        if (frame || state !== 'on' || !document.body.classList.contains('library-view-active')) return;
        frame = requestAnimationFrame(() => { frame = 0; syncSearch(); });
    }).observe(document.body, { childList: true, subtree: true });
    // A theme change sets data-theme (and classes) on the root or body
    const themeChanged = new MutationObserver(syncAppearance);
    themeChanged.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    themeChanged.observe(document.body, { attributes: true, attributeFilter: ['data-theme'] });
    window.matchMedia(PHONE_QUERY).addEventListener('change', refresh);
    refresh();
}

// Mirror the current destination ('library', 'setlists', 'tools', 'settings', or null for none)
export function setNativeTabActive(key) {
    activeKey = TABS.some(t => t.key === key) ? key : null;
    if (state !== 'on') return;
    invoke('select', { index: TABS.findIndex(t => t.key === activeKey) }).catch(() => {});
}
