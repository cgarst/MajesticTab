// OAuth client for the native desktop app. Both values are public by design: Google treats an installed app's
// client credentials as non-confidential (any packaged build contains them), so they are committed here like the
// client IDs in googleDrive.js. Builds can replace them with GOOGLE_DESKTOP_CLIENT_ID and
// GOOGLE_DESKTOP_CLIENT_KEY (see build/tauri/prepare-tauri-frontend.mjs). Loaded only on native desktop.
export const DESKTOP_CLIENT_ID = '1059497343032-f0st8cbjrjksj2m0hgjk70hh9cg7l910.apps.googleusercontent.com';
export const DESKTOP_CLIENT_KEY = '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';
