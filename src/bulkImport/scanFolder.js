// scanFolder.js
// Choose a folder and list every tab file (or, for audio mode, every audio file) inside it, subfolders included. Three ways in, one result:
//   - desktop app: Tauri's folder dialog and fs plugin
//   - Chrome and Edge: the File System Access API
//   - other browsers: a folder input (webkitdirectory), which hands over the files at once
// Result: { rootName, entries: [{ path, dirs, name, ext, size, getFile() }] }. `dirs` are the folders above the file, from the
// chosen folder's own name down. Nothing is read until getFile() is called.

import { SUPPORTED_TAB_EXTENSIONS } from '../utils/fileHandlingUtils.js';

const tauri = () => window.__TAURI__;
const hasNative = () => typeof tauri()?.dialog?.open === 'function' && typeof tauri()?.fs?.readDir === 'function';
const hasBrowserPicker = () => typeof window.showDirectoryPicker === 'function';
const isPhone = () => /android|iphone|ipad|ipod/i.test(navigator.userAgent || '');
const hasFolderInput = () => !isPhone() && 'webkitdirectory' in document.createElement('input');

/** Can this client choose a folder? Phones cannot: their pickers hand over files, not folders (see pickFilesOnly). */
export function canPickFolder() {
    if (hasNative()) return !isPhone();
    return hasBrowserPicker() || hasFolderInput();
}

/** Phones choose several files instead of a folder. */
export const pickFilesOnly = () => isPhone() && !hasBrowserPicker() && !(hasNative() && !isPhone());

const extOf = (name) => (String(name).split('.').pop() || '').toLowerCase();
export const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'flac'];
// What a scan keeps: tab files, or audio files (Bulk import's two modes)
const wanted = (kind) => (name) => (kind === 'audio' ? AUDIO_EXTENSIONS : SUPPORTED_TAB_EXTENSIONS).includes(extOf(name));
const skipDir = (name) => name.startsWith('.') || name === '__MACOSX' || name === 'node_modules';
const skipFile = (name) => name.startsWith('.') || name.startsWith('~$');
const natural = (a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' });

async function scanNative(onProgress, signal, kind) {
    const isTab = wanted(kind);
    const { dialog, fs } = tauri();
    // recursive: lets the fs plugin reach the files inside the chosen folder
    const picked = await dialog.open({ directory: true, multiple: false, recursive: true, title: kind === 'audio' ? 'Choose a folder of audio files' : 'Choose a folder of tabs' });
    if (!picked) return null;
    const root = Array.isArray(picked) ? picked[0] : picked;
    const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
    const rootName = root.split(/[\\/]/).filter(Boolean).pop() || root;
    const entries = [];
    const walk = async (dir, dirs) => {
        if (signal?.aborted) return;
        let items = [];
        try { items = await fs.readDir(dir); } catch (e) { console.warn('[Bulk import] Cannot read', dir, e); return; }
        for (const item of items) {
            const path = `${dir.replace(/[\\/]+$/, '')}${sep}${item.name}`;
            if (item.isDirectory) {
                if (!skipDir(item.name)) await walk(path, [...dirs, item.name]);
            } else if (item.isFile && isTab(item.name) && !skipFile(item.name)) {
                entries.push({
                    path: [...dirs.slice(1), item.name].join('/'), dirs, name: item.name, ext: extOf(item.name), size: null,
                    getFile: async () => new File([await fs.readFile(path)], item.name)
                });
                onProgress?.(entries.length);
            }
        }
    };
    await walk(root, [rootName]);
    return { rootName, entries: entries.sort(natural) };
}

async function scanBrowser(onProgress, signal, kind) {
    const isTab = wanted(kind);
    let handle;
    try { handle = await window.showDirectoryPicker({ id: 'majestictab-import', mode: 'read' }); }
    catch (err) { if (err?.name === 'AbortError') return null; throw err; }
    const entries = [];
    const walk = async (dir, dirs) => {
        if (signal?.aborted) return;
        for await (const [name, child] of dir.entries()) {
            if (child.kind === 'directory') {
                if (!skipDir(name)) await walk(child, [...dirs, name]);
            } else if (isTab(name) && !skipFile(name)) {
                entries.push({
                    path: [...dirs.slice(1), name].join('/'), dirs, name, ext: extOf(name), size: null,
                    getFile: () => child.getFile()
                });
                onProgress?.(entries.length);
            }
        }
    };
    await walk(handle, [handle.name]);
    return { rootName: handle.name, entries: entries.sort(natural) };
}

/** A folder chosen with a folder input: its files carry their path in webkitRelativePath. */
export function scanFileList(files, kind = 'tabs') {
    const isTab = wanted(kind);
    const list = [...files];
    if (!list.length) return null;
    let rootName = '';
    const entries = [];
    for (const file of list) {
        const parts = String(file.webkitRelativePath || file.name).split('/').filter(Boolean);
        if (!rootName) rootName = parts.length > 1 ? parts[0] : '';
        const dirs = parts.slice(0, -1);
        if (dirs.slice(1).some(skipDir) || !isTab(file.name) || skipFile(file.name)) continue;
        entries.push({ path: parts.slice(1).join('/') || file.name, dirs, name: file.name, ext: extOf(file.name), size: file.size, getFile: async () => file });
    }
    return { rootName: rootName || 'Folder', entries: entries.sort(natural) };
}

function scanFolderInput(kind) {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.webkitdirectory = true;
        input.multiple = true;
        input.style.display = 'none';
        input.addEventListener('change', () => { const r = scanFileList(input.files || [], kind); input.remove(); resolve(r); }, { once: true });
        input.addEventListener('cancel', () => { input.remove(); resolve(null); }, { once: true });
        document.body.appendChild(input);
        input.click();
    });
}

// Phones: a plain multiple-file input. No accept list (iOS greys out types it does not know) and the input is off-screen, not display:none.
function scanFilesInput(kind) {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0';
        input.addEventListener('change', () => { const r = scanFileList(input.files || [], kind); input.remove(); resolve(r && r.entries.length ? { ...r, rootName: 'Chosen files' } : r); }, { once: true });
        input.addEventListener('cancel', () => { input.remove(); resolve(null); }, { once: true });
        document.body.appendChild(input);
        input.click();
    });
}

/**
 * Choose a folder and list its tab files. Must run from a click. Resolves null when cancelled.
 * @param {function(number)} [onProgress]  files found so far
 * @param {AbortSignal} [signal]
 * @param {'tabs'|'audio'} [kind]  which files to keep
 */
export async function pickAndScanFolder(onProgress, signal, kind = 'tabs') {
    if (pickFilesOnly()) return scanFilesInput(kind);
    if (hasNative() && !isPhone()) return scanNative(onProgress, signal, kind);
    if (hasBrowserPicker()) return scanBrowser(onProgress, signal, kind);
    if (hasFolderInput()) return scanFolderInput(kind);
    throw new Error('This device cannot open a folder. Use the desktop app, Chrome or Edge.');
}
