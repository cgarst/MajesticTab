import { processPDF } from './pdfProcessor/pdfProcessor.js';

export function setupGoogleDriveButton() {
  const button = document.getElementById('googleDriveBtn');
  let picker = null;

  button.addEventListener('click', () => {
    if (!picker) {
      picker = document.createElement('drive-picker');
      picker.setAttribute('client-id', '1059497343032-rcmtq18q4bgrc495qbdkg2kpt0q0arq9.apps.googleusercontent.com');
      picker.setAttribute('scopes', 'https://www.googleapis.com/auth/drive.readonly');

      picker.style.display = 'none';
      document.body.appendChild(picker);

      picker.addEventListener('picked', async e => {
        const { docs, token } = e.detail;
        const doc = docs[0]; // single file only

        const res = await fetch(`https://www.googleapis.com/drive/v3/files/${doc.id}?alt=media`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const blob = await res.blob();
        const file = new File([blob], doc.name, { type: 'application/pdf' });

        processPDF(file, {
          debugMode: document.getElementById('debugMode').checked,
          progressContainer: document.getElementById('progressContainer'),
          progressBar: document.getElementById('progressBar'),
          condensedCanvases: [],
          onCanvasRendered: () => {},
          abortSignal: null
        });
      });
    }

    picker.click();
  });
}
