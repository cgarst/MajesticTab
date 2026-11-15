// The versionCode of the Google Play (`play` channel) AAB. Play refuses a versionCode it has seen before, and the repo's own code
// (major * 1000000 + minor * 1000 + patch, in tauri.android.conf.json) is the same for every build of one version.
//   - a stable release (empty slot) uses that plain code, the same as F-Droid and the GitHub APKs. Play warns when a release's code
//     is far above the previous production code, and a scaled code would use up the 2100000000 ceiling;
//   - a beta (play-beta.yml) passes PLAY_BUILD_SLOT=1..998, which must rise with each upload of the same version, and gets
//     the code times 1000 plus the slot. Betas only go to the internal track, so their size does not matter, but they outrank the
//     release code: testers on a beta must reinstall to get the production build.
// 1.2.4 is 1002004, so its release is 1002004 and its betas are 1002004001 to 1002004998.
// Usage as a script: node build/play-version-code.mjs   (prints the code for the current version and PLAY_BUILD_SLOT)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLAY_MAX_SLOT = 998;
const PLAY_MAX_VERSION_CODE = 2_100_000_000;

export function playVersionCode(baseVersionCode, slotText = '') {
  const text = String(slotText ?? '').trim();
  if (text === '') return baseVersionCode;
  const slot = Number(text);
  if (!Number.isInteger(slot) || slot < 1 || slot > PLAY_MAX_SLOT) {
    throw new Error(`PLAY_BUILD_SLOT must be a whole number from 1 to ${PLAY_MAX_SLOT}, got "${text}".`);
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
