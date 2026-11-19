// storage/spool.js
// Temporary files on disk for a long job that would otherwise hold every piece in memory (a backup of a library kept in the
// cloud downloads thousands of packs). Uses the origin-private file system where the browser can write to it from the page;
// elsewhere `put` hands the Blob back unchanged, so the job still works, only with its pieces in memory.
//
// A File from the spool is read from disk, so a Blob made of slices of it costs no memory. Keep the spool until the Blob is
// consumed, then call `release()`. A spool left behind by a closed page is cleared by the next `openSpool`.

const DIR = 'mtbackup-spool';

async function root() {
    try {
        if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
        const top = await navigator.storage.getDirectory();
        return top;
    } catch { return null; }
}

/** @returns {Promise<{ put(name: string, blob: Blob): Promise<Blob>, release(): Promise<void> }>} */
export async function openSpool() {
    const top = await root();
    let dir = null;
    if (top) {
        try {
            await top.removeEntry(DIR, { recursive: true }).catch(() => {});
            dir = await top.getDirectoryHandle(DIR, { create: true });
        } catch { dir = null; }
    }
    let usable = Boolean(dir);
    let n = 0;
    return {
        async put(_name, blob) {
            if (!usable) return blob;
            try {
                const handle = await dir.getFileHandle(`${++n}.bin`, { create: true });
                if (typeof handle.createWritable !== 'function') { usable = false; return blob; }
                const w = await handle.createWritable();
                try { await w.write(blob); } finally { await w.close(); }
                return await handle.getFile();
            } catch {
                // Out of space, or the browser refuses: keep this piece in memory and stop spooling
                usable = false;
                return blob;
            }
        },
        async release() {
            if (!top) return;
            try { await top.removeEntry(DIR, { recursive: true }); } catch { /* already gone */ }
        },
    };
}
