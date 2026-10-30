// Stands in for src/driveBackup.js in channels without Google Drive (see stubs/no-drive/googleDrive.js).

export function createDriveBackend() {
    throw new Error('Google Drive is not available in this build.');
}
