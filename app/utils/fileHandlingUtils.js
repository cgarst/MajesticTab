// fileHandlingUtils.js
/**
 * Common utilities for file handling and state management
 */

/**
 * File state interface for both PDF and GP files
 */
export class FileState {
    constructor() {
        this.canvases = [];
        this.pages = [];
        this.currentPageIndex = 0;
    }

    reset() {
        this.canvases.length = 0;
        this.pages.length = 0;
        this.currentPageIndex = 0;
    }
}

/**
 * Check if a file is of a given type
 * @param {File} file File to check
 * @param {string[]} extensions Array of allowed extensions
 * @returns {boolean} True if file type matches
 */
export function isFileType(file, extensions) {
    const ext = file.name.split('.').pop().toLowerCase();
    return extensions.includes(ext);
}

/**
 * Standard tab file extensions natively supported by MajesticTab
 */
export const SUPPORTED_TAB_EXTENSIONS = ['gp', 'gp3', 'gp4', 'gp5', 'gpx', 'pdf', 'txt'];

/**
 * Check if a file is a supported tab format or matches an active file adapter
 * @param {File|Blob|{name: string}} file File to check
 * @returns {Promise<boolean>}
 */
export async function isSupportedTabFile(file) {
    if (!file) return false;
    const name = typeof file === 'string' ? file : (file.name || '');
    if (!name) return false;
    const ext = name.split('.').pop().toLowerCase();
    if (SUPPORTED_TAB_EXTENSIONS.includes(ext)) {
        return true;
    }
    if (typeof file === 'object' && (file instanceof Blob || file instanceof File)) {
        try {
            const { hasMatchingFileAdapter } = await import('../fileAdapters.js');
            if (typeof hasMatchingFileAdapter === 'function') {
                return await hasMatchingFileAdapter(file);
            }
        } catch {
            // ignore
        }
    }
    return false;
}

/**
 * Test whether drag dataTransfer items contain acceptable files during dragover/dragenter.
 * Rejects obvious non-file drags or non-tab MIME types (images, videos, audio).
 * @param {DragEvent} e
 * @returns {boolean}
 */
export function canAcceptTabDrop(e) {
    if (!e || !e.dataTransfer) return false;
    const types = Array.from(e.dataTransfer.types || []);
    if (!types.includes('Files')) return false;

    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
        for (const item of e.dataTransfer.items) {
            if (item.kind !== 'file') return false;
            const type = (item.type || '').toLowerCase();
            if (type.startsWith('image/') || type.startsWith('audio/') || type.startsWith('video/')) {
                return false;
            }
        }
    }
    return true;
}

/**
 * Show loading progress UI
 * @param {HTMLElement} container Progress container element
 * @param {HTMLElement} bar Progress bar element
 * @param {boolean} indeterminate Whether progress is indeterminate
 */
export function showProgress(container, bar, indeterminate = true) {
    container.style.display = 'block';
    if (indeterminate) {
        bar.classList.add('indeterminate');
    } else {
        bar.classList.remove('indeterminate');
        bar.style.width = '0%';
    }
}

/**
 * Hide loading progress UI
 * @param {HTMLElement} container Progress container element
 * @param {HTMLElement} bar Progress bar element
 */
export function hideProgress(container, bar) {
    bar.classList.remove('indeterminate');
    container.style.display = 'none';
}

/**
 * Update progress bar
 * @param {HTMLElement} bar Progress bar element
 * @param {number} progress Progress percentage (0-100)
 */
export function updateProgress(bar, progress) {
    bar.style.width = `${progress.toFixed(1)}%`;
}