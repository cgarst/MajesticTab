// urlRouter.js
// Deep linking and browser URL sync for MajesticTab
// Supported URL routes:
// - #library
// - #recents
// - #settings
// - #setlists, #tunings
// - #tools (or #tools/scales, #tools/chords, #tools/circle, #tools/tuner, #tools/metronome, #tools/jam, #tools/classtab, #tools/openfile, #tools/bulkexport, #tools/bulkimport, #tools/missingtabs, #tools/stemdeck)
// - Legacy routes supported and redirected: #reference/scales, #classtab, #tuner, #metronome, etc.
// (also supports corresponding slash formats e.g. #/library, #/tools/scales, and query params e.g. ?view=tools&tab=scales)

import { openLibraryModal, isLibraryOpen, switchLibraryView, goLibraryTab } from '../libraryModal.js';
import { openTunerModal, closeTunerModal } from '../tuner/tuner.js';
import { openMetronomeModal, closeMetronomeModal } from '../metronome/metronome.js';
import { getActiveReferenceTab, setReferenceTabChangeListener, closeReferenceModal } from '../referenceLibrary.js';

let isSyncingUrl = false;
let isInitialized = false;

const ALL_TOOLS = ['chords', 'scales', 'circle', 'tuner', 'metronome', 'jam', 'openfile', 'classtab', 'classical', 'stemdeck', 'bulkexport', 'bulkimport', 'missingtabs'];

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
    if (typeof window === 'undefined') return;

    let targetHash = '';
    if (main === 'tools') {
        targetHash = sub ? `#tools/${sub}` : '#tools';
    } else if (ALL_TOOLS.includes(main)) {
        const tool = main === 'classical' ? 'classtab' : main;
        targetHash = `#tools/${tool}`;
    } else if (main === 'reference') {
        const activeSub = (sub || getActiveReferenceTab() || 'chords');
        targetHash = `#tools/${activeSub}`;
    } else if (main === 'library' || main === 'recents' || main === 'setlists' || main === 'settings' || main === 'tunings') {
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
    updateUrl(null, null, replace);
}

export async function navigateToUrlRoute(route, isInitial = false) {
    if (!route || !route.main) return false;

    isSyncingUrl = true;
    try {
        if (route.main === 'tools') {
            closeTunerModal();
            closeMetronomeModal();
            closeReferenceModal();
            const targetTool = route.sub === 'classical' ? 'classtab' : route.sub;
            if (targetTool) {
                const targetRefTab = targetTool;
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
                if (btn && (btn.getAttribute('aria-current') !== 'true' || document.querySelector('.tools-shell')?.dataset?.tool !== targetRefTab)) {
                    btn.click();
                }
                updateUrl('tools', targetRefTab, true);
                return true;
            } else {
                if (isLibraryOpen()) {
                    const { getActiveLibraryView } = await import('../libraryModal.js');
                    if (getActiveLibraryView?.() !== 'tools') {
                        await switchLibraryView('tools', false);
                    } else {
                        const setback = document.querySelector('.tools-shell .setback');
                        if (setback && document.querySelector('.tools-shell')?.dataset?.pane === 'page') {
                            setback.click();
                        }
                    }
                } else {
                    await openLibraryModal('tools');
                }
                updateUrl('tools', null, true);
                return true;
            }
        }

        if (route.main === 'reference' || route.main === 'chords' || route.main === 'scales' || route.main === 'circle') {
            const targetRefTab = route.main === 'reference'
                ? ((route.sub && ['circle', 'chords', 'scales'].includes(route.sub)) ? route.sub : 'chords')
                : route.main;
            return await navigateToUrlRoute({ main: 'tools', sub: targetRefTab }, isInitial);
        }

        if (route.main === 'classtab' || route.main === 'classical') {
            return await navigateToUrlRoute({ main: 'tools', sub: 'classtab' }, isInitial);
        }

        if (route.main === 'bulkexport' || route.main === 'bulkimport' || route.main === 'missingtabs' || route.main === 'stemdeck' || route.main === 'openfile') {
            return await navigateToUrlRoute({ main: 'tools', sub: route.main }, isInitial);
        }

        if (route.main === 'tuner' || route.main === 'metronome' || route.main === 'jam') {
            return await navigateToUrlRoute({ main: 'tools', sub: route.main }, isInitial);
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
        updateUrl('tools', tab);
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
