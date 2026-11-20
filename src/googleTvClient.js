// OAuth client for Android TV, type "TVs and Limited Input devices". Android TV has no Google Play services consent
// screen and no browser redirect, so sign-in uses the device flow: the TV shows a code and the user approves it on a
// phone or computer. This client type may request only drive.file, never drive.readonly.
// The values are empty in the repository. Tauri builds fill them from GOOGLE_TV_CLIENT_ID and
// GOOGLE_TV_CLIENT_SECRET in .env or the environment (see build/tauri/prepare-tauri-frontend.mjs). Loaded only on
// Android TV.
export const TV_CLIENT_ID = '';
export const TV_CLIENT_KEY = '';
