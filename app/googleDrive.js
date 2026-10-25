// googleDrive.js
import { loadFile, hideFileMenu } from './main.js';
import { saveStoredFile } from './fileStore.js';
import { showToast } from './utils/toast.js';
import { isIOSDevice } from './utils/iosAudioUnlock.js';

const BROWSER_CLIENT_ID = '1059497343032-rcmtq18q4bgrc495qbdkg2kpt0q0arq9.apps.googleusercontent.com';
const DESKTOP_CLIENT_ID = '1059497343032-f0st8cbjrjksj2m0hgjk70hh9cg7l910.apps.googleusercontent.com';
const IOS_CLIENT_ID = '1059497343032-251i1sb21bnbos0hc6ms8uij892oka3p.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly';
const STORAGE_KEY = 'gdrive_auth';
const FOLDER_STORAGE_KEY = 'gdrive_last_folder';
const TABS_DIRECTORY_STORAGE_KEY = 'gdrive_tabs_directory';
const PENDING_OPTIONS_STORAGE_KEY = 'gdrive_pending_options';

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

function readStoredAuth() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    } catch (_) {
        return null;
    }
}

let refreshPromise = null;

/**
 * Resolves true when a usable access token is available, renewing it first if it has expired.
 * Desktop and iOS exchange the stored refresh token; Android re-runs its (silent once granted)
 * authorization. The browser's implicit flow has no refresh token, so it returns false there.
 */
export async function ensureFreshToken() {
    if (isTokenValid()) return true;
    const auth = readStoredAuth();
    const isTauri = !!window.__TAURI__?.core?.invoke;
    if (!isTauri || (!auth?.refresh_token && !(isMobilePlatform() && !isIOSDevice()))) return false;

    refreshPromise ||= refreshAccessToken(auth?.refresh_token)
        .catch((error) => {
            console.warn('Google token refresh failed:', error);
            return false;
        })
        .finally(() => { refreshPromise = null; });
    return refreshPromise;
}

async function refreshAccessToken(refreshToken) {
    if (isMobilePlatform() && !isIOSDevice()) {
        const authData = await window.__TAURI__.core.invoke('plugin:google-auth|authorize');
        return storeGoogleAuth(authData.accessToken, authData.expiresIn);
    }

    const params = {
        client_id: isMobilePlatform() ? IOS_CLIENT_ID : DESKTOP_CLIENT_ID,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
    };
    if (!isMobilePlatform()) {
        const { TAURI_CLIENT_SECRET } = await import('./googleDrive.local.js');
        params.client_secret = TAURI_CLIENT_SECRET;
    }
    const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params)
    });
    const authData = await response.json();
    if (!response.ok) {
        // invalid_grant means the refresh token was revoked or expired: force a fresh sign-in.
        if (authData.error === 'invalid_grant') clearStoredToken({ all: true });
        throw new Error(authData.error_description || 'Google token refresh failed.');
    }
    return storeGoogleAuth(authData.access_token, authData.expires_in);
}

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

/**
 * Authenticated fetch against the Drive API for modules that manage their own requests.
 * Clears the stored token on 401 so the UI can prompt a reconnect.
 */
