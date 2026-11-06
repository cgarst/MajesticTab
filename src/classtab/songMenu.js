// classtab/songMenu.js
// The Song menu's note for a tab that came from the Classtab archive: "No longer in the archive" when an update removed the piece it was opened from (its tab stays open, and Save to
// library, the same button as for any open tab, keeps a copy).

import { archiveHasPiece, onArchiveChange } from './archive.js';

const SOURCE = 'Classtab';

export function initClasstabSongMenu(getCurrent) {
    const line = document.getElementById('songSourceLine');
    if (!line) return;
    const update = async () => {
        const file = getCurrent();
        if (!file || file.sourceWebsite !== SOURCE) { line.style.display = 'none'; return; }
        line.style.display = '';
        // Only a piece opened straight from the archive can go missing; a copy in the library is the user's own
        const fromArchive = file.classtabTab && !file.librarySongId;
        if (fromArchive && !(await archiveHasPiece(file.classtabTab))) {
            line.textContent = 'No longer in the archive';
            return;
        }
        // The Source website row of the Song menu already credits Classtab and links to it
        line.style.display = 'none';
    };
    window.addEventListener('majestictab:file-loaded', update);
    onArchiveChange(update);
}
