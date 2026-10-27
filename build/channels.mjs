// Distribution channels: the single source of truth for what each build ships.
// Mirrors the feature matrix in the store builds plan. `direct` is the current full-featured build.
//
// This is the store/distribution channel, not the CI release channel (MAJESTICTAB_CHANNEL, stable or
// nightly, written to build-info.js for the updater).

export const DEFAULT_CHANNEL = 'direct';

// Features the paid "MajesticTab Supporter" purchase unlocks on channels with monetization 'iap'.
export const SUPPORTER_FEATURES = ['themes', 'sheetModes', 'jamHost', 'setlists', 'batchExport', 'customSoundFonts'];

const FULL = {
  tabDownloader: 'google-only', // 'google-only' | 'off'
  userscripts: true, // ships the userscript editor; store builds turn it off (restored backups' userscripts run regardless)
  extensions: 'full', // 'full' | 'off'
  selfUpdate: true,
  googleDrive: true,
  youtube: 'full', // 'full' | 'official-origin' (official IFrame origin, no Referer override)
  monetization: 'none', // 'none' | 'iap'
  supporterProductId: null,
  storeName: null, // shown as "Manage in <storeName>" on the Supporter card
  supporterManageUrl: null, // where the store lists purchases; opened by the Supporter card
};

// One-time "MajesticTab Supporter" product (non-consumable). Create it with this ID in App Store Connect
// and Google Play Console.
const SUPPORTER_PRODUCT_ID = 'net.zathu.majestictab.supporter';
// Microsoft Store durable add-on (Store ID 9PBGGCDJ7776). The IAP plugin finds it by this developer-defined
// Product ID in Partner Center, not by the Store ID.
const MSSTORE_SUPPORTER_PRODUCT_ID = 'majestictab-supporter-2026-win';

// Where "Manage in <store>" goes: the app's own store page on Google Play and the Microsoft Store (opened by
// custom scheme, which src-tauri/capabilities/default.json must allow), the purchase history on Apple (there is
// no per-purchase page for one-time products, and the app's store ID is not known yet).
const APPLE_STORE = { storeName: 'the App Store', supporterManageUrl: 'https://reportaproblem.apple.com/' };
const PLAY_STORE = { storeName: 'Google Play', supporterManageUrl: 'market://details?id=net.zathu.majestictab' };
const MS_STORE = { storeName: 'Microsoft Store', supporterManageUrl: 'ms-windows-store://pdp/?productid=9P7MB2C84CFV' };

const STORE_DOWNLOADER = { selfUpdate: false, userscripts: false };

export const channels = {
  direct: {
    platforms: ['windows', 'macos', 'linux', 'android', 'ios'],
    capabilities: { ...FULL },
  },
  play: {
    platforms: ['android'],
    capabilities: { ...FULL, ...STORE_DOWNLOADER, youtube: 'official-origin', monetization: 'iap', supporterProductId: SUPPORTER_PRODUCT_ID, ...PLAY_STORE },
  },
  fdroid: {
    platforms: ['android'],
    capabilities: { ...FULL, selfUpdate: false, googleDrive: false },
  },
  'appstore-ios': {
    platforms: ['ios'],
    capabilities: { ...FULL, ...STORE_DOWNLOADER, monetization: 'iap', supporterProductId: SUPPORTER_PRODUCT_ID, ...APPLE_STORE },
  },
  'appstore-mac': {
    platforms: ['macos'],
    capabilities: { ...FULL, ...STORE_DOWNLOADER, monetization: 'iap', supporterProductId: SUPPORTER_PRODUCT_ID, ...APPLE_STORE },
  },
  flathub: {
    platforms: ['linux'],
    capabilities: { ...FULL, selfUpdate: false },
  },
  msstore: {
    platforms: ['windows'],
    capabilities: { ...FULL, ...STORE_DOWNLOADER, monetization: 'iap', supporterProductId: MSSTORE_SUPPORTER_PRODUCT_ID, ...MS_STORE },
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
