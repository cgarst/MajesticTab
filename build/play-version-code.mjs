// The versionCode of the Google Play (`play` channel) AAB. Play refuses a versionCode it has seen before, and the repo's own code
// (major * 1000000 + minor * 1000 + patch, in tauri.android.conf.json) is the same for every build of one version, so the Play
// code is that value times 1000 plus a slot:
//   - a stable release uses slot 999 (the default), so it outranks every beta of its version and is what testers get next;
//   - a beta (play-beta.yml) passes PLAY_BUILD_SLOT=1..998, which must rise with each upload of the same version.
// 1.2.2 is 1002002, so its release is 1002002999. Play's ceiling is 2100000000, which this scheme reaches at version 2.100.0.
// F-Droid and the GitHub APKs keep the plain code (see build/AGENTS.md); this only applies to the AAB sent to Play.
// Usage as a script: node build/play-version-code.mjs   (prints the code for the current version and PLAY_BUILD_SLOT)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLAY_RELEASE_SLOT = 999;
const PLAY_MAX_VERSION_CODE = 2_100_000_000;

export function playVersionCode(baseVersionCode, slotText = '') {
  const text = String(slotText ?? '').trim();
  const slot = text === '' ? PLAY_RELEASE_SLOT : Number(text);
  if (!Number.isInteger(slot) || slot < 1 || slot > PLAY_RELEASE_SLOT) {
    throw new Error(`PLAY_BUILD_SLOT must be a whole number from 1 to ${PLAY_RELEASE_SLOT}, got "${text}".`);
  }
  const code = baseVersionCode * 1000 + slot;
  if (code > PLAY_MAX_VERSION_CODE) throw new Error(`Play versionCode ${code} is above Google's limit of ${PLAY_MAX_VERSION_CODE}.`);
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const conf = JSON.parse(readFileSync(path.join(rootDir, 'build/tauri/src-tauri/tauri.android.conf.json'), 'utf8'));
  try {
    console.log(playVersionCode(conf.bundle.android.versionCode, process.env.PLAY_BUILD_SLOT));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
