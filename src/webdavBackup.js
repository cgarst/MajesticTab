// webdavBackup.js
// WebDAV storage backend for incremental backups and Sync (see incrementalBackup.js for the layout).
// Backups live under "MajesticTab Backup/" inside the configured folder of the server.
import { ROOT_FOLDER_NAME, BLOBS_FOLDER_NAME, MANIFESTS_FOLDER_NAME, isManifestName, runPool } from './incrementalBackup.js';
import { getWebDavConfig, davList, davGet, davPut, davDelete, davEnsureDir, davJoin } from './webdavClient.js';

const READ_CONCURRENCY = 4;

/** Storage backend for the saved WebDAV settings, or null when none are saved. */
export function createWebDavBackend(config = getWebDavConfig()) {
    if (!config) return null;
    const root = ROOT_FOLDER_NAME;
    const blobsDir = davJoin(root, BLOBS_FOLDER_NAME);
    const manifestsDir = davJoin(root, MANIFESTS_FOLDER_NAME);
    const toEntry = (item) => ({ id: item.path, name: item.name, size: item.size, modifiedTime: item.modifiedTime });
    const files = async (dir) => ((await davList(config, dir)) || []).filter(item => !item.isDir);

    return {
        label: 'your WebDAV server',
        location: `${config.url.replace(/^https?:\/\//, '')}${config.folder ? `/${config.folder}` : ''}/${root}`,

        // Folders are real here: create them when a backup starts, and treat a missing one as "no backup yet"
        async open({ create }) {
            if (create) {
                await davEnsureDir(config, blobsDir);
                await davEnsureDir(config, manifestsDir);
                return true;
            }
            return (await files(manifestsDir)).length > 0 || (await files(blobsDir)).length > 0;
        },

        async listBlobs() {
            return (await files(blobsDir)).filter(item => item.name.endsWith('.bin')).map(toEntry);
        },

        putBlob: (hash, buffer) => davPut(config, davJoin(blobsDir, `${hash}.bin`), buffer),

        async readBlob(entry) {
            return (await davGet(config, entry.id)).arrayBuffer();
        },

        deleteBlob: (entry) => davDelete(config, entry.id),

        async listManifests() {
            const entries = (await files(manifestsDir)).map(toEntry).filter(e => isManifestName(e.name));
            // Listings carry no custom properties, so the counts come from each manifest's summary
            await runPool(entries, READ_CONCURRENCY, async (entry) => {
                try {
                    const summary = (await (await davGet(config, entry.id)).json()).summary;
                    entry.counts = summary ? { tabs: summary.tabsCount || 0, soundFonts: summary.soundFontsCount || 0, audio: summary.audioCount || 0 } : null;
                } catch (_) { entry.counts = null; }
            });
            return entries;
        },

        putManifest: (name, text) => davPut(config, davJoin(manifestsDir, name), text, 'application/json'),

        async readManifest(entry) {
            return (await davGet(config, entry.id)).json();
        },

        deleteManifest: (entry) => davDelete(config, entry.id)
    };
}
