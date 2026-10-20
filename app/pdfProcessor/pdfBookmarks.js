// pdfBookmarks.js
// Bookmark management and document outline navigation for PDF documents

import { toggleSynthPanel, toggleScoreOptionsPanel } from '../gpProcessor/gpPlayer.js';
import { toggleYouTubePanel } from '../youtubePlayer.js';

let bookmarksState = {
    isOpen: false,
    file: null,
    pdfDoc: null,
    outline: [],
    userBookmarks: [],
    currentPageIndex: 0,
    onNavigateToPage: null
};

/**
 * Generate localStorage key for a specific PDF file
 */
function getStorageKey(file) {
    if (!file) return 'mt_pdf_bookmarks_default';
    const name = file.name || 'document';
    const size = file.size || 0;
    const pageSuffix = file.startPage ? `_p${file.startPage}_${file.endPage || file.startPage}` : '';
    return `mt_pdf_bookmarks_${encodeURIComponent(name)}_${size}${pageSuffix}`;
}

/**
 * Load user bookmarks for a PDF file from localStorage
 */
function loadUserBookmarks(file) {
    try {
        const raw = localStorage.getItem(getStorageKey(file));
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed;
        }
    } catch (e) {
        console.warn('[PDF Bookmarks] Failed to load bookmarks from storage:', e);
    }
    return [];
}

/**
 * Save user bookmarks for a PDF file to localStorage
 */
function saveUserBookmarks(file, bookmarks) {
    try {
        localStorage.setItem(getStorageKey(file), JSON.stringify(bookmarks));
    } catch (e) {
        console.warn('[PDF Bookmarks] Failed to save bookmarks to storage:', e);
    }
}

/**
 * Extract document outline (Table of Contents) from PDF.js document
 */
export async function extractPdfOutline(pdfDoc) {
    if (!pdfDoc || !pdfDoc.getOutline) return [];
    try {
        const rawOutline = await pdfDoc.getOutline();
        if (!rawOutline || !rawOutline.length) return [];

        const items = [];
        async function traverse(nodes, depth = 0) {
            for (const node of nodes) {
                let pageIndex = -1;
                try {
                    let dest = node.dest;
                    if (typeof dest === 'string') {
                        dest = await pdfDoc.getDestination(dest);
                    }
                    if (Array.isArray(dest) && dest.length > 0) {
                        const ref = dest[0];
                        if (ref && typeof ref === 'object') {
                            pageIndex = await pdfDoc.getPageIndex(ref);
                        } else if (typeof ref === 'number') {
                            pageIndex = ref;
                        }
                    } else if (typeof dest === 'number') {
                        pageIndex = dest;
                    }
                } catch {
                    // Ignore destination parsing error for individual outline item
                }

                if (pageIndex >= 0 && pageIndex < (pdfDoc.numPages || 10000)) {
                    items.push({
                        title: node.title || `Section (Page ${pageIndex + 1})`,
                        pageIndex,
                        depth,
                        isOutline: true
                    });
                }

                if (node.items && node.items.length > 0) {
                    await traverse(node.items, depth + 1);
                }
            }
        }

        await traverse(rawOutline, 0);
        return items;
    } catch (err) {
        console.warn('[PDF Bookmarks] Failed to extract document outline:', err);
        return [];
    }
}

/**
 * Update panel positioning relative to top navigation bar
 */
export function updatePdfBookmarksPanelPosition() {
    const panel = document.getElementById('pdfBookmarksPanel');
    const toggleBtn = document.getElementById('pdfBookmarksBtn') || document.getElementById('navButtons');
    if (!panel || !bookmarksState.isOpen) return;

    if (window.innerWidth <= 576) {
        panel.classList.add('popup-from-bottom');
        panel.style.position = 'fixed';
        panel.style.top = 'auto';
        panel.style.bottom = '76px';
        panel.style.left = '50%';
        panel.style.transform = 'translateX(-50%)';
        return;
    }

    panel.classList.remove('popup-from-bottom');
    panel.style.bottom = 'auto';
    if (!toggleBtn) return;

    const rect = toggleBtn.getBoundingClientRect();
    panel.style.position = 'fixed';
    panel.style.top = `${rect.bottom + 8}px`;
    const centerX = rect.left + rect.width / 2;
    const halfPanelWidth = Math.min(185, (window.innerWidth - 24) / 2);
    const clampedLeft = Math.max(halfPanelWidth + 12, Math.min(window.innerWidth - halfPanelWidth - 12, centerX));
    panel.style.left = `${clampedLeft}px`;
    panel.style.transform = 'translateX(-50%)';
}

