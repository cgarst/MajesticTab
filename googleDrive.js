// googleDrive.js

/**
 * Given a `picker-picked` event, fetch the file from Google Drive
 * and return it as a File object.
 */

import { loadFile, hideFileMenu } from './main.js';

export async function fetchPickedFile(event) {
    console.log('[DEBUG] fetchPickedFile called', event);

    const { docs, detail } = event.detail;
    token = event.detail.token;

    const doc = docs[0];
    if (!doc) {
        console.warn('[DEBUG] No doc selected');
        return null;
    }

    console.log('[DEBUG] Selected doc:', doc);

    try {
        const res = await fetch(
            `https://www.googleapis.com/drive/v3/files/${doc.id}?alt=media`,
            { headers: { Authorization: `Bearer ${token}` } }
        );
        console.log('[DEBUG] Fetch response', res);

        if (!res.ok) {
            console.error('[DEBUG] Fetch failed', res.status, res.statusText);
            return null;
        }

        const blob = await res.blob();
        console.log('[DEBUG] Blob created', blob);

        const file = new File([blob], doc.name, { type: doc.mimeType || 'application/octet-stream' });
        console.log('[DEBUG] File object created', file);

        return file;
    } catch (err) {
        console.error('[DEBUG] Error fetching file', err);
        return null;
    }
}

export function setupDrivePicker() {
  const loadBtn = document.getElementById('loadFromDriveBtn');

  loadBtn.addEventListener('click', () => {
    const container = document.getElementById('drivePickerContainer');
    
    // Clear previous picker if any
    container.innerHTML = '';

    // Create the picker
    const picker = document.createElement('drive-picker');
    picker.setAttribute('client-id', '1059497343032-rcmtq18q4bgrc495qbdkg2kpt0q0arq9.apps.googleusercontent.com');
    picker.setAttribute('app-id', '1059497343032');
    picker.setAttribute('scopes', 'https://www.googleapis.com/auth/drive.readonly');
    picker.setAttribute('mime-types', 'application/pdf, application/x-guitar-pro');
    picker.setAttribute('max-items', '1');

    const docsView = document.createElement('drive-picker-docs-view');
    picker.appendChild(docsView);

    container.appendChild(picker);

    // Now picker exists, you can safely add event listeners
    picker.addEventListener('picker:picked', async (e) => {
      console.log('[DEBUG] picker:picked fired')
      const file = await fetchPickedFile(e);
      if (!file) return;
      await loadFile(file);
    });

    // Hide menu on click
    loadBtn.addEventListener('click', () => hideFileMenu());
  });
}