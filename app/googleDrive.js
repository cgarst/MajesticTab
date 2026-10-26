// googleDrive.js
import { loadFile, hideFileMenu } from './main.js';
import { saveStoredFile } from './fileStore.js';
import { showToast } from './utils/toast.js';
import { isSupportedTabFile } from './utils/fileHandlingUtils.js';
import { isIOSDevice } from './utils/iosAudioUnlock.js';

const BROWSER_CLIENT_ID = '1059497343032-rcmtq18q4bgrc495qbdkg2kpt0q0arq9.apps.googleusercontent.com';
const DESKTOP_CLIENT_ID = '1059497343032-f0st8cbjrjksj2m0hgjk70hh9cg7l910.apps.googleusercontent.com';
const IOS_CLIENT_ID = '1059497343032-251i1sb21bnbos0hc6ms8uij892oka3p.apps.googleusercontent.com';
// drive.file only: the app sees files it created plus files the user hands it through the Google Picker.
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
// The Picker needs a browser API key and the Cloud project number. The key comes from the GOOGLE_PICKER_API_KEY
// environment variable, which the build writes to the git-ignored pickerKey.local.js.
const PICKER_APP_ID = '1059497343032';
const STORAGE_KEY = 'gdrive_auth';
// Bumped when the requested scope changes so tokens granted under the old scope force a fresh consent.
const AUTH_VERSION = 2;
const LEGACY_BROWSER_KEYS = ['gdrive_last_folder', 'gdrive_tabs_directory', 'majestictab_drive_backup_folder'];
const PENDING_OPTIONS_STORAGE_KEY = 'gdrive_pending_options';

let token = null;

// Drop tokens (and the refresh token) issued under the broader drive.readonly scope, and the folder-browser state they supported.
try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (stored && stored.v !== AUTH_VERSION) localStorage.removeItem(STORAGE_KEY);
    LEGACY_BROWSER_KEYS.forEach(key => localStorage.removeItem(key));
} catch (_) {}

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

/** True when a Google account is linked (a live access token, or a refresh token that can renew one). */
export function isGoogleDriveConnected() {
    return isTokenValid() || Boolean(readStoredAuth()?.refresh_token);
}

/** Forgets the linked Google account on this device. */
export function disconnectGoogleDrive() {
    clearStoredToken({ all: true });
    window.dispatchEvent(new CustomEvent('googleAuthChanged'));
}

function getRedirectUri() {
    return window.location.origin + window.location.pathname;
}

let pendingAuthState = 'open_drive_browser';
let pendingDriveOptions = null;

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

export function isMobilePlatform() {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    return /android/i.test(ua) || isIOSDevice();
}

export function redirectToGoogleAuth(targetState = 'open_drive_browser', options = null) {
    pendingAuthState = targetState;
    const opts = options;
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
            openDrivePicker(restorePendingDriveOptions() || {});
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
                    openDrivePicker(restorePendingDriveOptions() || {});
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
        v: AUTH_VERSION,
        access_token: accessToken,
        expiry_date: Date.now() + ((parseInt(expiresIn, 10) || 3600) * 1000)
    };
    const keptRefreshToken = refreshToken || readStoredAuth()?.refresh_token;
    if (keptRefreshToken) authData.refresh_token = keptRefreshToken;
    token = authData.access_token;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(authData));
    return true;
}

/** Loads the Google Picker library once. */
let pickerApiPromise = null;
function loadPickerApi() {
    pickerApiPromise ||= new Promise((resolve, reject) => {
        const fail = (message) => { pickerApiPromise = null; reject(new Error(message)); };
        const start = () => window.gapi.load('picker', { callback: resolve, onerror: () => fail('Could not load the Google Picker.') });
        if (window.gapi?.load) return start();
        const script = document.createElement('script');
        script.src = 'https://apis.google.com/js/api.js';
        script.onload = start;
        script.onerror = () => fail('Could not reach Google. Check your connection and try again.');
        document.head.appendChild(script);
    });
    return pickerApiPromise;
}

/**
 * Shows the Google Picker and resolves with the chosen file ({ id, name, mimeType }), or null if cancelled.
 * Picking a file grants this app access to it under the drive.file scope.
 */
