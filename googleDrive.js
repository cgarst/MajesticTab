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
