// libraryMissingFiles.js
// Tabs whose file is gone. Pure: callers pass the song records and the ids of the stored files that exist. Settings >
// Library > Upkeep > Missing files shows the result and removes the dead tab entries.
// A tab with no file id (one given up to cloud storage, or one that never had a file) is not missing on the device alone.
// With hybrid sync the cloud copy is checked too: pass `remotePackIds` (packs the sync location holds) and `packIdOf`.

/**
 * Per song, the tabs that are missing. Each result has `kind`:
 *  - 'local': the tab names a stored file this device no longer holds. `inCloud` says the sync location holds the song's
 *    pack, so the file can come back and the entry should be kept.
 *  - 'cloud': hybrid sync removed every local file of the song, but the sync location holds no pack for it either. The
 *    file is gone everywhere.
 * `songTabCount` is how many tabs the song has in all, so a caller can say when removal leaves it with none.
 */
export function findMissingTabFiles(songs, storedIds, { remotePackIds = null, packIdOf = () => null } = {}) {
    const have = storedIds instanceof Set ? storedIds : new Set(storedIds);
    const out = [];
    for (const song of songs) {
        const tabs = Array.isArray(song?.tabOptions) ? song.tabOptions : [];
        if (!tabs.length) continue;
        const pid = remotePackIds ? packIdOf(song) : null;
        const inCloud = Boolean(pid && remotePackIds.has(pid));
        const missing = tabs.filter((t) => t?.fileStoreId && !have.has(t.fileStoreId));
        if (missing.length) {
            out.push({ song, tabs: missing, songTabCount: tabs.length, kind: 'local', inCloud });
        } else if (pid && !inCloud && tabs.every((t) => t && !t.fileStoreId)) {
            out.push({ song, tabs: [...tabs], songTabCount: tabs.length, kind: 'cloud', inCloud: false });
        }
    }
    return out.sort((a, b) => `${a.song.artist} ${a.song.album} ${a.song.title}`.localeCompare(`${b.song.artist} ${b.song.album} ${b.song.title}`));
}

/**
 * Tabs with no local file whose score the song's pack in cloud storage no longer lists, so no device can get them. The pack
 * lost the score when it was rebuilt on a device that did not hold the file. Pure: `remoteScoreHashes` maps a pack id to
 * the Set of score hashes its manifest lists, and only packs the caller read are judged. A tab without a hash is skipped,
 * because there is nothing to compare. Each result has `kind: 'unreachable'`.
 */
export function findUnreachableTabs(songs, remoteScoreHashes, { packIdOf = () => null } = {}) {
    const out = [];
    for (const song of songs) {
        const pid = packIdOf(song);
        const listed = pid ? remoteScoreHashes.get(pid) : null;
        if (!listed) continue;
        const tabs = (Array.isArray(song?.tabOptions) ? song.tabOptions : []).filter((t) => t && !t.fileStoreId && t.sha256 && !listed.has(t.sha256));
        if (tabs.length) out.push({ song, tabs, songTabCount: (song.tabOptions || []).length, kind: 'unreachable', inCloud: false });
    }
    return out;
}

/** Songs worth a manifest read: the ones with a tab that has a hash but no local file. */
export function songsWithUnstoredTabs(songs, packIdOf) {
    return songs.filter((s) => packIdOf(s) && (s.tabOptions || []).some((t) => t && !t.fileStoreId && t.sha256));
}
