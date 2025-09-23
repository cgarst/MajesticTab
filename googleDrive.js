// googleDrive.js

/**
 * Given a `picker-picked` event, fetch the file from Google Drive
 * and return it as a File object.
 */

import { loadFile, hideFileMenu } from './main.js';

const STORAGE_KEY = 'gdrive_auth';
let token = null;

async function handleTokenResponse(tokenData) {
    //console.log('[DEBUG] Handling token response:', { ...tokenData, token: 'REDACTED' });
    
    // Handle picker auth response format where token is in tokenData.token
    const accessToken = tokenData.token || tokenData.access_token;
    
    // Store the access token and its expiration
    const authData = {
        access_token: accessToken,
        expiry_date: Date.now() + ((tokenData.expires || 3600) * 1000)
    };

    token = authData.access_token;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(authData));
}

async function isTokenValid() {
    try {
        const storedAuth = localStorage.getItem(STORAGE_KEY);
        if (!storedAuth) return false;

        const authData = JSON.parse(storedAuth);
        
        // Check if we have a token and it hasn't expired
        if (authData.access_token && authData.expiry_date && Date.now() < authData.expiry_date) {
            token = authData.access_token;
            return true;
        }

        return false;
    } catch (err) {
        //console.error('[DEBUG] Error validating token:', err);
        return false;
    }
}

function clearStoredToken() {
    localStorage.removeItem(STORAGE_KEY);
    token = null;
}

export async function fetchPickedFile(event) {
    //console.log('[DEBUG] fetchPickedFile called', event);

    const { docs } = event.detail;
    if (!docs || docs.length === 0) {
        //console.warn('[DEBUG] No doc selected');
        return null;
    }

    if (!token) {
        //console.error('[DEBUG] No token available, cannot fetch file');
        return null;
    }

    const doc = docs[0];
    //console.log('[DEBUG] Selected doc:', doc);

    try {
        const res = await fetch(
            `https://www.googleapis.com/drive/v3/files/${doc.id}?alt=media`,
            { headers: { Authorization: `Bearer ${token}` } }
        );

        //console.log('[DEBUG] Fetch response', res);

        if (!res.ok) {
            if (res.status === 401) {
                // Token is invalid or expired
                clearStoredToken();
            }
            //console.error('[DEBUG] Fetch failed', res.status, res.statusText);
            return null;
        }

        const blob = await res.blob();
        //console.log('[DEBUG] Blob created', blob);

        const file = new File([blob], doc.name, { type: doc.mimeType || 'application/octet-stream' });
        //console.log('[DEBUG] File object created', file);

        return file;
    } catch (err) {
        console.error('[DEBUG] Error fetching file', err);
        return null;
    }
}

export async function setupDrivePicker() {
    const loadBtn = document.getElementById('loadFromDriveBtn');

    loadBtn.addEventListener('click', async () => {
        hideFileMenu();
        const container = document.getElementById('drivePickerContainer');
        container.innerHTML = '';

        // Check if we have valid auth before creating the picker
        const tokenValid = await isTokenValid();
        //if (!tokenValid) {
            //console.log('[DEBUG] No valid token, will need to authenticate');
        //}

        const picker = document.createElement('drive-picker');
        picker.setAttribute('client-id', '1059497343032-rcmtq18q4bgrc495qbdkg2kpt0q0arq9.apps.googleusercontent.com');
        picker.setAttribute('app-id', '1059497343032');
        picker.setAttribute('scopes', 'https://www.googleapis.com/auth/drive.readonly');
        picker.setAttribute('mime-types', 'application/pdf,application/x-guitar-pro,text/plain');
        picker.setAttribute('max-items', '1');

        if (token) {
            // If we have a valid token, provide it to the picker
            picker.setAttribute('access-token', token);
        } else {
            // Only set up auth listener if we need to authenticate
            picker.addEventListener('picker:authenticated', async (e) => {
                //console.log('[DEBUG] picker:authenticated fired', e.detail);
                await handleTokenResponse(e.detail);
            });
        }

        const docsView = document.createElement('drive-picker-docs-view');
        docsView.setAttribute('mode', 'LIST');
        picker.appendChild(docsView);
        container.appendChild(picker);

        // Listen for file selection
        picker.addEventListener('picker:picked', async (e) => {
            //console.log('[DEBUG] picker:picked fired');
            const file = await fetchPickedFile(e);
            if (!file) return;
            await loadFile(file);
        });
    });
}
