// Distribution channels: the single source of truth for what each build ships.
// Mirrors the feature matrix in the store builds plan. `direct` is the current full-featured build.
//
// This is the store/distribution channel, not the CI release channel (MAJESTICTAB_CHANNEL, stable or
// nightly, written to build-info.js for the updater).

export const DEFAULT_CHANNEL = 'direct';

// Features the paid "MajesticTab Supporter" purchase unlocks on channels with monetization 'iap'.
export const SUPPORTER_FEATURES = ['themes', 'sheetModes', 'jamHost', 'setlists', 'batchExport', 'customSoundFonts'];

const FULL = {
  tabDownloader: 'full', // 'full' | 'google-only' | 'off'
  userscripts: true, // ships the built-in userscripts and their editor; userscripts restored from a backup run regardless
  extensions: 'full', // 'full' | 'off'
  selfUpdate: true,
  googleDrive: true,
  youtube: 'full', // 'full' | 'official-origin' (official IFrame origin, no Referer override)
  monetization: 'none', // 'none' | 'iap'
  supporterProductId: null,
};

// One-time "MajesticTab Supporter" product (non-consumable). Create it with this ID in App Store Connect
// and Google Play Console.
const SUPPORTER_PRODUCT_ID = 'net.zathu.majestictab.supporter';
// Microsoft Store durable add-on (Store ID 9PBGGCDJ7776). The IAP plugin finds it by this developer-defined
// Product ID in Partner Center, not by the Store ID.
const MSSTORE_SUPPORTER_PRODUCT_ID = 'majestictab-supporter-2026-win';

const STORE_DOWNLOADER = { tabDownloader: 'google-only', userscripts: false, selfUpdate: false };

export const channels = {
  direct: {
    platforms: ['windows', 'macos', 'linux', 'android', 'ios'],
    capabilities: { ...FULL },
  },
  play: {
    platforms: ['android'],
    capabilities: { ...FULL, ...STORE_DOWNLOADER, youtube: 'official-origin', monetization: 'iap', supporterProductId: SUPPORTER_PRODUCT_ID },
  },
  fdroid: {
    platforms: ['android'],
    capabilities: { ...FULL, selfUpdate: false, googleDrive: false },
  },
  'appstore-ios': {
    platforms: ['ios'],
    capabilities: { ...FULL, ...STORE_DOWNLOADER, monetization: 'iap', supporterProductId: SUPPORTER_PRODUCT_ID },
  },
  'appstore-mac': {
    platforms: ['macos'],
    capabilities: { ...FULL, ...STORE_DOWNLOADER, monetization: 'iap', supporterProductId: SUPPORTER_PRODUCT_ID },
  },
  flathub: {
    platforms: ['linux'],
    capabilities: { ...FULL, selfUpdate: false },
  },
  msstore: {
    platforms: ['windows'],
    capabilities: { ...FULL, ...STORE_DOWNLOADER, monetization: 'iap', supporterProductId: MSSTORE_SUPPORTER_PRODUCT_ID },
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
    supporterFeatures: capabilities.monetization === 'iap' ? SUPPORTER_FEATURES : [],
  };
}

/** Cargo features the channel builds with (build/tauri/src-tauri/Cargo.toml replaces its `default` with these). */
export function cargoFeatures(id) {
  const { selfUpdate, monetization } = channels[id].capabilities;
  return [
    ...(monetization === 'iap' ? ['iap'] : []),
    ...(selfUpdate ? ['self-update'] : []),
  ];
}
