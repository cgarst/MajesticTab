// songFilesDialog.js
// "Manage files" on a library song's ellipsis menu: every tab, audio file, YouTube video and set of sync points the song
// holds, with where it came from, when it was added and whether this device has it. Each row can be moved to another song or
// deleted, and the references to it go with it (songFiles.js). Sync points move and delete with the audio or video they map.

import { getSongById, getAllSongs } from './libraryStore.js';
import { listSongFiles, deleteSongFile, moveSongFile, hasSyncCopyTarget, syncStatusOf, locateInSyncCopy } from './songFiles.js';
import { showToast } from './utils/toast.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SECTIONS = [
    { key: 'tabs', title: 'Tabs', empty: 'No tabs.' },
    { key: 'audio', title: 'Audio', empty: 'No audio files.' },
    { key: 'videos', title: 'YouTube videos', empty: 'No YouTube videos.' },
    { key: 'sync', title: 'Sync points', empty: 'No sync points.' },
];
const WHERE = { device: '', cloud: 'In the sync copy, not downloaded', partial: 'Partly on this device', link: 'A link, nothing stored' };
// What the last sync recorded for the song, said once at the top: it is the same for every row of the song
const syncLine = (status, at) => ({
    synced: `Everything this device holds is in the sync copy. Last sync ${at}.`,
    pending: `Changes since the last sync (${at}) are not in the sync copy yet.`,
    never: 'This song has not been synced yet.',
}[status] || '');

function formatSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function formatDate(ms) {
    if (!ms || !Number.isFinite(ms)) return '';
    try { return `Added ${new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`; } catch { return ''; }
}

function formatWhen(ms) {
    try { return new Date(ms).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return ''; }
}

const rowId = (r) => `${r.kind}:${r.id}`;

/** What a delete takes with it, said where it is confirmed. */
function deleteNote(row) {
    if (row.kind === 'audio') return 'Deletes the file and its sync points.';
    if (row.kind === 'youtube') return 'Removes the video and its sync points.';
    if (row.kind === 'tab') return 'Deletes the tab. The song keeps its audio.';
    return 'Deletes these sync points.';
}

