// songPin.js
// The Song menu's Pin action. It pins where the player got the song: a song in the library is pinned in the library
// (the Pinned group); a piece opened from the Classical tab browser is pinned in its pins. Once such a piece has been
// saved to the library (the open file then carries librarySongId) the library pin is shown instead.

import { getCurrentFile } from './main.js';
import { getSongById, togglePinSong } from './libraryStore.js';
import { isPiecePinned, togglePiecePin } from './classtab/pins.js';
import { showToast } from './utils/toast.js';

/** @returns {Promise<{kind: 'library'|'classtab', pinned: boolean}|null>} what Pin would do for the open file */
async function pinTarget(file) {
    if (!file) return null;
    if (file.librarySongId) {
        const song = await getSongById(file.librarySongId);
        return song ? { kind: 'library', pinned: Boolean(song.pinned) } : null;
    }
    if (file.classtabTab && file.artist && file.songTitle) {
        return { kind: 'classtab', pinned: isPiecePinned(file.artist, file.songTitle) };
    }
    return null;
}

export function setupSongPinButton() {
    const btn = document.getElementById('songPinBtn');
    if (!btn) return;
    const refresh = async () => {
        const target = await pinTarget(getCurrentFile());
        btn.style.display = target ? '' : 'none';
        if (target) btn.textContent = target.pinned ? 'Unpin' : 'Pin';
    };
    document.addEventListener('scoreoptions:open', refresh);
    btn.addEventListener('click', async () => {
        const file = getCurrentFile();
        const target = await pinTarget(file);
        if (!target) return;
        if (target.kind === 'library') {
            const pinned = await togglePinSong(file.librarySongId);
            showToast(pinned ? 'Pinned in your library' : 'Unpinned from your library', 'info');
        } else {
            const pinned = togglePiecePin(file.artist, file.songTitle);
            showToast(pinned ? 'Pinned in Classical tab browser' : 'Unpinned from Classical tab browser', 'info');
        }
        refresh();
    });
}
