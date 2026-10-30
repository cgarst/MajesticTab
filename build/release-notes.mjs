// Prints the user-facing release notes for the current app version from support/listing/changelogs/<version>.txt, the
// single source for every channel: Google Play, F-Droid, Flathub, Microsoft Store, GitHub releases,
// latest.json and the SideStore source. Exits non-zero if the file is missing, still the placeholder, or
// over Play's 500 character limit, so a release cannot go out without real notes.
//
// Play (fastlane) and F-Droid read fastlane/metadata/android/en-US/changelogs/<versionCode>.txt straight
// from the repo, so that path is a symlink to the canonical file. Without a flag the script also fails if
// the symlink is missing or wrong; `--link` creates it (run it when bumping the version).
// Usage: node build/release-notes.mjs [--link] [version]   (default: tauri.conf.json version)
import { readFileSync, existsSync, lstatSync, readlinkSync, symlinkSync, unlinkSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const link = args.includes('--link');
const version = args.find((arg) => !arg.startsWith('--'))
  || JSON.parse(readFileSync(path.join(rootDir, 'build/tauri/src-tauri/tauri.conf.json'), 'utf8')).version;
const [major, minor, patch] = version.split('.').map(Number);
const rel = (file) => path.relative(rootDir, file);
const fail = (message) => { console.error(message); process.exit(1); };

const file = path.join(rootDir, 'support/listing/changelogs', `${version}.txt`);
const fastlaneDir = path.join(rootDir, 'fastlane/metadata/android/en-US/changelogs');
const fastlaneFile = path.join(fastlaneDir, `${major * 1000000 + minor * 1000 + patch}.txt`);
const target = path.relative(fastlaneDir, file);

if (!existsSync(file)) fail(`Missing release notes: ${rel(file)}`);
const notes = readFileSync(file, 'utf8').trim();
if (!notes || /^bug fixes and improvements\.?$/i.test(notes)) fail(`Release notes for ${version} are empty or still the placeholder: ${rel(file)}`);
if (notes.length > 500) fail(`Release notes for ${version} are ${notes.length} characters; Google Play allows 500.`);

const linked = () => { try { return lstatSync(fastlaneFile).isSymbolicLink() && readlinkSync(fastlaneFile) === target; } catch { return false; } };
if (link && !linked()) {
  mkdirSync(fastlaneDir, { recursive: true });
  try { unlinkSync(fastlaneFile); } catch {}
  symlinkSync(target, fastlaneFile);
}
if (!linked()) fail(`${rel(fastlaneFile)} must be a symlink to ${target}; run: node build/release-notes.mjs --link`);
console.log(notes);
