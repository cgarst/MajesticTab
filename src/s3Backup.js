// s3Backup.js
// S3-compatible bucket storage backend for incremental backups (see incrementalBackup.js for the layout).
// Backups live under "MajesticTab Backup/" inside the configured prefix of the bucket.
import { ROOT_FOLDER_NAME, BLOBS_FOLDER_NAME, MANIFESTS_FOLDER_NAME, isManifestName, runPool } from './incrementalBackup.js';
import { getS3Config, s3List, s3Get, s3Put, s3Delete, s3BasePrefix } from './s3Client.js';

const READ_CONCURRENCY = 6;

/** Storage backend for the saved bucket settings, or null when none are saved. */
export function createS3Backend(config = getS3Config()) {
    if (!config) return null;
    const rootPrefix = `${s3BasePrefix(config)}${ROOT_FOLDER_NAME}/`;
    const blobsPrefix = `${rootPrefix}${BLOBS_FOLDER_NAME}/`;
    const manifestsPrefix = `${rootPrefix}${MANIFESTS_FOLDER_NAME}/`;
    const nameOf = (key) => key.slice(key.lastIndexOf('/') + 1);
    const toEntry = (object) => ({ id: object.key, name: nameOf(object.key), size: object.size, modifiedTime: object.modifiedTime });

    return {
        label: 'your S3 bucket',
        location: `${config.bucket} / ${rootPrefix.replace(/\/$/, '')}`,

        // Buckets have no folders to create; the backup exists once it holds a manifest or blob
        async open({ create }) {
            if (create) return true;
            const { objects } = await s3List(config, manifestsPrefix);
            return objects.length > 0 || (await s3List(config, blobsPrefix)).objects.length > 0;
        },

        async listBlobs() {
            const { objects } = await s3List(config, blobsPrefix);
            return objects.filter(o => o.key.endsWith('.bin')).map(toEntry);
        },

        putBlob: (hash, buffer) => s3Put(config, `${blobsPrefix}${hash}.bin`, buffer),

        async readBlob(entry) {
            return (await s3Get(config, entry.id)).arrayBuffer();
        },

        deleteBlob: (entry) => s3Delete(config, entry.id),

        async listManifests() {
            const { objects } = await s3List(config, manifestsPrefix);
            const entries = objects.map(toEntry).filter(e => isManifestName(e.name));
            // Object listings carry no custom properties, so the counts come from each manifest's summary
            await runPool(entries, READ_CONCURRENCY, async (entry) => {
                try {
                    const summary = (await (await s3Get(config, entry.id)).json()).summary;
                    entry.counts = summary ? { tabs: summary.tabsCount || 0, soundFonts: summary.soundFontsCount || 0 } : null;
                } catch (_) { entry.counts = null; }
            });
            return entries;
        },

        putManifest: (name, text) => s3Put(config, `${manifestsPrefix}${name}`, text, 'application/json'),

        async readManifest(entry) {
            return (await s3Get(config, entry.id)).json();
        },

        deleteManifest: (entry) => s3Delete(config, entry.id)
    };
}
