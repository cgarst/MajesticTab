// urlRouter.js
// Deep linking and browser URL sync for MajesticTab
// Supported URL routes:
// - #library
// - #recents
// - #tuner
// - #reference
// - #reference/circle
// - #reference/chords
// - #reference/scales
// - #reference/tone
// (also supports corresponding slash formats e.g. #/library, #/reference/scales, and query params e.g. ?view=tuner, ?view=reference&tab=scales)

import { openLibraryModal, closeLibraryModal, isLibraryOpen, getActiveLibraryView, switchLibraryView } from '../libraryModal.js';
import { openTunerModal, closeTunerModal } from '../tuner/tuner.js';
import { getActiveReferenceTab, setReferenceTabChangeListener, openReferenceModal, closeReferenceModal, isReferenceOpen } from '../referenceLibrary.js';

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
    if (main === 'reference') {
        const activeSub = sub || getActiveReferenceTab() || 'chords';
        targetHash = `#reference/${activeSub}`;
    } else if (main === 'library' || main === 'recents' || main === 'tuner') {
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
            openTunerModal();
            return true;
        }

        if (route.main === 'reference') {
            closeTunerModal();
            const targetRefTab = (route.sub && ['circle', 'chords', 'scales', 'tone'].includes(route.sub)) ? route.sub : 'chords';
            openReferenceModal(targetRefTab);
            return true;
        }

        if (route.main === 'library' || route.main === 'recents') {
            closeTunerModal();
            closeReferenceModal();
            if (isLibraryOpen()) {
                await switchLibraryView(route.main, false);
            } else {
                await openLibraryModal(route.main);
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
