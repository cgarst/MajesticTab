// urlRouter.js
// Deep linking and browser URL sync for MajesticTab
// Supported URL routes:
// - #library
// - #recents
// - #settings
// - #setlists, #openfile, #search (add music)
// - #classtab (Tools > Classical tab; #classical also works)
// - #tuner
// - #metronome
// - #reference
// - #reference/circle
// - #reference/chords
// - #reference/scales
// - #reference/tone
// (also supports corresponding slash formats e.g. #/library, #/reference/scales, and query params e.g. ?view=tuner, ?view=reference&tab=scales)

import { openLibraryModal, isLibraryOpen, switchLibraryView, goLibraryTab } from '../libraryModal.js';
import { openTunerModal, closeTunerModal } from '../tuner/tuner.js';
import { openMetronomeModal, closeMetronomeModal } from '../metronome/metronome.js';
import { getActiveReferenceTab, setReferenceTabChangeListener, closeReferenceModal } from '../referenceLibrary.js';

let isSyncingUrl = false;
let isInitialized = false;

export function getRouteFromUrl() {
    const rawHash = (window.location.hash || '').replace(/^#\/?/, '').trim();
    if (rawHash.includes('access_token=') || rawHash.includes('state=')) {
        return null;
    }

    if (rawHash) {
        const parts = rawHash.split('/');
        const main = parts[0]?.toLowerCase();
        const sub = parts[1]?.toLowerCase();
        return { main, sub };
    }

    const searchParams = new URLSearchParams(window.location.search);
    const viewParam = searchParams.get('view')?.toLowerCase() || searchParams.get('page')?.toLowerCase();
    const tabParam = searchParams.get('tab')?.toLowerCase() || searchParams.get('ref')?.toLowerCase();
    if (viewParam) {
        return { main: viewParam, sub: tabParam || null };
    }

    return null;
}

export function updateUrl(main, sub = null, replace = false) {
    if (typeof window === 'undefined' || isSyncingUrl) return;

    let targetHash = '';
    if (main === 'reference' || main === 'chords' || main === 'scales' || main === 'circle') {
        const activeSub = (main !== 'reference' ? main : sub) || getActiveReferenceTab() || 'chords';
        targetHash = `#reference/${activeSub}`;
    } else if (main === 'library' || main === 'recents' || main === 'tuner' || main === 'metronome' || main === 'setlists' || main === 'tools' || main === 'settings' || main === 'openfile' || main === 'classtab' || main === 'bulkexport' || main === 'tunings') {
        targetHash = `#${main}`;
    } else if (!main) {
        targetHash = '';
    }

    const currentHash = window.location.hash;
    if (currentHash === targetHash) return;

    isSyncingUrl = true;
    try {
        const newUrl = targetHash ? `${window.location.pathname}${window.location.search}${targetHash}` : `${window.location.pathname}${window.location.search}`;
        if (replace) {
            window.history.replaceState(null, '', newUrl);
        } else {
            window.history.pushState(null, '', newUrl);
        }
    } catch (e) {
        try {
            window.location.hash = targetHash;
        } catch (_) {}
    } finally {
        setTimeout(() => { isSyncingUrl = false; }, 100);
    }
}

export function clearUrl(replace = false) {
    if (isSyncingUrl) return;
    updateUrl(null, null, replace);
}

export async function navigateToUrlRoute(route, isInitial = false) {
    if (!route || !route.main) return false;

    isSyncingUrl = true;
    try {
        if (route.main === 'tuner') {
            closeMetronomeModal();
            openTunerModal();
            return true;
        }

        if (route.main === 'metronome') {
            closeTunerModal();
            openMetronomeModal();
            return true;
        }

        if (route.main === 'reference' || route.main === 'chords' || route.main === 'scales' || route.main === 'circle') {
            closeTunerModal();
            closeMetronomeModal();
            closeReferenceModal();
            const targetRefTab = route.main === 'reference'
                ? ((route.sub && ['circle', 'chords', 'scales'].includes(route.sub)) ? route.sub : 'chords')
                : route.main;
            (await import('./toolsPage.js')).openToolOnNextRender(targetRefTab);
            if (isLibraryOpen()) {
                const { getActiveLibraryView } = await import('../libraryModal.js');
                if (getActiveLibraryView?.() !== 'tools') {
                    await switchLibraryView('tools', false);
                }
            } else {
                await openLibraryModal('tools');
            }
            await new Promise((r) => setTimeout(r, 400));
            const btn = document.querySelector(`.tools-shell button[data-tool="${targetRefTab}"]`);
            if (btn && (btn.getAttribute('aria-current') !== 'true' || !document.querySelector('#referenceModal.tool-embedded') || document.querySelector('.tools-shell')?.dataset?.tool !== targetRefTab)) {
                btn.click();
            }
            return true;
        }

        if (route.main === 'classtab' || route.main === 'classical') {
            closeTunerModal();
            closeMetronomeModal();
            closeReferenceModal();
            // The Tools page opens on this tool when it is drawn; when Tools is already showing, press the tool's row
            (await import('./toolsPage.js')).openToolOnNextRender('classtab');
            if (isLibraryOpen()) {
                await switchLibraryView('tools', false);
            } else {
                await openLibraryModal('tools');
            }
            // The page picks the pending tool on its own after it paints; press the row only if that did not happen
            await new Promise((r) => setTimeout(r, 400));
            const btn = document.querySelector('.tools-shell button[data-tool="classtab"]');
            if (btn && btn.getAttribute('aria-current') !== 'true' && !document.querySelector('.classtab-tool-embedded')) btn.click();
            return true;
        }

        if (route.main === 'bulkexport') {
            closeTunerModal();
            closeMetronomeModal();
            closeReferenceModal();
            (await import('./toolsPage.js')).openToolOnNextRender('bulkexport');
            if (isLibraryOpen()) {
                await switchLibraryView('tools', false);
            } else {
                await openLibraryModal('tools');
            }
            await new Promise((r) => setTimeout(r, 400));
            const btn = document.querySelector('.tools-shell button[data-tool="bulkexport"]');
            if (btn && btn.getAttribute('aria-current') !== 'true' && !document.querySelector('.bulkexport-tool-embedded')) btn.click();
            return true;
        }

        if (route.main === 'openfile') {
            closeTunerModal();
            closeMetronomeModal();
            closeReferenceModal();
            if (isLibraryOpen()) {
                await switchLibraryView('tools', false);
            } else {
                await openLibraryModal('tools');
            }
            const btn = document.querySelector('.tools-shell button[data-tool="openfile"]');
            btn?.click();
            return true;
        }

        const libraryViews = { library: 'library', recents: 'recents', setlists: 'setlists', tools: 'tools', settings: 'settings', search: 'library', tunings: 'tunings' };
        if (libraryViews[route.main]) {
            const view = libraryViews[route.main];
            closeTunerModal();
            closeMetronomeModal();
            closeReferenceModal();
            if (isLibraryOpen()) {
                if (view === 'tunings' || view === 'library') await goLibraryTab(view);
                else await switchLibraryView(view, false);
            } else {
                await openLibraryModal(view);
            }
            return true;
        }
    } catch (err) {
        console.error('[UrlRouter] Error navigating to route:', err);
    } finally {
        setTimeout(() => { isSyncingUrl = false; }, 100);
    }

    return false;
}

export function initUrlRouter() {
    if (isInitialized || typeof window === 'undefined') return;
    isInitialized = true;

    // Listen to Reference tab change events
    setReferenceTabChangeListener((tab) => {
        updateUrl('reference', tab);
    });

    // Listen to hash and popstate changes
    const onUrlChange = async () => {
        if (isSyncingUrl) return;
        const route = getRouteFromUrl();
        if (route) {
            await navigateToUrlRoute(route);
        } else {
            // No hash route: if tuner is open, close it; if library is open and a file is open, close it
            const tunerModal = document.getElementById('tunerModal');
            if (tunerModal && tunerModal.style.display !== 'none') {
                closeTunerModal();
            }
            closeMetronomeModal();
            closeReferenceModal();
        }
    };

    window.addEventListener('hashchange', onUrlChange);
    window.addEventListener('popstate', onUrlChange);

    // Initial route check on page load
    const initialRoute = getRouteFromUrl();
    if (initialRoute) {
        navigateToUrlRoute(initialRoute, true);
    }
}
