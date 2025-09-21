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