// driveBackup.js
// Google Drive storage backend for incremental backups (see incrementalBackup.js for the layout).
// Backups live in a "MajesticTab Backup" folder at the root of My Drive, created by the app so the drive.file scope covers it.
import { driveFetch } from './googleDrive.js';
import { ROOT_FOLDER_NAME, BLOBS_FOLDER_NAME, MANIFESTS_FOLDER_NAME, isManifestName } from './incrementalBackup.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const MULTIPART_LIMIT = 8 * 1024 * 1024;
const RESUMABLE_PIECE = 16 * 1024 * 1024; // must be a multiple of 256 KiB
const DRIVE_ROOT = { id: 'root', name: 'My Drive' };

async function driveJson(url, options) {
    const res = await driveFetch(url, options);
    if (!res.ok) {
        let detail = res.statusText;
        try { detail = (await res.json()).error?.message || detail; } catch (_) {}
        throw new Error(`Google Drive API error (${res.status}): ${detail}`);
    }
    return res.json();
}

async function listChildren(parentId, extraQuery = '') {
    const files = [];
    let pageToken = null;
    do {
        const params = new URLSearchParams({
            q: `trashed = false and '${parentId}' in parents${extraQuery}`,
            fields: 'nextPageToken,files(id,name,size,modifiedTime,appProperties)',
            pageSize: '1000'
        });
        if (pageToken) params.set('pageToken', pageToken);
        const data = await driveJson(`${DRIVE_API}?${params}`);
        files.push(...(data.files || []));
        pageToken = data.nextPageToken;
    } while (pageToken);
    return files;
}

/** Create a subfolder, returning its id and name. */
async function createDriveFolder(name, parentId) {
    const folder = await driveJson(DRIVE_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] })
    });
    return { id: folder.id, name };
}

async function findOrCreateFolder(name, parentId, { create = true } = {}) {
    const found = await listChildren(parentId, ` and mimeType = '${FOLDER_MIME}' and name = '${name.replace(/'/g, "\\'")}'`);
    if (found.length) return found[0].id;
    if (!create) return null;
    return (await createDriveFolder(name, parentId)).id;
}

async function multipartUpload(name, parentId, mimeType, body, extraMeta = {}) {
    const boundary = `mt${crypto.randomUUID().replace(/-/g, '')}`;
    const meta = JSON.stringify({ name, parents: [parentId], mimeType, ...extraMeta });
    const payload = new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
        `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
        body,
        `\r\n--${boundary}--`
    ]);
    const res = await driveFetch(`${DRIVE_UPLOAD}?uploadType=multipart&fields=id`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: payload
    });
    if (!res.ok) throw new Error(`Google Drive upload failed (${res.status}) for ${name}`);
}

async function deleteDriveFile(fileId) {
    const res = await driveFetch(`${DRIVE_API}/${fileId}`, { method: 'DELETE' });
    // 404 means it is already gone, which is the outcome we wanted
    if (!res.ok && res.status !== 404) throw new Error(`Could not delete from Google Drive (${res.status}).`);
}

async function downloadDriveFile(fileId, label) {
    const res = await driveFetch(`${DRIVE_API}/${fileId}?alt=media`);
    if (!res.ok) throw new Error(`Could not download ${label} (${res.status}).`);
    return res;
}

/** Storage backend that keeps backups in "MajesticTab Backup" under the chosen Drive folder. */
export function createDriveBackend() {
    let folders = null;
    const parent = DRIVE_ROOT;

    return {
        label: 'Google Drive',
        location: `${parent.name} / ${ROOT_FOLDER_NAME}`,

        async open({ create }) {
            const rootId = await findOrCreateFolder(ROOT_FOLDER_NAME, parent.id, { create });
            if (!rootId) return false;
            const [blobsId, manifestsId] = await Promise.all([
                findOrCreateFolder(BLOBS_FOLDER_NAME, rootId, { create }),
                findOrCreateFolder(MANIFESTS_FOLDER_NAME, rootId, { create })
            ]);
            if (!blobsId || !manifestsId) return false;
            folders = { rootId, blobsId, manifestsId };
            return true;
        },

        listBlobs: () => listChildren(folders.blobsId),

        async putBlob(hash, buffer) {
            const name = `${hash}.bin`;
            if (buffer.byteLength <= MULTIPART_LIMIT) {
                await multipartUpload(name, folders.blobsId, 'application/octet-stream', buffer);
                return;
            }

            const init = await driveFetch(`${DRIVE_UPLOAD}?uploadType=resumable&fields=id`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json; charset=UTF-8',
                    'X-Upload-Content-Type': 'application/octet-stream',
                    'X-Upload-Content-Length': String(buffer.byteLength)
                },
                body: JSON.stringify({ name, parents: [folders.blobsId] })
            });
            const sessionUrl = init.headers.get('Location');
            if (!init.ok || !sessionUrl) throw new Error(`Google Drive upload failed (${init.status}) for ${name}`);

            const total = buffer.byteLength;
            for (let start = 0; start < total; start += RESUMABLE_PIECE) {
                const end = Math.min(start + RESUMABLE_PIECE, total);
                // The session URL is pre-authorized, so this is a plain fetch
                const res = await fetch(sessionUrl, {
                    method: 'PUT',
                    headers: { 'Content-Range': `bytes ${start}-${end - 1}/${total}` },
                    body: buffer.slice(start, end)
                });
                if (res.status !== 308 && !res.ok) throw new Error(`Google Drive upload failed (${res.status}) for ${name}`);
            }
        },

        async readBlob(entry, label) {
            return (await downloadDriveFile(entry.id, label || entry.name)).arrayBuffer();
        },

        deleteBlob: (entry) => deleteDriveFile(entry.id),

        async listManifests() {
            const manifests = await listChildren(folders.manifestsId, " and name contains 'manifest-'");
            return manifests.filter(f => isManifestName(f.name)).map(f => ({
                ...f,
                // Counts ride along as Drive properties, so listing needs no manifest downloads.
                // Absent on snapshots written before they were recorded.
                counts: f.appProperties?.tabs != null
                    ? { tabs: Number(f.appProperties.tabs), soundFonts: Number(f.appProperties.soundFonts) || 0 }
                    : null
            }));
        },

        putManifest(name, text, counts) {
            const appProperties = {
                tabs: String(counts.tabs),
                soundFonts: String(counts.soundFonts),
                songs: String(counts.songs)
            };
            return multipartUpload(name, folders.manifestsId, 'application/json', text, { appProperties });
        },

        async readManifest(entry) {
            return (await downloadDriveFile(entry.id, entry.name)).json();
        },

        deleteManifest: (entry) => deleteDriveFile(entry.id)
    };
}
