// googleDrive.js
import { loadFile, hideFileMenu } from './main.js';

const CLIENT_ID = '1059497343032-rcmtq18q4bgrc495qbdkg2kpt0q0arq9.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const STORAGE_KEY = 'gdrive_auth';
const FOLDER_STORAGE_KEY = 'gdrive_last_folder';
const TABS_DIRECTORY_STORAGE_KEY = 'gdrive_tabs_directory';

let token = null;
let currentFolderId = 'root';
let folderHistory = [{ id: 'root', name: 'My Drive' }];
let tabsDirectory = null;
let currentSearchQuery = '';
let searchDebounceTimeout = null;

function saveCurrentFolder() {
    try {
        localStorage.setItem(FOLDER_STORAGE_KEY, JSON.stringify({
            currentFolderId,
            folderHistory
        }));
    } catch (e) {
        console.error('Failed to save last drive folder:', e);
    }
}

function loadSavedFolder() {
    try {
        const saved = localStorage.getItem(FOLDER_STORAGE_KEY);
        if (saved) {
            const parsed = JSON.parse(saved);
            if (parsed.currentFolderId && Array.isArray(parsed.folderHistory) && parsed.folderHistory.length > 0) {
                currentFolderId = parsed.currentFolderId;
                folderHistory = parsed.folderHistory;
            }
        }
    } catch (e) {
        console.error('Failed to load last drive folder:', e);
    }
}

function loadTabsDirectory() {
    try {
        const saved = localStorage.getItem(TABS_DIRECTORY_STORAGE_KEY);
        if (saved) {
            const parsed = JSON.parse(saved);
            if (parsed.id && parsed.name) tabsDirectory = parsed;
        }
    } catch (e) {
        console.error('Failed to load tabs directory:', e);
    }
}

function getDriveRoot() {
    return tabsDirectory || { id: 'root', name: 'My Drive' };
}

function resetFolderToDriveRoot() {
    const root = getDriveRoot();
    currentFolderId = root.id;
    folderHistory = [{ id: root.id, name: root.name }];
    saveCurrentFolder();
}

// Load saved root and folder location on script initialization
loadTabsDirectory();
loadSavedFolder();
if (folderHistory[0]?.id !== getDriveRoot().id) resetFolderToDriveRoot();

export function isTokenValid() {
    try {
        const storedAuth = localStorage.getItem(STORAGE_KEY);
        if (!storedAuth) return false;

        const authData = JSON.parse(storedAuth);
        if (authData.access_token && authData.expiry_date && Date.now() < (authData.expiry_date - 60000)) {
            token = authData.access_token;
            return true;
        }
        return false;
    } catch (err) {
        return false;
    }
}

export function clearStoredToken() {
    localStorage.removeItem(STORAGE_KEY);
    token = null;
}

function getRedirectUri() {
    return window.location.origin + window.location.pathname;
}

export function redirectToGoogleAuth() {
    const redirectUri = getRedirectUri();
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
        `client_id=${encodeURIComponent(CLIENT_ID)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_type=token` +
        `&scope=${encodeURIComponent(SCOPE)}` +
        `&include_granted_scopes=true` +
        `&state=open_drive_browser`;

    window.location.href = authUrl;
}

export function openDriveModal() {
    const modal = document.getElementById('driveModal');
    if (!modal) return;
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    // Reset search input
    const searchInput = document.getElementById('driveSearchInput');
    if (searchInput) searchInput.value = currentSearchQuery;

    loadDriveFiles();
}

export function closeDriveModal() {
    const modal = document.getElementById('driveModal');
    if (!modal) return;
    modal.style.display = 'none';
    document.body.style.overflow = '';
}