/**
 * Update bookmark button icon and state based on whether current page has a bookmark
 */
export function updateBookmarkButtonIcon() {
    const btn = document.getElementById('pdfBookmarksBtn');
    if (!btn) return;

    const currentPage = bookmarksState.currentPageIndex;
    const isBookmarked = bookmarksState.userBookmarks.some(b => b.pageIndex === currentPage) ||
                         bookmarksState.outline.some(o => (o.relativePageIndex !== undefined ? o.relativePageIndex : o.pageIndex) === currentPage);

    btn.innerHTML = isBookmarked
        ? '<i class="bi-bookmark-fill text-info"></i>'
        : '<i class="bi-bookmark"></i>';

    if (isBookmarked) {
        btn.classList.add('bookmarked');
    } else {
        btn.classList.remove('bookmarked');
    }

    const addLabel = document.getElementById('pdfAddBookmarkLabel');
    if (addLabel) {
        addLabel.textContent = `Bookmark Page ${currentPage + 1}`;
    }
}

/**
 * Render the combined list of user bookmarks and outline items
 */
export function renderBookmarksList() {
    const listEl = document.getElementById('pdfBookmarksList');
    const emptyMsg = document.getElementById('pdfNoBookmarksMsg');
    const countBadge = document.getElementById('pdfBookmarkCount');
    if (!listEl) return;

    listEl.innerHTML = '';
    const { userBookmarks, outline, currentPageIndex } = bookmarksState;
    const totalCount = userBookmarks.length + outline.length;

    if (countBadge) {
        countBadge.textContent = String(totalCount);
    }

    if (totalCount === 0) {
        if (emptyMsg) emptyMsg.style.display = 'block';
        return;
    }
    if (emptyMsg) emptyMsg.style.display = 'none';

    // 1. User Bookmarks section
    if (userBookmarks.length > 0) {
        const userHeader = document.createElement('div');
        userHeader.className = 'small text-muted fw-semibold px-1 pt-1 pb-1';
        userHeader.style.fontSize = '0.72rem';
        userHeader.textContent = 'Saved Bookmarks';
        listEl.appendChild(userHeader);

        userBookmarks.forEach((bm) => {
            const itemEl = document.createElement('div');
            const isActive = bm.pageIndex === currentPageIndex;
            itemEl.className = `pdf-bookmark-item ${isActive ? 'active' : ''}`;

            const targetWrapper = document.createElement('div');
            targetWrapper.className = 'pdf-bookmark-target';
            targetWrapper.title = `Jump to page ${bm.pageIndex + 1}`;
            targetWrapper.innerHTML = `
                <i class="bi-bookmark-fill text-info me-2 flex-shrink-0" style="font-size: 0.82rem;"></i>
                <span class="text-truncate small pdf-bookmark-title">${escapeHtml(bm.title)}</span>
            `;
            targetWrapper.addEventListener('click', () => {
                navigateToPage(bm.pageIndex);
            });

            const rightWrapper = document.createElement('div');
            rightWrapper.className = 'd-flex align-items-center gap-1 flex-shrink-0 ms-2';
            rightWrapper.innerHTML = `
                <span class="badge bg-secondary-subtle text-muted" style="font-size: 0.68rem;">p. ${bm.pageIndex + 1}</span>
                <button type="button" class="btn btn-sm pdf-bookmark-delete-btn" title="Delete bookmark">
                    <i class="bi-trash3" style="font-size: 0.72rem;"></i>
                </button>
            `;

            const deleteBtn = rightWrapper.querySelector('.pdf-bookmark-delete-btn');
            deleteBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                removeBookmark(bm.id);
            });

            itemEl.appendChild(targetWrapper);
            itemEl.appendChild(rightWrapper);
            listEl.appendChild(itemEl);
        });
    }

    // 2. Document Outline / Table of Contents section
    if (outline.length > 0) {
        const outlineHeader = document.createElement('div');
        outlineHeader.className = `small text-muted fw-semibold px-1 pb-1 ${userBookmarks.length > 0 ? 'pt-2 mt-1 border-top border-secondary-subtle' : 'pt-1'}`;
        outlineHeader.style.fontSize = '0.72rem';
        outlineHeader.textContent = 'Table of Contents';
        listEl.appendChild(outlineHeader);

        outline.forEach((item) => {
            const itemEl = document.createElement('div');
            const targetPageIndex = item.relativePageIndex !== undefined ? item.relativePageIndex : item.pageIndex;
            const isActive = targetPageIndex === currentPageIndex;
            const indentPx = Math.min(28, (item.depth || 0) * 12);
            itemEl.className = `pdf-bookmark-item ${isActive ? 'active' : ''}`;
            itemEl.style.paddingLeft = `${0.65 + indentPx / 16}rem`;

            const targetWrapper = document.createElement('div');
            targetWrapper.className = 'pdf-bookmark-target';
            targetWrapper.title = `Jump to page ${targetPageIndex + 1}`;
            targetWrapper.innerHTML = `
                <i class="bi-journal-text text-muted me-2 flex-shrink-0" style="font-size: 0.82rem;"></i>
                <span class="text-truncate small pdf-bookmark-title">${escapeHtml(item.title)}</span>
            `;
            targetWrapper.addEventListener('click', () => {
                navigateToPage(targetPageIndex);
            });

            const rightWrapper = document.createElement('div');
            rightWrapper.className = 'd-flex align-items-center gap-1 flex-shrink-0 ms-2';
            rightWrapper.innerHTML = `<span class="badge bg-secondary-subtle text-muted" style="font-size: 0.68rem;">p. ${item.pageIndex + 1}</span>`;

            itemEl.appendChild(targetWrapper);
            itemEl.appendChild(rightWrapper);
            listEl.appendChild(itemEl);
        });
    }
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Navigate to target page index using registered callback
 */
