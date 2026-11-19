// tabSetsUi.js
// Settings > Data management > Upkeep > Tab sets: puts the tabs that belong together (the tablature and the notation of each
// part from one pack) in one set, so the library lists one row for them. It shows what it found, changes nothing until
// the person chooses Group tabs, and can undo what it did. The rule is in tabSets.js; this is the screen. It opens in place
// under its row like the other data tasks and shares their one-open-at-a-time state.
import { planTabSetMigration, undoRecordFor, patchesBySong } from './tabSets.js';

const UNDO_KEY = 'majestictab_tabsets_undo';

const readUndo = () => {
    try {
        const raw = JSON.parse(localStorage.getItem(UNDO_KEY) || 'null');
        return raw && Array.isArray(raw.items) && raw.items.length ? raw : null;
    } catch { return null; }
};
const writeUndo = (record) => {
    try {
        if (record) localStorage.setItem(UNDO_KEY, JSON.stringify(record)); else localStorage.removeItem(UNDO_KEY);
    } catch { /* the undo record is a convenience: grouping still works without it */ }
};

const el = (tag, cls = '', text = '') => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const titlesOf = (list, max = 6) => {
    const names = list.map((x) => x.title || 'Untitled song');
    return names.length > max ? `${names.slice(0, max).join(', ')} and ${names.length - max} more` : names.join(', ');
};

/** Runs the changes song by song and returns how many tabs changed. `onProgress(done, total)` is called after each song. */
async function applyPatches(items, onProgress) {
    const { applyTabSetPatches } = await import('./libraryStore.js');
    const bySong = patchesBySong(items);
    let done = 0;
    let changed = 0;
    for (const [songId, patches] of bySong) {
        changed += await applyTabSetPatches(songId, patches);
        onProgress?.(++done, bySong.size);
        if (done % 10 === 0) await new Promise((r) => setTimeout(r, 0)); // let the screen breathe
    }
    window.dispatchEvent(new CustomEvent('libraryDataChanged'));
    window.dispatchEvent(new CustomEvent('majestictab:data-changed')); // tell auto-sync
    return changed;
}

function render(slot, close) {
    const box = el('div', 'backup-summary-box p-3 rounded-3 mb-3');
    const status = el('div', 'task-status small mb-2');
    status.style.display = 'none';
    const actions = el('div', 'd-flex justify-content-end gap-2 pt-1');
    const closeBtn = el('button', 'btn btn-sm btn-theme-outline px-3', 'Close');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', close);
    slot.replaceChildren(box, status, actions);

    const setActions = (...buttons) => actions.replaceChildren(closeBtn, ...buttons.filter(Boolean));
    const say = (kind, text) => {
        status.style.display = 'block';
        status.className = `task-status task-status-${kind} small mb-2`;
        status.setAttribute('role', kind === 'error' ? 'alert' : 'status');
        status.textContent = text;
    };
    const heading = (text) => box.appendChild(el('div', 'small fw-semibold text-white mb-2', text));
    const note = (text) => { const p = el('div', 'text-white-50 small mb-2', text); p.style.lineHeight = '1.45'; box.appendChild(p); return p; };

    const undoButton = () => {
        const undo = readUndo();
        if (!undo) return null;
        const b = el('button', 'btn btn-sm btn-theme-outline px-3', 'Undo grouping');
        b.type = 'button';
        b.addEventListener('click', async () => {
            b.disabled = true;
            try {
                const changed = await applyPatches(undo.items, (d, t) => say('info', `Undoing ${d} of ${t}`));
                writeUndo(null);
                say('done', `Undone. ${plural(changed, 'tab')} went back to how they were.`);
                setActions();
                await showPlan();
            } catch (e) {
                console.warn('[Tab sets] undo failed', e);
                say('error', 'Could not undo. Nothing else was changed.');
                b.disabled = false;
            }
        });
        return b;
    };

    async function showPlan() {
        box.replaceChildren();
        heading('Tab sets');
        note('Looking at your library…');
        let plan;
        let songs;
        try {
            const { getAllSongs } = await import('./libraryStore.js');
            songs = await getAllSongs();
            plan = planTabSetMigration(songs);
        } catch (e) {
            console.warn('[Tab sets] could not read the library', e);
            box.replaceChildren();
            heading('Tab sets');
            say('error', 'Could not read your library.');
            setActions();
            return;
        }
        const { report, changes } = plan;
        box.replaceChildren();
        heading('Tab sets');
        if (!changes.length) {
            note('No tabs to group. Tabs that belong together, such as the notation and tablature of each part from one pack, are already in sets.');
        } else {
            note(`${plural(report.songs, 'song')} ${report.songs === 1 ? 'has' : 'have'} tabs that belong together. Grouping puts each set in one row, so the library list goes from ${plural(report.rowsBefore, 'row')} to ${report.rowsAfter}. The player's Tabs menu still lists every tab of a set.`);
            note('No file, name or sync point changes, and you can undo it.');
            if (report.multiSet.length) note(`${plural(report.multiSet.length, 'song')} keep${report.multiSet.length === 1 ? 's' : ''} one row for each set, because they hold more than one pack or one pack twice: ${titlesOf(report.multiSet)}.`);
            if (report.duplicates.length) note(`${plural(report.duplicates.length, 'song')} hold${report.duplicates.length === 1 ? 's' : ''} the same file twice. Duplicate tabs can remove them: ${titlesOf(report.duplicates)}.`);
        }
        const group = changes.length ? el('button', 'btn btn-sm btn-theme-primary px-4', 'Group tabs') : null;
        if (group) {
            group.type = 'button';
            group.addEventListener('click', async () => {
                group.disabled = true;
                try {
                    const items = changes;
                    // What each tab has now, kept so Undo can put it back (an earlier record is replaced: one undo at a time)
                    writeUndo({ at: Date.now(), items: undoRecordFor(items, songs) });
                    const changed = await applyPatches(items, (d, t) => say('info', `Grouping ${d} of ${t}`));
                    say('done', `Grouped ${plural(report.sets, 'set')} in ${plural(report.songs, 'song')} (${plural(changed, 'tab')} changed).`);
                    setActions(undoButton());
                    box.replaceChildren();
                    heading('Tab sets');
                    note('Done. The library list shows one row for each set.');
                } catch (e) {
                    console.warn('[Tab sets] grouping failed', e);
                    say('error', 'Grouping stopped part way. Undo grouping puts the tabs back, or run Tab sets again to finish.');
                    setActions(undoButton());
                }
            });
        }
        setActions(...[undoButton(), group].filter(Boolean));
    }
    return showPlan();
}

/** Opens the task under its row, or closes it when it is open. */
export async function toggleTabSetsTask(slot) {
    const { setTaskOpenState } = await import('./backupRestore.js');
    if (!slot) return;
    if (!slot.hidden) { setTaskOpenState(null); return; }
    setTaskOpenState('tabsets');
    await render(slot, () => setTaskOpenState(null));
}