export async function openSongFilesDialog(songId, { onChanged = null } = {}) {
    const song = await getSongById(songId);
    if (!song) return;
    document.getElementById('songFilesModal')?.remove();

    const modal = document.createElement('div');
    modal.id = 'songFilesModal';
    modal.className = 'theme-modal-backdrop';
    modal.innerHTML = `
    <div class="theme-modal-card sf-card" role="dialog" aria-modal="true" aria-labelledby="sfTitle">
      <div class="theme-modal-header">
        <div class="theme-modal-titles">
          <h5 class="modal-title mb-0 fs-6 fw-bold text-white" id="sfTitle">Files</h5>
          <div class="small text-muted sf-subtitle" title="${esc(song.title)}">${esc(song.title)}${song.artist ? ` · ${esc(song.artist)}` : ''}</div>
        </div>
        <div class="theme-modal-actions">
          <button type="button" class="brand-btn theme-modal-close-btn p-1 px-2" id="sfClose" aria-label="Close"><i class="bi-x-lg" aria-hidden="true"></i></button>
        </div>
      </div>
      <div class="theme-modal-body sf-body" id="sfBody" aria-live="polite"></div>
    </div>`;
    document.body.appendChild(modal);
    modal.style.display = 'flex';
    const body = modal.querySelector('#sfBody');
    const opener = document.activeElement;

    let data = null;
    let view = 'list';
    let moving = null;
    let moveSongs = [];
    let busy = false;
    let confirmRid = null;
    let syncStatus = 'none';
    let syncedAt = 0;
    let copy = null;   // where rows sit in the sync copy, once read: { found, paths }
    const syncCopyAvailable = await hasSyncCopyTarget();

    const close = () => {
        document.removeEventListener('keydown', onKey, true);
        modal.classList.add('is-closing');
        setTimeout(() => modal.remove(), 160);
        if (opener?.isConnected) opener.focus?.({ preventScroll: true });
    };
    function onKey(e) {
        if (e.key !== 'Escape') return;
        e.preventDefault(); e.stopPropagation();
        if (view === 'move') { view = 'list'; paint(); } else close();
    }
    document.addEventListener('keydown', onKey, true);
    modal.querySelector('#sfClose').addEventListener('click', close);
    modal.addEventListener('mousedown', (e) => { if (e.target === modal) close(); });

    const find = (rid) => SECTIONS.flatMap((s) => data[s.key]).find((r) => rowId(r) === rid);

    const copyFolder = () => {
        const first = [...(copy?.paths.values() || [])].flat()[0];
        const m = first && /^packs\/[^/]+/.exec(first);
        return m ? m[0] : '';
    };
    const missingFromCopy = () => SECTIONS.flatMap((x) => data[x.key]).some((r) => r.location === 'device' && copy.paths.has(rowId(r)) && !copy.paths.get(rowId(r)).length);

    function rowHtml(r) {
        const meta = [r.source, formatDate(r.addedAt), formatSize(r.size), r.location === 'device' ? '' : WHERE[r.location]].filter(Boolean).join(' · ');
        const canMove = r.kind !== 'sync';
        const inCopy = copy?.paths.get(rowId(r));
        const within = (pth) => (copyFolder() && pth.startsWith(`${copyFolder()}/`) ? pth.slice(copyFolder().length + 1) : pth);
        const copyPaths = (inCopy || []).length > 2 ? [`${within(inCopy[0])} and ${inCopy.length - 1} more`] : (inCopy || []).map(within);
        const notInCopy = copy?.found && r.location === 'device' && copy.paths.has(rowId(r)) && !inCopy.length;
        return `<li class="sf-row" data-rid="${esc(rowId(r))}">
          <div class="sf-text">
            <span class="sf-name">${esc(r.name)}</span>
            ${r.detail && !r.name.toLowerCase().startsWith(r.detail.toLowerCase()) ? `<span class="sf-detail">${esc(r.detail)}</span>` : ''}
            <span class="sf-meta">${esc([meta, notInCopy ? 'Not in the sync copy' : ''].filter(Boolean).join(' \u00b7 '))}</span>
            ${r.libraryPath ? `<span class="sf-path" title="Path in the library">Library: ${esc(r.libraryPath)}</span>` : ''}
            ${copyPaths.map((pth) => `<span class="sf-path" title="Path in the sync location">In the sync copy: ${esc(pth)}</span>`).join('')}
          </div>
          ${confirmRid === rowId(r) ? `<div class="sf-confirm" role="group" aria-label="Delete ${esc(r.name)}">
            <span class="sf-confirm-note">${esc(deleteNote(r))}${syncCopyAvailable && r.kind !== 'sync' ? ' The sync copy stays unless you remove it too, so a later sync can bring the file back.' : ''}</span>
            <div class="sf-acts">
              <button type="button" class="tabpick-act" data-act="cancel-delete">Cancel</button>
              <button type="button" class="tabpick-act tabpick-danger" data-act="delete-here">${syncCopyAvailable && r.kind !== 'sync' ? 'Delete here' : 'Delete'}</button>
              ${syncCopyAvailable && r.kind !== 'sync' ? '<button type="button" class="tabpick-act tabpick-danger" data-act="delete-all">Delete here and in the sync copy</button>' : ''}
            </div>
          </div>` : `<div class="sf-acts">
            ${canMove ? `<button type="button" class="tabpick-act" data-act="move" aria-label="Move ${esc(r.name)} to another song">Move</button>` : ''}
            <button type="button" class="tabpick-act tabpick-danger" data-act="delete" aria-label="Delete ${esc(r.name)}">Delete</button>
          </div>`}
        </li>`;
    }

    function listHtml() {
        const at = syncedAt ? formatWhen(syncedAt) : '';
        const folder = copyFolder();
        // Once the pack has been read, what it says about each file beats the song-level guess
        const line = copy?.found && missingFromCopy()
            ? `Some files here are not in the sync copy yet.${at ? ` Last sync ${at}.` : ''}`
            : syncLine(syncStatus, at);
        const syncNote = line ? `<p class="sf-sync">${esc(line)}</p>${folder ? `<p class="sf-sync sf-path" title="Folder of this song in the sync location">Sync copy folder: ${esc(folder)}</p>` : ''}` : '';
        return syncNote + SECTIONS.map((s) => {
            const rows = data[s.key];
            return `<section class="sf-section" aria-labelledby="sf_${s.key}">
              <h6 class="sf-heading" id="sf_${s.key}">${s.title}${rows.length ? `<span class="sf-count"> · ${rows.length}</span>` : ''}</h6>
              ${rows.length ? `<ul class="sf-list">${rows.map(rowHtml).join('')}</ul>` : `<p class="sf-empty">${s.empty}</p>`}
            </section>`;
        }).join('') + '<p class="sf-note">Sync points belong to the audio or video they map: they move and are deleted with it, or on their own when you delete them here.</p>';
    }

    function moveRows(query) {
        const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
        const hits = moveSongs.filter((x) => words.every((w) => `${x.title} ${x.artist || ''} ${x.album || ''}`.toLowerCase().includes(w)));
        if (!hits.length) return '<li class="tabpick-note">No song matches.</li>';
        return hits.slice(0, 40).map((x) => `<li><button type="button" class="tabpick-row tabpick-song" data-act="moveto" data-song-id="${esc(x.id)}">
            <span class="tabpick-name">${esc(x.title)}</span><span class="tabpick-meta">${esc([x.artist, x.album].filter(Boolean).join(' · '))}</span></button></li>`).join('')
            + (hits.length > 40 ? '<li class="tabpick-note">Keep typing to narrow the list.</li>' : '');
    }

    function paint(focusSel) {
        if (view === 'move') {
            body.innerHTML = `
              <div class="tabpick-bar"><button type="button" class="tabpick-back" data-act="back">Back</button></div>
              <p class="tabpick-label" id="sfMoveLabel">Move ${esc(moving?.name || '')} to</p>
              <input type="search" class="tabpick-search" aria-labelledby="sfMoveLabel" placeholder="Search songs" autocomplete="off" spellcheck="false">
              <ul class="tabpick-list" id="sfMoveList">${moveRows('')}</ul>`;
            body.querySelector('.tabpick-search')?.focus({ preventScroll: true });
            return;
        }
        body.innerHTML = listHtml();
        (focusSel && body.querySelector(focusSel))?.focus({ preventScroll: true });
    }

    async function reload(focusSel) {
        data = await listSongFiles((await getSongById(songId)) || song);
        paint(focusSel);
    }

    body.addEventListener('input', (e) => {
        if (!e.target.classList?.contains('tabpick-search')) return;
        const list = body.querySelector('#sfMoveList');
        if (list) list.innerHTML = moveRows(e.target.value);
    });

    body.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn || busy) return;
        const act = btn.dataset.act;
        if (act === 'back') { view = 'list'; paint(); return; }
        if (act === 'moveto' && moving) {
            busy = true;
            const target = moveSongs.find((x) => x.id === btn.dataset.songId);
            try {
                const ok = await moveSongFile((await getSongById(songId)) || song, btn.dataset.songId, moving);
                showToast(ok ? `Moved to ${target?.title || 'the song'}` : 'Could not move that.', ok ? 'success' : 'danger');
                if (ok) onChanged?.();
            } catch (err) {
                console.warn('[Song files] move failed:', err);
                showToast('Could not move that.', 'danger');
            }
            busy = false;
            view = 'list';
            await reload();
            return;
        }
        const li = btn.closest('.sf-row');
        const row = li && find(li.dataset.rid);
        if (!row) return;
        if (act === 'move') {
            moving = row;
            const current = (await getSongById(songId)) || song;
            moveSongs = (await getAllSongs())
                .filter((x) => !x.isAlbumTabContainer && x.id !== current.id)
                .map((x) => ({ id: x.id, title: x.title, artist: x.artist, album: x.album }))
                .sort((x, y) => (x.artist || '').localeCompare(y.artist || '') || (x.title || '').localeCompare(y.title || ''));
            view = 'move';
            paint();
            return;
        }
        if (act === 'delete') { confirmRid = rowId(row); paint(`[data-rid="${CSS.escape(rowId(row))}"] [data-act="delete-here"]`); return; }
        if (act === 'cancel-delete') { confirmRid = null; paint(`[data-rid="${CSS.escape(rowId(row))}"] [data-act="delete"]`); return; }
        if (act === 'delete-here' || act === 'delete-all') {
            busy = true;
            btn.disabled = true;
            try {
                const r = await deleteSongFile((await getSongById(songId)) || song, row, { syncCopy: act === 'delete-all' });
                showToast(act === 'delete-all' && r.syncCopy === 'none' ? 'Deleted. The sync location has no copy of this song.' : 'Deleted', 'success');
                onChanged?.();
            } catch (err) {
                console.warn('[Song files] delete failed:', err);
                showToast(act === 'delete-all' ? 'Could not reach the sync copy, so nothing was deleted.' : 'Could not delete that.', 'danger');
            }
            busy = false;
            confirmRid = null;
            if (syncStatus === 'synced') syncStatus = 'pending';   // the song now differs from what was synced
            await reload('.sf-row .tabpick-act');
        }
    });

    await reload();
    // Where each file sits in the sync copy: one manifest read, skipped when it would need a prompt
    locateInSyncCopy((await getSongById(songId)) || song, SECTIONS.flatMap((x) => data[x.key])).then((c) => { if (c && modal.isConnected) { copy = c; if (view === 'list' && !confirmRid) paint(); } });
    // The sync status reads every song's fingerprint, so it fills in after the list is up
    syncStatusOf((await getSongById(songId)) || song).then((r) => { if (modal.isConnected && (r.status !== syncStatus || r.syncedAt !== syncedAt)) { syncStatus = r.status; syncedAt = r.syncedAt; if (view === 'list' && !confirmRid) paint(); } });
    modal.querySelector('.sf-row .tabpick-act, #sfClose')?.focus({ preventScroll: true });
}
