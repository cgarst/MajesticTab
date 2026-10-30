// setlistPlayer.js
// Plays a setlist: queues its tabs in order and drives the Previous/Next buttons and [ ] shortcuts.

import { getSetlist } from './setlistStore.js';
import { getSongById } from './libraryStore.js';
import { openLibraryTab } from './libraryModal.js';
import { showToast } from './utils/toast.js';

function navEls() {
    return {
        nav: document.getElementById('setlistNav'),
        prev: document.getElementById('setlistPrevBtn'),
        next: document.getElementById('setlistNextBtn'),
        pos: document.getElementById('setlistNavPosition')
    };
}

async function openItem(setlist, item) {
    const song = await getSongById(item.songId);
    const hasTab = song && (item.tabId ? song.tabOptions?.some(t => t.id === item.tabId) : song.tabOptions?.length);
    if (!hasTab) {
        showToast(`"${song?.title || 'A song'}" has no tab to open. Skipped.`, 'warning');
        return false;
    }
    return openLibraryTab(song.id, item.tabId, { setlistId: setlist.id, setlistItemId: item.id });
}

/** Start playing a setlist at the given index (first playable item at or after it). */
export async function playSetlist(setlistId, startIndex = 0) {
    const setlist = await getSetlist(setlistId);
    if (!setlist || setlist.items.length === 0) {
        showToast('This setlist is empty.', 'info');
        return false;
    }
    for (let i = startIndex; i < setlist.items.length; i++) {
        if (await openItem(setlist, setlist.items[i])) return true;
    }
    return false;
}

/** Step to the next (+1) or previous (-1) playable item of the setlist the open tab belongs to. */
export async function stepSetlist(delta, file) {
    if (!file?.setlistId) return false;
    const setlist = await getSetlist(file.setlistId);
    const idx = setlist ? setlist.items.findIndex(i => i.id === file.setlistItemId) : -1;
    if (idx < 0) return false;
    for (let i = idx + delta; i >= 0 && i < setlist.items.length; i += delta) {
        if (await openItem(setlist, setlist.items[i])) return true;
    }
    showToast(delta > 0 ? 'End of setlist' : 'Start of setlist', 'info', 1500, 'setlist-step');
    return false;
}

/** Show the Previous/Next buttons only while the open tab was opened from a setlist. */
export async function refreshSetlistNav(file) {
    const { nav, prev, next, pos } = navEls();
    if (!nav) return;
    const setlist = file?.setlistId ? await getSetlist(file.setlistId) : null;
    const idx = setlist ? setlist.items.findIndex(i => i.id === file.setlistItemId) : -1;
    if (idx < 0) {
        nav.style.display = 'none';
        return;
    }
    nav.style.display = 'inline-flex';
    nav.title = setlist.name;
    pos.textContent = `${idx + 1}/${setlist.items.length}`;
    prev.disabled = idx === 0;
    next.disabled = idx === setlist.items.length - 1;
}

export function setupSetlistNav(getFile) {
    document.getElementById('setlistPrevBtn')?.addEventListener('click', () => stepSetlist(-1, getFile()));
    document.getElementById('setlistNextBtn')?.addEventListener('click', () => stepSetlist(1, getFile()));
}