export async function pickDriveFile({ title = 'Select a file from Google Drive' } = {}) {
    const apiKey = await import('./pickerKey.local.js').then(m => m.PICKER_API_KEY, () => '');
    if (!apiKey) {
        throw new Error('The Google Drive picker is not configured in this build (missing GOOGLE_PICKER_API_KEY).');
    }
    await ensureFreshToken();
    if (!isTokenValid()) throw new Error('Google Drive is not connected. Please connect your Google account.');
    await loadPickerApi();

    return new Promise((resolve) => {
        const { picker: gp } = window.google;
        const view = new gp.DocsView(gp.ViewId.DOCS)
            .setIncludeFolders(true)
            .setSelectFolderEnabled(false);
        new gp.PickerBuilder()
            .setAppId(PICKER_APP_ID)
            .setDeveloperKey(apiKey)
            .setOAuthToken(token)
            .setTitle(title)
            .addView(view)
            .setCallback((data) => {
                const action = data[gp.Response.ACTION];
                if (action === gp.Action.PICKED) {
                    const doc = data[gp.Response.DOCUMENTS][0];
                    resolve({ id: doc[gp.Document.ID], name: doc[gp.Document.NAME], mimeType: doc[gp.Document.MIME_TYPE] });
                } else if (action === gp.Action.CANCEL) {
                    resolve(null);
                }
            })
            .build()
            .setVisible(true);
    });
}

/**
 * Lets the user pick a tab file from Google Drive, then opens it or attaches it to the song or album in `options`.
 * Mirrors the Local Device provider's options (onFileSelected, songId/targetSong, album fields).
 */
export async function openDrivePicker(options = {}) {
    const savedOpts = restorePendingDriveOptions();
    const opts = { ...(savedOpts || {}), ...(options || {}) };

    let doc;
    try {
        doc = await pickDriveFile({ title: 'Select a tab file from Google Drive' });
    } catch (err) {
        console.error('[Drive] Picker failed:', err);
        showToast(err.message, 'error');
        return;
    }
    if (!doc) return;

    try {
        const fileObj = await downloadDriveFile(doc.id, doc.name);
        const isBackup = doc.name.toLowerCase().endsWith('.mtbackup');
        if (!isBackup && !(await isSupportedTabFile(fileObj))) {
            showToast(`"${doc.name}" is not a supported tab file (.gp, .gp3, .gp4, .gp5, .gpx, .pdf, .txt)`, 'warning');
            return;
        }
        await handleDriveFileSelected(fileObj, doc.id, opts);
    } catch (err) {
        console.error('Error downloading file from Drive:', err);
        if (/authorization expired/i.test(err.message)) {
            redirectToGoogleAuth('open_drive_browser', opts);
            return;
        }
        showToast('Failed to download file from Google Drive.', 'error');
    }
}

async function handleDriveFileSelected(fileObj, fileId, opts) {
    const { onFileSelected, songId, targetSong, isAlbumTab, albumTitle, artistName, collectionId } = opts;
    const targetSongId = songId || targetSong?.id;

    if (typeof onFileSelected === 'function') {
        try {
            if (fileObj.name.toLowerCase().endsWith('.mtbackup')) {
                onFileSelected({ file: fileObj, providerId: 'google-drive', name: fileObj.name });
                return;
            }
            const { detectFileMetadata } = await import('./utils/tuningUtils.js');
            const meta = await detectFileMetadata(fileObj, fileObj.name);
            const stored = await saveStoredFile(fileObj, 'google-drive', { driveFileId: fileId });
            onFileSelected({ file: fileObj, providerId: 'google-drive', fileStoreId: stored.id, name: fileObj.name, meta });
        } catch (err) {
            console.warn('Could not process selected Drive file:', err);
            onFileSelected({ file: fileObj, providerId: 'google-drive', name: fileObj.name });
        }
        return;
    }

    const attachTab = async (label, addTab) => {
        try {
            const { detectFileMetadata } = await import('./utils/tuningUtils.js');
            const meta = await detectFileMetadata(fileObj, fileObj.name);
            const stored = await saveStoredFile(fileObj, 'google-drive', { driveFileId: fileId });
            await addTab({
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
            showToast(`Added "${fileObj.name}" to ${label}`, 'success');
            window.dispatchEvent(new CustomEvent('libraryDataChanged'));
        } catch (err) {
            console.error(`Could not persist Drive file to ${label}:`, err);
            showToast(`Error attaching tab file to ${label}`, 'error');
        }
    };

    if (targetSongId) {
        const { addTabOptionToSong } = await import('./libraryStore.js');
        await attachTab('song', (tab) => addTabOptionToSong(targetSongId, { ...tab, targetSong }));
        return;
    }
    if (isAlbumTab && albumTitle) {
        const { addTabOptionToAlbum } = await import('./libraryStore.js');
        await attachTab('album', (tab) => addTabOptionToAlbum(collectionId, artistName, albumTitle, tab));
        return;
    }

    await loadFile(fileObj);
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
        if (!res.ok) throw new Error(`Google Drive API error: ${res.status} ${res.statusText}`);

        const data = await res.json();
        files.push(...(data.files || []));
        pageToken = data.nextPageToken;
    } while (pageToken);

    return files;
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
            openDrivePicker();
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

    const targetFolder = folderId || 'root';
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
 * Fetch the .mtbackup files this app saved to Drive (drive.file only exposes files the app created or the user picked).
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



