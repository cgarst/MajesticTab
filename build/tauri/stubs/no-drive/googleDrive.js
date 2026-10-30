// Stands in for src/googleDrive.js in channels without Google Drive (see prepare-tauri-frontend.mjs), so the
// OAuth flow, client IDs and Drive API calls do not ship. Exports mirror the real module; verify-channel.mjs checks that.
// The UI never offers Drive in these channels, so everything here is inert or rejects.

const unavailable = () => new Error('Google Drive is not available in this build.');

export const GDRIVE_SECRET_NAME = 'gdrive_refresh_token';
export function migrateGoogleAuth() {}
export async function ensureFreshToken() {}
export function isTokenValid() { return false; }
export async function driveFetch() { throw unavailable(); }
export function clearStoredToken() {}
export async function isGoogleDriveConnected() { return false; }
export function disconnectGoogleDrive() {}
export function isMobilePlatform() { return false; }
export function redirectToGoogleAuth() { throw unavailable(); }
export async function pickDriveFile() { throw unavailable(); }
export async function openDrivePicker() { throw unavailable(); }
export function setupDrivePicker() {}
export async function saveFileToDrive() { throw unavailable(); }
export async function fetchDriveBackups() { throw unavailable(); }
export async function downloadDriveBackupFile() { throw unavailable(); }
export const downloadDriveFile = downloadDriveBackupFile;
