// googleDrive.js

/**
 * Given a `picker-picked` event, fetch the file from Google Drive
 * and return it as a File object.
 */

import { loadFile, hideFileMenu } from './main.js';

const CLIENT_ID = '1059497343032-rcmtq18q4bgrc495qbdkg2kpt0q0arq9.apps.googleusercontent.com';
const APP_ID = '1059497343032';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const STORAGE_KEY = 'gdrive_auth';
let token = null;

function isTokenValid() {
    try {
        const storedAuth = localStorage.getItem(STORAGE_KEY);
        if (!storedAuth) return false;

        const authData = JSON.parse(storedAuth);
        
        // Check if token exists and has not expired (with 60s buffer)
        if (authData.access_token && authData.expiry_date && Date.now() < (authData.expiry_date - 60000)) {
            token = authData.access_token;
            return true;
        }

        return false;
    } catch (err) {
        return false;
    }
}

function clearStoredToken() {
    localStorage.removeItem(STORAGE_KEY);
    token = null;
}

function getRedirectUri() {
    return window.location.origin + window.location.pathname;
}

function redirectToGoogleAuth() {
    const redirectUri = getRedirectUri();
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
        `client_id=${encodeURIComponent(CLIENT_ID)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_type=token` +
        `&scope=${encodeURIComponent(SCOPE)}` +
        `&include_granted_scopes=true` +
        `&state=open_picker`;
    
    window.location.href = authUrl;
}

function launchPickerModal() {
    const container = document.getElementById('drivePickerContainer');
    if (!container) return;
    container.innerHTML = '';

    if (!token) {
        redirectToGoogleAuth();
        return;
    }

    const picker = document.createElement('drive-picker');
    picker.setAttribute('app-id', APP_ID);
    picker.setAttribute('oauth-token', token);
    picker.setAttribute('max-items', '1');

    // View 1: My Drive Root folder directory browsing
    const rootDocsView = document.createElement('drive-picker-docs-view');
    rootDocsView.setAttribute('parent', 'root');
    rootDocsView.setAttribute('mode', 'LIST');
    rootDocsView.setAttribute('include-folders', 'true');
    rootDocsView.setAttribute('enable-drives', 'true');
    picker.appendChild(rootDocsView);

    // View 2: All / Recent files
    const allDocsView = document.createElement('drive-picker-docs-view');
    allDocsView.setAttribute('mode', 'LIST');
    allDocsView.setAttribute('include-folders', 'true');
    allDocsView.setAttribute('enable-drives', 'true');
    picker.appendChild(allDocsView);

    container.appendChild(picker);

    // Listen for file selection
    picker.addEventListener('picker:picked', async (e) => {
        const file = await fetchPickedFile(e);
        if (!file) return;
        await loadFile(file);
    });

    picker.addEventListener('picker:error', (e) => {
        console.error('[Drive Picker Error]', e);
        clearStoredToken();
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

        // Clean up hash from URL bar without reloading
        const cleanUrl = window.location.pathname + window.location.search;
        window.history.replaceState(null, '', cleanUrl);

        if (state === 'open_picker') {
            launchPickerModal();
        }
        return true;
    }
    return false;
}

export async function fetchPickedFile(event) {
    const { docs } = event.detail;
    if (!docs || docs.length === 0) {
        return null;
    }

    if (!token) {
        return null;
    }

    const doc = docs[0];

    try {
        const res = await fetch(
            `https://www.googleapis.com/drive/v3/files/${doc.id}?alt=media`,
            { headers: { Authorization: `Bearer ${token}` } }
        );

        if (!res.ok) {
            if (res.status === 401) {
                clearStoredToken();
            }
            return null;
        }

        const blob = await res.blob();
        const file = new File([blob], doc.name, { type: doc.mimeType || 'application/octet-stream' });
        return file;
    } catch (err) {
        console.error('[DEBUG] Error fetching file', err);
        return null;
    }
}

export function setupDrivePicker() {
    const loadBtn = document.getElementById('loadFromDriveBtn');
    if (loadBtn) {
        loadBtn.addEventListener('click', () => {
            hideFileMenu();
            if (!isTokenValid()) {
                redirectToGoogleAuth();
            } else {
                launchPickerModal();
            }
        });
    }

    // Check if returning from Google OAuth redirect
    handleAuthRedirect();
}

