// classtab/songMenu.js
// The Song menu's credit for a tab that came from the Classtab archive: "From Classtab" with a link to the site, or
// "No longer in the archive" when an update removed the piece it was opened from (its tab stays open, and Save to
// library, the same button as for any open tab, keeps a copy).

import { archiveHasPiece, onArchiveChange } from './archive.js';
import { CLASSTAB_HOME } from './download.js';

const SOURCE = 'Classtab';

async function openHome() {
    const opener = window.__TAURI__?.opener;
    if (opener?.openUrl) await opener.openUrl(CLASSTAB_HOME);
    else window.open(CLASSTAB_HOME, '_blank', 'noopener');
}

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
        line.innerHTML = 'From Classtab · <a href="#" data-home>classtab.org</a>';
    };
    line.addEventListener('click', (e) => {
        if (e.target.closest('[data-home]')) { e.preventDefault(); openHome(); }
    });
    window.addEventListener('majestictab:file-loaded', update);
    onArchiveChange(update);
}