export async function driveFetch(url, options = {}) {
    await ensureFreshToken();
    if (!isTokenValid()) {
        throw new Error('Google Drive is not connected. Please connect your Google account.');
    }
    const res = await fetch(url, {
        ...options,
        headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` }
    });
    if (res.status === 401) {
        clearStoredToken();
        throw new Error('Google Drive authorization expired. Please reconnect Google Drive.');
    }
    return res;
}

// Auth states that return the user to the Data Management modal after connecting
const BACKUP_AUTH_STATES = {
    restore_backup: ['restore', { autoLoadDrive: true }],
    backup_create: ['backup', { provider: 'google-drive' }],
    sync: []
};

function openBackupModalForAuthState(state, { skipIfOpen = false } = {}) {
    if (state === 'sync') {
        const syncModal = document.getElementById('syncModal');
        if (skipIfOpen && syncModal && syncModal.style.display === 'flex') return;
        import('./syncUi.js').then(({ openSyncModal }) => openSyncModal());
        return;
    }
    const target = BACKUP_AUTH_STATES[state];
    if (!target) return;
    const modal = document.getElementById('backupModal');
    if (skipIfOpen && modal && modal.style.display === 'flex') return;
    import('./backupRestore.js').then(({ openBackupModal }) => openBackupModal(...target));
}

/** Drops the access token; the refresh token survives unless `all` (sign-out or revoked grant). */
export function clearStoredToken({ all = false } = {}) {
    const refreshToken = all ? null : readStoredAuth()?.refresh_token;
    if (refreshToken) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ refresh_token: refreshToken }));
    } else {
        localStorage.removeItem(STORAGE_KEY);
    }
    token = null;
}

function getRedirectUri() {
    return window.location.origin + window.location.pathname;
}

let pendingAuthState = 'open_drive_browser';
let pendingDriveOptions = null;
let activeDriveTargetSongId = null;
let activeDriveTargetSong = null;
let activeDriveTargetAlbum = null;
let activeDriveOnFileSelected = null;

function savePendingDriveOptions(options) {
    if (!options || typeof options !== 'object') {
        pendingDriveOptions = null;
        try { localStorage.removeItem(PENDING_OPTIONS_STORAGE_KEY); } catch (_) {}
        return;
    }
    pendingDriveOptions = options;
    try {
        const serializable = { ...options };
        if (typeof serializable.onFileSelected === 'function') {
            delete serializable.onFileSelected;
        }
        localStorage.setItem(PENDING_OPTIONS_STORAGE_KEY, JSON.stringify(serializable));
    } catch (e) {
        console.warn('Failed to save pending drive options:', e);
    }
}

function restorePendingDriveOptions() {
    if (pendingDriveOptions) {
        const opts = pendingDriveOptions;
        pendingDriveOptions = null;
        try { localStorage.removeItem(PENDING_OPTIONS_STORAGE_KEY); } catch (_) {}
        return opts;
    }
    try {
        const saved = localStorage.getItem(PENDING_OPTIONS_STORAGE_KEY);
        if (saved) {
            localStorage.removeItem(PENDING_OPTIONS_STORAGE_KEY);
            return JSON.parse(saved);
        }
    } catch (e) {
        console.warn('Failed to restore pending drive options:', e);
    }
    return null;
}

function getActiveDriveOptions() {
    const opts = {};
    if (activeDriveTargetSongId) opts.songId = activeDriveTargetSongId;
    if (activeDriveTargetSong) opts.targetSong = activeDriveTargetSong;
    if (activeDriveTargetAlbum) {
        opts.isAlbumTab = true;
        opts.albumTitle = activeDriveTargetAlbum.albumTitle;
        opts.artistName = activeDriveTargetAlbum.artistName;
        opts.collectionId = activeDriveTargetAlbum.collectionId;
    }
    if (activeDriveOnFileSelected) opts.onFileSelected = activeDriveOnFileSelected;
    return Object.keys(opts).length > 0 ? opts : null;
}

export function isMobilePlatform() {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    return /android/i.test(ua) || isIOSDevice();
}

export function redirectToGoogleAuth(targetState = 'open_drive_browser', options = null) {
    pendingAuthState = targetState;
    const opts = options || getActiveDriveOptions();
    if (opts) {
        savePendingDriveOptions(opts);
    }
    try {
        localStorage.setItem('gdrive_pending_state', targetState);
    } catch (_) {}

    if (window.__TAURI__?.core?.invoke && isMobilePlatform()) {
        startMobileGoogleAuth(targetState);
        return;
    }

    if (window.__TAURI__?.core?.invoke && window.__TAURI__?.event?.listen) {
        startTauriGoogleAuth(targetState);
        return;
    }

    const redirectUri = getRedirectUri();
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
        `client_id=${encodeURIComponent(BROWSER_CLIENT_ID)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_type=token` +
        `&scope=${encodeURIComponent(SCOPE)}` +
        `&include_granted_scopes=true` +
        `&prompt=select_account` +
        `&state=${encodeURIComponent(targetState)}`;

    window.location.href = authUrl;
}

async function startMobileGoogleAuth(targetState = 'open_drive_browser') {
    try {
        const authData = await window.__TAURI__.core.invoke('plugin:google-auth|authorize');
        if (!storeGoogleAuth(authData.accessToken, authData.expiresIn, authData.refreshToken)) {
            throw new Error('Google authorization did not return an access token.');
        }
        try { localStorage.removeItem('gdrive_pending_state'); } catch (_) {}
        window.dispatchEvent(new CustomEvent('googleAuthSuccess', { detail: { state: targetState } }));
        if (targetState === 'open_drive_browser' || targetState === 'open_picker') {
            openDriveModal(restorePendingDriveOptions() || {});
        } else if (BACKUP_AUTH_STATES[targetState]) {
            openBackupModalForAuthState(targetState, { skipIfOpen: true });
        }
    } catch (error) {
        try { localStorage.removeItem('gdrive_pending_state'); } catch (_) {}
        console.error('Failed to authorize Google Drive on mobile:', error);
        showToast('Could not connect to Google Drive. Please try again.', 'error');
    }
}

async function startTauriGoogleAuth(targetState = 'open_drive_browser') {
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
                showToast('Google authorization was not completed. Please try again.', 'warning');
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
                if (!response.ok || !storeGoogleAuth(authData.access_token, authData.expires_in, authData.refresh_token)) {
                    throw new Error(authData.error_description || 'Google token exchange failed.');
                }
                try { localStorage.removeItem('gdrive_pending_state'); } catch (_) {}
                window.dispatchEvent(new CustomEvent('googleAuthSuccess', { detail: { state: targetState } }));
                if (targetState === 'open_drive_browser' || targetState === 'open_picker') {
                    openDriveModal(restorePendingDriveOptions() || {});
                } else if (BACKUP_AUTH_STATES[targetState]) {
                    openBackupModalForAuthState(targetState, { skipIfOpen: true });
                }
            } catch (error) {
                try { localStorage.removeItem('gdrive_pending_state'); } catch (_) {}
                console.error('Failed to exchange Google authorization code:', error);
                showToast('Could not connect to Google Drive. Please try again.', 'error');
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
            `&code_challenge_method=S256` +
            `&access_type=offline` +
            `&prompt=consent`;

        await tauri.core.invoke('plugin:opener|open_url', { url: authUrl });
    } catch (error) {
        unlisten?.();
        if (port !== null) {
            await tauri.core.invoke('plugin:oauth|cancel', { port }).catch(() => {});
        }
        console.error('Failed to start Google OAuth:', error);
        showToast('Could not connect to Google Drive. Please try again.', 'error');
    }
}

function encodeBase64Url(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function storeGoogleAuth(accessToken, expiresIn, refreshToken = null) {
    if (!accessToken) return false;

    const authData = {
        access_token: accessToken,
        expiry_date: Date.now() + ((parseInt(expiresIn, 10) || 3600) * 1000)
    };
    const keptRefreshToken = refreshToken || readStoredAuth()?.refresh_token;
    if (keptRefreshToken) authData.refresh_token = keptRefreshToken;
    token = authData.access_token;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(authData));
    return true;
}

export function openDriveModal(options = {}) {
    const savedOpts = restorePendingDriveOptions();
    const mergedOptions = { ...(savedOpts || {}), ...(options || {}) };
    activeDriveOnFileSelected = mergedOptions.onFileSelected || null;
    activeDriveTargetSongId = mergedOptions.songId || mergedOptions.targetSong?.id || null;
    activeDriveTargetSong = mergedOptions.targetSong || null;
    if (mergedOptions.isAlbumTab && mergedOptions.albumTitle) {
        activeDriveTargetAlbum = {
            collectionId: mergedOptions.collectionId,
            artistName: mergedOptions.artistName,
            albumTitle: mergedOptions.albumTitle
        };
    } else {
        activeDriveTargetAlbum = null;
    }
    const modal = document.getElementById('driveModal');
    if (!modal) return;

    if (folderHistory[0]?.id !== getDriveRoot().id) resetFolderToDriveRoot();

    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    // Reset search input
    const searchInput = document.getElementById('driveSearchInput');
    if (searchInput) searchInput.value = currentSearchQuery;

    loadDriveFiles();
}

export function closeDriveModal(isReauthenticating = false) {
    if (!isReauthenticating) {
        activeDriveTargetSongId = null;
        activeDriveTargetSong = null;
        activeDriveTargetAlbum = null;
        activeDriveOnFileSelected = null;
        pendingDriveOptions = null;
        try { localStorage.removeItem(PENDING_OPTIONS_STORAGE_KEY); } catch (_) {}
    }
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
    if (lower.endsWith('.mtbackup')) {
        return { icon: 'bi-archive-fill', color: 'text-info' };
    }
    if (lower.endsWith('.json') || lower.endsWith('.majestictab')) {
        return { icon: 'bi-file-earmark-code-fill', color: 'text-warning' };
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

    const backBtn = document.getElementById('driveModalBackBtn');
    if (backBtn) {
        backBtn.style.display = (folderHistory.length > 1 && !currentSearchQuery) ? 'inline-flex' : 'none';
    }

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

    await ensureFreshToken();
    if (!isTokenValid()) {
        const currentOpts = getActiveDriveOptions();
        clearStoredToken();
        closeDriveModal(true);
        redirectToGoogleAuth('open_drive_browser', currentOpts);
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
            const currentOpts = getActiveDriveOptions();
            clearStoredToken();
            closeDriveModal(true);
            redirectToGoogleAuth('open_drive_browser', currentOpts);
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
                <button class="btn btn-theme-primary btn-sm mt-3" id="driveRetryBtn">Try Again</button>
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
                            const currentOpts = getActiveDriveOptions();
                            clearStoredToken();
                            closeDriveModal(true);
                            redirectToGoogleAuth('open_drive_browser', currentOpts);
                            return;
                        }
                        throw new Error(`Download failed: ${res.statusText}`);
                    }

                    const blob = await res.blob();
                    const fileObj = new File([blob], fileName, { type: mimeType || 'application/octet-stream' });
                    const targetSongId = activeDriveTargetSongId;
                    const targetAlbum = activeDriveTargetAlbum;

                    if (typeof activeDriveOnFileSelected === 'function') {
                        const cb = activeDriveOnFileSelected;
                        closeDriveModal();
                        try {
                            const isBackup = fileName.toLowerCase().endsWith('.mtbackup');
                            if (isBackup) {
                                cb({ file: fileObj, providerId: 'google-drive', name: fileObj.name });
                                return;
                            }
                            const { detectFileMetadata } = await import('./utils/tuningUtils.js');
                            const meta = await detectFileMetadata(fileObj, fileObj.name);
                            const stored = await saveStoredFile(fileObj, 'google-drive', { driveFileId: fileId });
                            cb({ file: fileObj, providerId: 'google-drive', fileStoreId: stored.id, name: fileObj.name, meta });
                            return;
                        } catch (err) {
                            console.warn('Could not process selected Drive file:', err);
                            cb({ file: fileObj, providerId: 'google-drive', name: fileObj.name });
                            return;
                        }
                    }

                    if (targetSongId) {
                        try {
                            const { detectFileMetadata } = await import('./utils/tuningUtils.js');
                            const meta = await detectFileMetadata(fileObj, fileObj.name);
                            const stored = await saveStoredFile(fileObj, 'google-drive', { driveFileId: fileId });
                            const { addTabOptionToSong } = await import('./libraryStore.js');
                            await addTabOptionToSong(targetSongId, {
                                name: fileObj.name,
                                providerId: 'google-drive',
                                relativePath: fileObj.name,
                                fileStoreId: stored.id,
                                driveFileId: fileId,
                                targetSong: activeDriveTargetSong,
                                tuning: meta.primaryTuning,
                                tunings: meta.tunings,
                                stringCount: meta.stringCount,
                                fileType: fileObj.name.split('.').pop().toLowerCase()
                            });
                            closeDriveModal();
                            showToast(`Added "${fileObj.name}" to song`, 'success');
                            window.dispatchEvent(new CustomEvent('libraryDataChanged'));
                            return;
                        } catch (err) {
                            console.error('Could not persist Drive file to store:', err);
                            closeDriveModal();
                            showToast('Error attaching tab file to song', 'error');
                            return;
                        }
                    }

                    if (targetAlbum?.albumTitle) {
                        try {
                            const { detectFileMetadata } = await import('./utils/tuningUtils.js');
                            const meta = await detectFileMetadata(fileObj, fileObj.name);
                            const stored = await saveStoredFile(fileObj, 'google-drive', { driveFileId: fileId });
                            const { addTabOptionToAlbum } = await import('./libraryStore.js');
                            await addTabOptionToAlbum(targetAlbum.collectionId, targetAlbum.artistName, targetAlbum.albumTitle, {
                                name: fileObj.name,
                                providerId: 'google-drive',
                                relativePath: fileObj.name,
                                fileStoreId: stored.id,
                                driveFileId: fileId,
                                tuning: meta.primaryTuning,
                                tunings: meta.tunings,
                                stringCount: meta.stringCount,
                                fileType: fileObj.name.split('.').pop().toLowerCase()
                            });
                            closeDriveModal();
                            showToast(`Added "${fileObj.name}" to album`, 'success');
                            window.dispatchEvent(new CustomEvent('libraryDataChanged'));
                            return;
                        } catch (err) {
                            console.error('Could not persist Drive file to album:', err);
                            closeDriveModal();
                            showToast('Error attaching tab file to album', 'error');
                            return;
                        }
                    }

                    closeDriveModal();
                    await loadFile(fileObj);
                } catch (err) {
                    console.error('Error downloading file from Drive:', err);
                    showToast('Failed to download file from Google Drive.', 'error');
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
    const state = params.get('state') || localStorage.getItem('gdrive_pending_state');

    if (accessToken) {
        storeGoogleAuth(accessToken, expiresIn);
        try {
            localStorage.removeItem('gdrive_pending_state');
            localStorage.setItem('gdrive_auth_synced', Date.now().toString());
            if (typeof BroadcastChannel !== 'undefined') {
                const bc = new BroadcastChannel('majestictab_gdrive_auth');
                bc.postMessage({ type: 'googleAuthSuccess', state, accessToken, expiresIn });
                setTimeout(() => {
                    try { bc.close(); } catch (_) {}
                }, 1000);
            }
        } catch (_) {}

        window.dispatchEvent(new CustomEvent('googleAuthSuccess', { detail: { state } }));

        const cleanUrl = window.location.pathname + window.location.search;
        window.history.replaceState(null, '', cleanUrl);

        if (state === 'open_drive_browser' || state === 'open_picker') {
            openDriveModal();
        } else if (BACKUP_AUTH_STATES[state]) {
            openBackupModalForAuthState(state);
        }
        return true;
    }
    return false;
}

export function setupDrivePicker() {
    const loadBtn = document.getElementById('loadFromDriveBtn');
    if (loadBtn) {
        loadBtn.addEventListener('click', async () => {
            hideFileMenu();
            const { openFromProvider } = await import('./fileProviders.js');
            await openFromProvider('google-drive');
        });
    }

    const backBtn = document.getElementById('driveModalBackBtn');
    backBtn?.addEventListener('click', () => {
        if (folderHistory.length > 1) {
            folderHistory.pop();
            currentFolderId = folderHistory[folderHistory.length - 1].id;
            saveCurrentFolder();
            loadDriveFiles();
        }
    });

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
        clearStoredToken({ all: true });
        localStorage.removeItem(FOLDER_STORAGE_KEY);
        currentFolderId = 'root';
        folderHistory = [{ id: 'root', name: 'My Drive' }];
        closeDriveModal();
        showToast('Disconnected Google Drive account.', 'info');
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

    // Cross-window / PWA Auth Synchronization (Safari & iOS PWA)
    try {
        if (typeof BroadcastChannel !== 'undefined') {
            const authChannel = new BroadcastChannel('majestictab_gdrive_auth');
            authChannel.onmessage = (event) => {
                if (event.data?.type === 'googleAuthSuccess') {
                    const { state, accessToken, expiresIn } = event.data;
                    storeGoogleAuth(accessToken, expiresIn);
                    window.dispatchEvent(new CustomEvent('googleAuthSuccess', { detail: { state } }));
                    if (BACKUP_AUTH_STATES[state]) {
                        openBackupModalForAuthState(state, { skipIfOpen: true });
                    }
                }
            };
        }
    } catch (_) {}

    window.addEventListener('storage', (e) => {
        if (e.key === STORAGE_KEY || e.key === 'gdrive_auth_synced') {
            if (isTokenValid()) {
                const pending = localStorage.getItem('gdrive_pending_state');
                if (pending) {
                    localStorage.removeItem('gdrive_pending_state');
                    window.dispatchEvent(new CustomEvent('googleAuthSuccess', { detail: { state: pending } }));
                    if (BACKUP_AUTH_STATES[pending]) {
                        openBackupModalForAuthState(pending, { skipIfOpen: true });
                    }
                } else {
                    window.dispatchEvent(new CustomEvent('googleAuthSuccess', { detail: { state: 'synced' } }));
                }
            }
        }
    });

    const handleVisibilitySync = () => {
        if (document.visibilityState === 'visible' && isTokenValid()) {
            const pending = localStorage.getItem('gdrive_pending_state');
            if (pending) {
                localStorage.removeItem('gdrive_pending_state');
                window.dispatchEvent(new CustomEvent('googleAuthSuccess', { detail: { state: pending } }));
                if (BACKUP_AUTH_STATES[pending]) {
                    openBackupModalForAuthState(pending, { skipIfOpen: true });
                }
            }
        }
    };
    document.addEventListener('visibilitychange', handleVisibilitySync);
    window.addEventListener('focus', handleVisibilitySync);
}

/**
 * Upload a file/blob to Google Drive in the current or specified folder
 * @param {Blob|File} fileBlob
 * @param {string} filename
 * @param {string} [folderId]
 * @param {Function} [onProgress] Callback receiving ({ loaded, total, percent })
 * @returns {Promise<object>} Upload response containing file id and name
 */
export async function saveFileToDrive(fileBlob, filename = 'MajesticTab-backup.mtbackup', folderId = null, onProgress = null) {
    await ensureFreshToken();
    if (!isTokenValid()) {
        throw new Error('Google Drive is not connected. Please connect your Google account.');
    }

    const targetFolder = folderId || (tabsDirectory ? tabsDirectory.id : 'root');
    const metadata = {
        name: filename,
        mimeType: fileBlob.type || 'application/octet-stream'
    };

    if (targetFolder && targetFolder !== 'root') {
        metadata.parents = [targetFolder];
    }

    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', fileBlob, filename);

    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart');
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);

        if (xhr.upload && typeof onProgress === 'function') {
            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable && e.total > 0) {
                    const percent = Math.min(100, Math.round((e.loaded / e.total) * 100));
                    onProgress({ loaded: e.loaded, total: e.total, percent });
                }
            };
        }

        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                try {
                    const result = JSON.parse(xhr.responseText);
                    resolve(result);
                } catch (err) {
                    resolve({ name: filename });
                }
            } else {
                let errorMsg = xhr.statusText;
                try {
                    const errData = JSON.parse(xhr.responseText);
                    errorMsg = errData.error?.message || errorMsg;
                } catch (e) {}

                if (xhr.status === 401) {
                    clearStoredToken();
                    reject(new Error(`Google Drive authorization expired: ${errorMsg}. Please reconnect Google Drive.`));
                } else {
                    reject(new Error(`Google Drive upload failed (${xhr.status}): ${errorMsg}`));
                }
            }
        };

        xhr.onerror = () => {
            reject(new Error('Google Drive upload network error. Please check your connection.'));
        };

        xhr.send(form);
    });
}

/**
 * Non-recursively fetch .mtbackup files located in the known path (Drive root / tabs directory).
 * @returns {Promise<Array<object>>} List of Drive files sorted by modifiedTime descending
 */
export async function fetchDriveBackups() {
    await ensureFreshToken();
    if (!isTokenValid()) {
        throw new Error('Google Drive is not connected. Please connect your Google account.');
    }

    const query = `trashed = false and name contains '.mtbackup'`;

    const files = await fetchDriveFiles(query);
    const mtbackupFiles = files.filter(f => f.name && f.name.toLowerCase().endsWith('.mtbackup'));

    mtbackupFiles.sort((a, b) => new Date(b.modifiedTime || 0) - new Date(a.modifiedTime || 0));
    return mtbackupFiles;
}

/**
 * Download a backup file from Google Drive as a File object.
 * @param {string} fileId
 * @param {string} fileName
 * @param {Function} [onProgress] Callback receiving ({ loaded, total, percent })
 * @returns {Promise<File|Blob>}
 */
export async function downloadDriveBackupFile(fileId, fileName = 'backup.mtbackup', onProgress = null) {
    await ensureFreshToken();
    if (!isTokenValid()) {
        throw new Error('Google Drive is not connected. Please connect your Google account.');
    }

    const downloadUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;

    // Use modern fetch API with streaming progress (reliable on iOS WKWebView, avoids XHR blob redirect issues)
    let res;
    try {
        res = await fetch(downloadUrl, {
            headers: { Authorization: `Bearer ${token}` }
        });
    } catch (networkErr) {
        console.warn('[GoogleDrive] Direct fetch failed, attempting with query token:', networkErr);
        // Fallback: append access_token in URL query param for webviews where headers are dropped across redirects
        res = await fetch(`${downloadUrl}&access_token=${encodeURIComponent(token)}`);
    }

    if (!res.ok) {
        let errorDetail = res.statusText;
        if (res.status === 401) {
            clearStoredToken();
            throw new Error(`Google Drive authorization expired (${res.status}): ${errorDetail}. Please reconnect Google Drive.`);
        }
        throw new Error(`Download failed (${res.status}): ${errorDetail}`);
    }

    const contentLength = res.headers.get('content-length');
    const total = contentLength ? parseInt(contentLength, 10) : 0;

    let blob;
    if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        const chunks = [];
        let loaded = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            loaded += value.length;

            if (typeof onProgress === 'function') {
                const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
                onProgress({ loaded, total: total || loaded, percent });
            }
        }

        blob = new Blob(chunks, { type: 'application/octet-stream' });
    } else {
        blob = await res.blob();
        if (typeof onProgress === 'function') {
            onProgress({ loaded: blob.size, total: blob.size, percent: 100 });
        }
    }

    try {
        return new File([blob], fileName, { type: 'application/octet-stream' });
    } catch (_) {
        try {
            Object.defineProperty(blob, 'name', { value: fileName, writable: true });
        } catch (e) {
            blob.name = fileName;
        }
        return blob;
    }
}

export const downloadDriveFile = downloadDriveBackupFile;



