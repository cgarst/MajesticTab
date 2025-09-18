// googleDrive.js

/**
 * Given a `picker-picked` event, fetch the file from Google Drive
 * and return it as a File object.
 */
export async function fetchPickedFile(event) {
  const { docs, token } = event.detail;
  const doc = docs[0];
  if (!doc) return null;

  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${doc.id}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const blob = await res.blob();
  const file = new File([blob], doc.name, { type: doc.mimeType || 'application/octet-stream' });
  return file;
}

export function setupDrivePicker() {
  document.getElementById('loadFromDriveBtn').addEventListener('click', () => {
      const container = document.getElementById('drivePickerContainer');
      
      // Clear previous picker if any
      container.innerHTML = '';

      const picker = document.createElement('drive-picker');
      picker.setAttribute('client-id', '1059497343032-rcmtq18q4bgrc495qbdkg2kpt0q0arq9.apps.googleusercontent.com');
      picker.setAttribute('app-id', '1059497343032');
      picker.setAttribute('scopes', 'https://www.googleapis.com/auth/drive.readonly');
      picker.setAttribute('mime-types', 'application/pdf, application/x-guitar-pro');
      picker.setAttribute('max-items', '1');

      const docsView = document.createElement('drive-picker-docs-view');
      picker.appendChild(docsView);

      container.appendChild(picker);
  });
}