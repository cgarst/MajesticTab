// googleDrive.js
import { loadFile, hideFileMenu } from './main.js';

const BROWSER_CLIENT_ID = '1059497343032-rcmtq18q4bgrc495qbdkg2kpt0q0arq9.apps.googleusercontent.com';
const DESKTOP_CLIENT_ID = '1059497343032-f0st8cbjrjksj2m0hgjk70hh9cg7l910.apps.googleusercontent.com';
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
    if (window.__TAURI__?.core?.invoke && /android/i.test(navigator.userAgent)) {
        startAndroidGoogleAuth();
        return;
    }

    if (window.__TAURI__?.core?.invoke && window.__TAURI__?.event?.listen) {
        startTauriGoogleAuth();
        return;
    }

    const redirectUri = getRedirectUri();
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
        `client_id=${encodeURIComponent(BROWSER_CLIENT_ID)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_type=token` +
        `&scope=${encodeURIComponent(SCOPE)}` +
        `&include_granted_scopes=true` +
        `&state=open_drive_browser`;

    window.location.href = authUrl;
}

async function startAndroidGoogleAuth() {
    try {
        const authData = await window.__TAURI__.core.invoke('plugin:google-auth|authorize');
        if (!storeGoogleAuth(authData.accessToken, authData.expiresIn)) {
            throw new Error('Google authorization did not return an access token.');
        }
        openDriveModal();
    } catch (error) {
        console.error('Failed to authorize Google Drive on Android:', error);
        alert('Could not connect to Google Drive. Please try again.');
    }
}

async function startTauriGoogleAuth() {
    const tauri = window.__TAURI__;
    let port = null;
    let unlisten = null;
    let state;

    try {
        const { TAURI_CLIENT_SECRET } = await import('./googleDrive.local.js');
        if (!TAURI_CLIENT_SECRET || TAURI_CLIENT_SECRET === 'REPLACE_WITH_DESKTOP_CLIENT_SECRET') {
            throw new Error('Set the Desktop OAuth client secret in app/googleDrive.local.js.');
        }

        state = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
        const codeVerifier = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
        const challengeDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
        const codeChallenge = encodeBase64Url(new Uint8Array(challengeDigest));

        unlisten = await tauri.event.listen('oauth://url', async (event) => {
            unlisten?.();
            const callbackUrl = new URL(event.payload);
            const callbackState = callbackUrl.searchParams.get('state');

            if (callbackUrl.protocol !== 'http:'
                || callbackUrl.hostname !== '127.0.0.1'
                || callbackUrl.port !== String(port)
                || callbackState !== state) {
                console.error('Ignored an invalid Google OAuth callback.');
                return;
            }

            const authorizationCode = callbackUrl.searchParams.get('code');
            if (!authorizationCode) {
                console.error('Google OAuth callback did not contain an authorization code.');
                alert('Google authorization was not completed. Please try again.');
                return;
            }

            try {
                const response = await fetch('https://oauth2.googleapis.com/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        client_id: DESKTOP_CLIENT_ID,
                        client_secret: TAURI_CLIENT_SECRET,
                        code: authorizationCode,
                        code_verifier: codeVerifier,
                        grant_type: 'authorization_code',
                        redirect_uri: `http://127.0.0.1:${port}`
                    })
                });
                const authData = await response.json();
                if (!response.ok || !storeGoogleAuth(authData.access_token, authData.expires_in)) {
                    throw new Error(authData.error_description || 'Google token exchange failed.');
                }
                openDriveModal();
            } catch (error) {
                console.error('Failed to exchange Google authorization code:', error);
                alert('Could not connect to Google Drive. Please try again.');
            }
        });

        port = await tauri.core.invoke('plugin:oauth|start', { config: {} });

        const redirectUri = `http://127.0.0.1:${port}`;
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
            `client_id=${encodeURIComponent(DESKTOP_CLIENT_ID)}` +
            `&redirect_uri=${encodeURIComponent(redirectUri)}` +
            `&response_type=code` +
            `&scope=${encodeURIComponent(SCOPE)}` +
            `&state=${encodeURIComponent(state)}` +
            `&code_challenge=${encodeURIComponent(codeChallenge)}` +
            `&code_challenge_method=S256`;

        await tauri.core.invoke('plugin:opener|open_url', { url: authUrl });
    } catch (error) {
        unlisten?.();
        if (port !== null) {
            await tauri.core.invoke('plugin:oauth|cancel', { port }).catch(() => {});
        }
        console.error('Failed to start Google OAuth:', error);
        alert('Could not connect to Google Drive. Please try again.');
    }
}

