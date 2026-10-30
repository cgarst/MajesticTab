// Renames build outputs to the GitHub release naming scheme: MajesticTab-<version>-<platform>[-<arch>].<ext>.
// Usage: node build/name-release-assets.mjs <artifactsDir> <version>
// latest.json and source.json keep their fixed names (the updater and SideStore fetch them by URL). Signatures follow
// their file; a .sig stays valid because only the name changes.
import { readdir, rename } from 'node:fs/promises';
import path from 'node:path';

const [artifactsDir, version] = process.argv.slice(2);
if (!artifactsDir || !version) {
  console.error('Usage: node build/name-release-assets.mjs <artifactsDir> <version>');
  process.exit(2);
}

// [pattern for the build output name, "<platform>[-<arch>]" part of the release name]; the extension is kept.
const rules = [
  [/^MajesticTab_[\d.]+_x64-setup(\.exe(?:\.sig)?)$/, 'windows-x64-setup'],
  [/^MajesticTab_[\d.]+_arm64-setup(\.exe(?:\.sig)?)$/, 'windows-arm64-setup'],
  [/^MajesticTab_[\d.]+_aarch64(\.dmg)$/, 'macos-apple-silicon'],
  [/^MajesticTab_[\d.]+_x64(\.dmg)$/, 'macos-intel'],
  [/^MajesticTab_aarch64(\.app\.tar\.gz(?:\.sig)?)$/, 'macos-apple-silicon'],
  [/^MajesticTab_x86_64(\.app\.tar\.gz(?:\.sig)?)$/, 'macos-intel'],
  [/^MajesticTab-x86_64(\.flatpak)$/, 'linux-x86_64'],
  [/^MajesticTab-aarch64(\.flatpak)$/, 'linux-aarch64'],
  [/^MajesticTab-android(\.apk)$/, 'android'],
  // The fdroid channel: no Google Play services, no self-update (build-tauri.mjs names its signed APK this way).
  [/^MajesticTab-android-no-gms-no-update(\.apk)$/, 'android-no-gms-no-update'],
  [/^MajesticTab-ios(\.ipa)$/, 'ios'],
];

for (const name of await readdir(artifactsDir)) {
  for (const [pattern, label] of rules) {
    const match = pattern.exec(name);
    if (!match) continue;
    const renamed = `MajesticTab-${version}-${label}${match[1]}`;
    await rename(path.join(artifactsDir, name), path.join(artifactsDir, renamed));
    console.log(`${name} -> ${renamed}`);
    break;
  }
}