function formatBytes(bytes, decimals = 1) {
    if (!+bytes) return '';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function formatDate(dateStr) {
    if (!dateStr) return '';
    try {
        const d = new Date(dateStr);
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (e) {
        return '';
    }
}

function getFileIconClass(mimeType, name = '') {
    const lower = name.toLowerCase();
    if (mimeType === 'application/vnd.google-apps.folder') {
        return { icon: 'bi-folder-fill', color: 'text-warning' };
    }
    if (lower.endsWith('.pdf')) {
        return { icon: 'bi-file-earmark-pdf-fill', color: 'text-danger' };
    }
    if (lower.endsWith('.gp') || lower.endsWith('.gp3') || lower.endsWith('.gp4') || lower.endsWith('.gp5') || lower.endsWith('.gpx')) {
        return { icon: 'bi-music-note-beamed', color: 'text-info' };
    }
    if (lower.endsWith('.txt')) {
        return { icon: 'bi-file-earmark-text-fill', color: 'text-secondary' };
    }
    return { icon: 'bi-file-earmark-fill', color: 'text-light' };
}

function renderBreadcrumbs() {
    const container = document.getElementById('driveBreadcrumbs');
    if (!container) return;

    if (currentSearchQuery) {
        container.innerHTML = `<span class="text-white-50"><i class="bi-search me-1"></i> Search results for "${escapeHtml(currentSearchQuery)}"</span>`;
        return;
    }

    container.innerHTML = folderHistory.map((item, index) => {
        const isLast = index === folderHistory.length - 1;
        const icon = index === 0 ? '<i class="bi-folder2-open me-1"></i>' : '';
        if (isLast) {
            return `<span class="drive-breadcrumb-item active">${icon}${escapeHtml(item.name)}</span>`;
        }
        return `
            <span class="drive-breadcrumb-item" data-history-index="${index}">${icon}${escapeHtml(item.name)}</span>
            <span class="text-white-50 opacity-50"><i class="bi-chevron-right" style="font-size:0.65rem;"></i></span>
        `;
    }).join('');

    container.querySelectorAll('.drive-breadcrumb-item[data-history-index]').forEach(el => {
        el.addEventListener('click', () => {
            const idx = parseInt(el.getAttribute('data-history-index'), 10);
            folderHistory = folderHistory.slice(0, idx + 1);
            currentFolderId = folderHistory[folderHistory.length - 1].id;
            saveCurrentFolder();
            loadDriveFiles();
        });
    });

    const resetRootBtn = document.getElementById('driveResetTabsDirectoryBtn');
    if (resetRootBtn) resetRootBtn.hidden = !tabsDirectory;
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function loadDriveFiles() {
    const listContainer = document.getElementById('driveFileListContainer');
    if (!listContainer) return;

    renderBreadcrumbs();

    listContainer.innerHTML = `
        <div class="text-center py-5 text-muted">
            <div class="spinner-border spinner-border-sm text-primary mb-2" role="status"></div>
            <div class="small">Loading files from Google Drive...</div>
        </div>
    `;

    if (!isTokenValid()) {
        clearStoredToken();
        closeDriveModal();
        redirectToGoogleAuth();
        return;
    }

    try {
        let query = "trashed = false and (mimeType = 'application/vnd.google-apps.folder' or name contains '.gp' or name contains '.gp3' or name contains '.gp4' or name contains '.gp5' or name contains '.gpx' or name contains '.pdf' or name contains '.txt')";

        if (currentSearchQuery.trim()) {
            const cleanSearch = currentSearchQuery.trim().replace(/'/g, "\\'");
            query += ` and '${getDriveRoot().id}' in parents and name contains '${cleanSearch}'`;
        } else {
            query += ` and '${currentFolderId}' in parents`;
        }

        const url = `https://www.googleapis.com/drive/v3/files?` +
            `q=${encodeURIComponent(query)}` +
            `&fields=nextPageToken,files(id,name,mimeType,size,modifiedTime)` +
            `&orderBy=folder,name` +
            `&pageSize=100`;

        const res = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` }
        });

        if (!res.ok) {
            if (res.status === 401) {
                clearStoredToken();
                closeDriveModal();
                redirectToGoogleAuth();
                return;
            }
            if ((res.status === 404 || res.status === 400) && currentFolderId !== getDriveRoot().id) {
                console.warn('[Drive] Saved folder inaccessible, falling back to tabs directory');
                resetFolderToDriveRoot();
                loadDriveFiles();
                return;
            }
            throw new Error(`Google Drive API error: ${res.status} ${res.statusText}`);
        }

        const data = await res.json();
        const files = data.files || [];

        renderFileList(files);
    } catch (err) {
        console.error('[Drive Error]', err);
        listContainer.innerHTML = `
            <div class="text-center py-4 text-white-50">
                <i class="bi-exclamation-triangle text-warning fs-3 mb-2 d-block"></i>
                <div>Failed to load files from Google Drive.</div>
                <button class="btn btn-outline-primary btn-sm mt-3" id="driveRetryBtn">Try Again</button>
            </div>
        `;
        document.getElementById('driveRetryBtn')?.addEventListener('click', loadDriveFiles);
    }
}

function renderFileList(files) {
    const listContainer = document.getElementById('driveFileListContainer');
    if (!listContainer) return;

    if (files.length === 0) {
        listContainer.innerHTML = `
            <div class="text-center py-5 text-white-50">
                <i class="bi-folder2 text-secondary fs-2 mb-2 d-block"></i>
                <div>No supported tab files found (.gp, .pdf, .txt) in this location.</div>
            </div>
        `;
        return;
    }

    listContainer.innerHTML = files.map(file => {
        const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
        const { icon, color } = getFileIconClass(file.mimeType, file.name);
        const metaStr = isFolder ? 'Folder' : [formatBytes(file.size), formatDate(file.modifiedTime)].filter(Boolean).join(' • ');

        return `
            <div class="drive-file-item" data-file-id="${file.id}" data-is-folder="${isFolder}" data-file-name="${escapeHtml(file.name)}" data-mime-type="${file.mimeType || ''}">
                <div class="drive-file-item-left">
                    <span class="drive-file-icon ${color}">
                        <i class="bi ${icon}"></i>
                    </span>
                    <span class="drive-file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
                </div>
                <div class="drive-file-meta">${metaStr}</div>
            </div>
        `;
    }).join('');

    // Attach click listeners to file / folder items
    listContainer.querySelectorAll('.drive-file-item').forEach(item => {
        item.addEventListener('click', async () => {
            const isFolder = item.getAttribute('data-is-folder') === 'true';
            const fileId = item.getAttribute('data-file-id');
            const fileName = item.getAttribute('data-file-name');
            const mimeType = item.getAttribute('data-mime-type');

            if (isFolder) {
                currentSearchQuery = '';
                const searchInput = document.getElementById('driveSearchInput');
                if (searchInput) searchInput.value = '';
                folderHistory.push({ id: fileId, name: fileName });
                currentFolderId = fileId;
                saveCurrentFolder();
                loadDriveFiles();
            } else {
                // Fetch and open tab file
                item.style.opacity = '0.6';
                item.style.pointerEvents = 'none';
                const originalContent = item.innerHTML;
                item.innerHTML = `
                    <div class="d-flex align-items-center gap-2 text-primary py-1">
                        <div class="spinner-border spinner-border-sm" role="status"></div>
                        <span class="small">Downloading ${escapeHtml(fileName)}...</span>
                    </div>
                `;

                try {
                    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
                        headers: { Authorization: `Bearer ${token}` }
                    });

                    if (!res.ok) {
                        if (res.status === 401) {
                            clearStoredToken();
                            closeDriveModal();
                            redirectToGoogleAuth();
                            return;
                        }
                        throw new Error(`Download failed: ${res.statusText}`);
                    }

                    const blob = await res.blob();
                    const fileObj = new File([blob], fileName, { type: mimeType || 'application/octet-stream' });
                    closeDriveModal();
                    await loadFile(fileObj);
                } catch (err) {
                    console.error('Error downloading file from Drive:', err);
                    alert('Failed to download file from Google Drive.');
                    item.innerHTML = originalContent;
                    item.style.opacity = '1';
                    item.style.pointerEvents = 'auto';
                }
            }
        });
    });
}

function handleAuthRedirect() {
    if (!window.location.hash) return false;

    const hash = window.location.hash.substring(1);
    const params = new URLSearchParams(hash);
    const accessToken = params.get('access_token');
    const expiresIn = params.get('expires_in');
    const state = params.get('state');

    if (accessToken) {
        const authData = {
            access_token: accessToken,
            expiry_date: Date.now() + ((parseInt(expiresIn, 10) || 3600) * 1000)
        };
        token = authData.access_token;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(authData));

        const cleanUrl = window.location.pathname + window.location.search;
        window.history.replaceState(null, '', cleanUrl);

        if (state === 'open_drive_browser' || state === 'open_picker') {
            openDriveModal();
        }
        return true;
    }
    return false;
}

export function setupDrivePicker() {
    const loadBtn = document.getElementById('loadFromDriveBtn');
    if (loadBtn) {
        loadBtn.addEventListener('click', () => {
            hideFileMenu();
            if (!isTokenValid()) {
                redirectToGoogleAuth();
            } else {
                openDriveModal();
            }
        });
    }

    const closeBtn = document.getElementById('driveModalCloseBtn');
    closeBtn?.addEventListener('click', closeDriveModal);

    const refreshBtn = document.getElementById('driveRefreshBtn');
    refreshBtn?.addEventListener('click', () => loadDriveFiles());

    const setRootBtn = document.getElementById('driveSetTabsDirectoryBtn');
    setRootBtn?.addEventListener('click', () => {
        const currentFolder = folderHistory[folderHistory.length - 1];
        tabsDirectory = { id: currentFolder.id, name: currentFolder.name };
        localStorage.setItem(TABS_DIRECTORY_STORAGE_KEY, JSON.stringify(tabsDirectory));
        resetFolderToDriveRoot();
        loadDriveFiles();
    });

    const resetRootBtn = document.getElementById('driveResetTabsDirectoryBtn');
    resetRootBtn?.addEventListener('click', () => {
        tabsDirectory = null;
        localStorage.removeItem(TABS_DIRECTORY_STORAGE_KEY);
        resetFolderToDriveRoot();
        loadDriveFiles();
    });

    const signOutBtn = document.getElementById('driveSignOutBtn');
    signOutBtn?.addEventListener('click', () => {
        clearStoredToken();
        localStorage.removeItem(FOLDER_STORAGE_KEY);
        currentFolderId = 'root';
        folderHistory = [{ id: 'root', name: 'My Drive' }];
        closeDriveModal();
        alert('Disconnected Google Drive account.');
    });

    const searchInput = document.getElementById('driveSearchInput');
    searchInput?.addEventListener('input', (e) => {
        clearTimeout(searchDebounceTimeout);
        searchDebounceTimeout = setTimeout(() => {
            currentSearchQuery = e.target.value;
            loadDriveFiles();
        }, 350);
    });

    // Close on clicking backdrop
    const modal = document.getElementById('driveModal');
    modal?.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeDriveModal();
        }
    });

    // Check if returning from Google OAuth redirect
    handleAuthRedirect();
}