function navigateToPage(pageIndex) {
    bookmarksState.currentPageIndex = pageIndex;
    if (typeof bookmarksState.onNavigateToPage === 'function') {
        bookmarksState.onNavigateToPage(pageIndex);
    }
    updateBookmarkButtonIcon();
    renderBookmarksList();
}

/**
 * Add a new user bookmark for the current page
 */
export function addBookmarkForCurrentPage(customTitle = null) {
    const pageIndex = bookmarksState.currentPageIndex;
    const defaultTitle = `Page ${pageIndex + 1}`;
    let title = customTitle;

    if (title === null) {
        title = window.prompt(`Bookmark title for Page ${pageIndex + 1}:`, defaultTitle);
        if (title === null) return; // User cancelled prompt
    }

    title = (title || '').trim() || defaultTitle;
    const newBookmark = {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        pageIndex,
        title,
        createdAt: Date.now()
    };

    bookmarksState.userBookmarks.push(newBookmark);
    saveUserBookmarks(bookmarksState.file, bookmarksState.userBookmarks);
    updateBookmarkButtonIcon();
    renderBookmarksList();
}

/**
 * Remove a user bookmark by ID
 */
export function removeBookmark(id) {
    bookmarksState.userBookmarks = bookmarksState.userBookmarks.filter(b => b.id !== id);
    saveUserBookmarks(bookmarksState.file, bookmarksState.userBookmarks);
    updateBookmarkButtonIcon();
    renderBookmarksList();
}

/**
 * Toggle the PDF Bookmarks panel open/closed
 */
