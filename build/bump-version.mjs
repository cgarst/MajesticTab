// Bumps the app version everywhere it is kept in lockstep (see build/AGENTS.md and build/RELEASING.md):
//   - version in build/tauri/src-tauri/tauri.conf.json
//   - bundle.android.versionCode in tauri.android.conf.json (major * 1000000 + minor * 1000 + patch)
//   - the versionCode example in build/AGENTS.md
//   - support/listing/changelogs/<version>.txt, created with a default line when missing, plus the fastlane symlink
//     (Flatpak's metainfo and the fastlane changelog lookup fail without both; the default line is a legal note, so
//     whoever cuts the release overwrites it with the real notes)
// release.yml runs this after a release completes, so main always carries the next version and TestFlight beta builds
// have an open version train. Run by hand with an explicit version for a minor or major bump.
// Usage: node build/bump-version.mjs [version]   (default: the next patch of the current version)
import { readFileSync, writeFileSync, existsSync, symlinkSync, unlinkSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (message) => { console.error(message); process.exit(1); };
const read = (file) => readFileSync(path.join(rootDir, file), 'utf8');
const write = (file, text) => writeFileSync(path.join(rootDir, file), text);

const confFile = 'build/tauri/src-tauri/tauri.conf.json';
const androidFile = 'build/tauri/src-tauri/tauri.android.conf.json';
const guideFile = 'build/AGENTS.md';

const current = JSON.parse(read(confFile)).version;
const parse = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v || '');
  if (!m) fail(`Not a major.minor.patch version: ${v}`);
  return m.slice(1).map(Number);
};
const [cMajor, cMinor, cPatch] = parse(current);
const version = process.argv[2] || `${cMajor}.${cMinor}.${cPatch + 1}`;
const [major, minor, patch] = parse(version);
const versionCode = major * 1000000 + minor * 1000 + patch;
const oldCode = cMajor * 1000000 + cMinor * 1000 + cPatch;
if (version === current) fail(`Already at ${version}`);

const replaceOnce = (file, pattern, replacement) => {
  const text = read(file);
  if (!pattern.test(text)) fail(`${file}: pattern not found: ${pattern}`);
  write(file, text.replace(pattern, replacement));
};

// Targeted text replacement keeps each file's formatting.
replaceOnce(confFile, /("version":\s*")[^"]+(")/, `$1${version}$2`);
replaceOnce(androidFile, /("versionCode":\s*)\d+/, `$1${versionCode}`);
replaceOnce(guideFile, new RegExp(`\\(${current.replace(/\./g, '\\.')} is ${oldCode}\\)`), `(${version} is ${versionCode})`);

const changelogDir = 'support/listing/changelogs';
const notes = path.join(rootDir, changelogDir, `${version}.txt`);
if (!existsSync(notes)) write(`${changelogDir}/${version}.txt`, '- Bug fixes and stability improvements\n');

const fastlaneDir = path.join(rootDir, 'fastlane/metadata/android/en-US/changelogs');
const link = path.join(fastlaneDir, `${versionCode}.txt`);
mkdirSync(fastlaneDir, { recursive: true });
try { unlinkSync(link); } catch {}
symlinkSync(path.relative(fastlaneDir, notes), link);

console.log(`Bumped ${current} to ${version} (versionCode ${versionCode})`);