function encodeBase64Url(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function storeGoogleAuth(accessToken, expiresIn) {
    if (!accessToken) return false;

    const authData = {
        access_token: accessToken,
        expiry_date: Date.now() + ((parseInt(expiresIn, 10) || 3600) * 1000)
    };
    token = authData.access_token;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(authData));
    return true;
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
        let files;
        if (currentSearchQuery.trim()) {
            const cleanSearch = currentSearchQuery.trim().replace(/'/g, "\\'");
            files = await searchDriveFolderTree(getDriveRoot().id, cleanSearch);
        } else {
            let query = "trashed = false and (mimeType = 'application/vnd.google-apps.folder' or name contains '.gp' or name contains '.gp3' or name contains '.gp4' or name contains '.gp5' or name contains '.gpx' or name contains '.pdf' or name contains '.txt')";
            query += ` and '${currentFolderId}' in parents`;

            files = await fetchDriveFiles(query);
        }

        files.sort((a, b) => {
            const aIsFolder = a.mimeType === 'application/vnd.google-apps.folder';
            const bIsFolder = b.mimeType === 'application/vnd.google-apps.folder';
            return Number(bIsFolder) - Number(aIsFolder) || a.name.localeCompare(b.name);
        });
        renderFileList(files);
    } catch (err) {
        if (err.status === 401) {
            clearStoredToken();
            closeDriveModal();
            redirectToGoogleAuth();
            return;
        }
        if ((err.status === 404 || err.status === 400) && currentFolderId !== getDriveRoot().id) {
            console.warn('[Drive] Saved folder inaccessible, falling back to tabs directory');
            resetFolderToDriveRoot();
            loadDriveFiles();
            return;
        }
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

async function fetchDriveFiles(query) {
    const files = [];
    let pageToken = null;

    do {
        const params = new URLSearchParams({
            q: query,
            fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime)',
            pageSize: '100'
        });
        if (pageToken) params.set('pageToken', pageToken);

        const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) {
            const error = new Error(`Google Drive API error: ${res.status} ${res.statusText}`);
            error.status = res.status;
            throw error;
        }

        const data = await res.json();
        files.push(...(data.files || []));
        pageToken = data.nextPageToken;
    } while (pageToken);

    return files;
}

async function searchDriveFolderTree(rootFolderId, searchTerm) {
    const pendingFolderIds = [rootFolderId];
    const visitedFolderIds = new Set();
    const matchingFiles = [];
    const supportedFileQuery = "name contains '.gp' or name contains '.gp3' or name contains '.gp4' or name contains '.gp5' or name contains '.gpx' or name contains '.pdf' or name contains '.txt'";

    while (pendingFolderIds.length > 0) {
        const folderId = pendingFolderIds.pop();
        if (visitedFolderIds.has(folderId)) continue;
        visitedFolderIds.add(folderId);

        const query = `trashed = false and '${folderId}' in parents and (mimeType = 'application/vnd.google-apps.folder' or (name contains '${searchTerm}' and (${supportedFileQuery})))`;
        const children = await fetchDriveFiles(query);

        for (const child of children) {
            if (child.mimeType === 'application/vnd.google-apps.folder') {
                pendingFolderIds.push(child.id);
                if (child.name.toLowerCase().includes(searchTerm.toLowerCase())) matchingFiles.push(child);
            } else {
                matchingFiles.push(child);
            }
        }
    }

    return matchingFiles;
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
        storeGoogleAuth(accessToken, expiresIn);

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


