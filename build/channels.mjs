// Distribution channels: the single source of truth for what each build ships.
// Mirrors the feature matrix in the store builds plan. `direct` is the current full-featured build.
//
// This is the store/distribution channel, not the CI release channel (MAJESTICTAB_CHANNEL, stable or
// nightly, written to build-info.js for the updater).

export const DEFAULT_CHANNEL = 'direct';

const FULL = {
  tabDownloader: 'google-only', // 'google-only' | 'off'
  userscripts: true, // ships the userscript editor; store builds turn it off (restored backups' userscripts run regardless)
  extensions: 'full', // 'full' | 'off'
  selfUpdate: true,
  googleDrive: true,
  youtube: 'full', // 'full' | 'official-origin' (official IFrame origin, no Referer override)
};

const STORE_DOWNLOADER = { selfUpdate: false, userscripts: false };

export const channels = {
  direct: {
    platforms: ['windows', 'macos', 'linux', 'android', 'ios'],
    capabilities: { ...FULL },
  },
  play: {
    platforms: ['android'],
    capabilities: { ...FULL, ...STORE_DOWNLOADER, youtube: 'official-origin' },
  },
  fdroid: {
    platforms: ['android'],
    capabilities: { ...FULL, selfUpdate: false, googleDrive: false },
  },
  'appstore-ios': {
    platforms: ['ios'],
    capabilities: { ...FULL, ...STORE_DOWNLOADER },
  },
  'appstore-mac': {
    platforms: ['macos'],
    capabilities: { ...FULL, ...STORE_DOWNLOADER },
  },
  flathub: {
    platforms: ['linux'],
    capabilities: { ...FULL, selfUpdate: false },
  },
  msstore: {
    platforms: ['windows'],
    capabilities: { ...FULL, ...STORE_DOWNLOADER },
  },
};

export function isValidChannel(id) {
  return Object.hasOwn(channels, id);
}

export function resolveChannel(id) {
  if (!isValidChannel(id)) throw new Error(`Unknown channel "${id}". Valid channels: ${Object.keys(channels).join(', ')}`);
  const { capabilities } = channels[id];
  return {
    channel: id,
    ...capabilities,
  };
}

/** Cargo features the channel builds with (build/tauri/src-tauri/Cargo.toml replaces its `default` with these). */
export function cargoFeatures(id) {
  const { selfUpdate } = channels[id].capabilities;
  return [
    ...(selfUpdate ? ['self-update'] : []),
  ];
}