export function togglePdfBookmarksPanel(forceState = null) {
    const panel = document.getElementById('pdfBookmarksPanel');
    const toggleBtn = document.getElementById('pdfBookmarksBtn');
    if (!panel) return;

    const newState = forceState !== null ? forceState : !bookmarksState.isOpen;
    bookmarksState.isOpen = newState;

    if (newState) {
        toggleSynthPanel(false);
        toggleScoreOptionsPanel(false);
        toggleYouTubePanel(false);

        updatePdfBookmarksPanelPosition();
        renderBookmarksList();
        panel.style.display = 'block';
        toggleBtn?.classList.add('active');
    } else {
        panel.style.display = 'none';
        toggleBtn?.classList.remove('active');
    }
}

/**
 * Initialize bookmarks state when a new PDF file and document are loaded
 */
export async function setPdfDocument(file, pdfDoc, onNavigateToPage) {
    bookmarksState.file = file;
    bookmarksState.pdfDoc = pdfDoc;
    bookmarksState.onNavigateToPage = onNavigateToPage;
    bookmarksState.userBookmarks = loadUserBookmarks(file);
    const rawOutline = await extractPdfOutline(pdfDoc);

    const startPage = (file && file.startPage) ? parseInt(file.startPage, 10) : 1;
    const endPage = (file && file.endPage) ? parseInt(file.endPage, 10) : (pdfDoc.numPages || 10000);
    const startIdx = startPage - 1;
    const endIdx = endPage - 1;

    // Filter outline to only include items within the active page range
    bookmarksState.outline = rawOutline
        .filter(item => item.pageIndex >= startIdx && item.pageIndex <= endIdx)
        .map(item => ({
            ...item,
            relativePageIndex: item.pageIndex - startIdx
        }));

    const toggleBtn = document.getElementById('pdfBookmarksBtn');
    if (toggleBtn) {
        toggleBtn.style.display = 'inline-flex';
    }

    updateBookmarkButtonIcon();
    renderBookmarksList();
}

/**
 * Update current page index when user navigates
 */
export function setBookmarkCurrentPageIndex(pageIndex) {
    bookmarksState.currentPageIndex = pageIndex;
    updateBookmarkButtonIcon();
    if (bookmarksState.isOpen) {
        renderBookmarksList();
    }
}

/**
 * Reset PDF bookmarks state when switching away from a PDF
 */
export function clearPdfBookmarks() {
    bookmarksState.isOpen = false;
    bookmarksState.file = null;
    bookmarksState.pdfDoc = null;
    bookmarksState.outline = [];
    bookmarksState.userBookmarks = [];
    bookmarksState.onNavigateToPage = null;

    const panel = document.getElementById('pdfBookmarksPanel');
    if (panel) panel.style.display = 'none';

    const toggleBtn = document.getElementById('pdfBookmarksBtn');
    if (toggleBtn) {
        toggleBtn.style.display = 'none';
        toggleBtn.classList.remove('active', 'bookmarked');
    }
}

/**
 * Initialize DOM event listeners for PDF bookmarks
 */
export function initPdfBookmarksUI() {
    const toggleBtn = document.getElementById('pdfBookmarksBtn');
    const closeBtn = document.getElementById('pdfBookmarksPanelCloseBtn');
    const addBtn = document.getElementById('pdfAddBookmarkBtn');
    const scoreOptionsBookmarksBtn = document.getElementById('scoreOptionsBookmarksBtn');

    toggleBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePdfBookmarksPanel();
    });

    closeBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePdfBookmarksPanel(false);
    });

    addBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        addBookmarkForCurrentPage();
    });

    scoreOptionsBookmarksBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleScoreOptionsPanel(false);
        togglePdfBookmarksPanel(true);
    });

    // Close panel when clicking outside
    document.addEventListener('click', (e) => {
        const panel = document.getElementById('pdfBookmarksPanel');
        const trigger = document.getElementById('pdfBookmarksBtn');
        if (bookmarksState.isOpen && panel && !panel.contains(e.target) && !trigger?.contains(e.target)) {
            togglePdfBookmarksPanel(false);
        }
    });

    window.addEventListener('resize', () => {
        if (bookmarksState.isOpen) {
            updatePdfBookmarksPanelPosition();
        }
    });
}
