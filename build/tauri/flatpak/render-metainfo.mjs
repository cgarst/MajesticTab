// Fills the metainfo template in place from the release itself, so nothing in it is edited per release:
// version (tauri.conf.json), notes (fastlane changelog for that version), date (HEAD commit date).
// Usage: node render-metainfo.mjs <metainfo.xml>
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const file = process.argv[2];
const version = JSON.parse(readFileSync(path.join(rootDir, 'build/tauri/src-tauri/tauri.conf.json'), 'utf8')).version;
const [major, minor, patch] = version.split('.').map(Number);
const changelog = path.join(rootDir, 'fastlane/metadata/android/en-US/changelogs', `${major * 1000000 + minor * 1000 + patch}.txt`);
const notes = readFileSync(changelog, 'utf8').trim();
let date;
try {
  date = execFileSync('git', ['log', '-1', '--format=%cs'], { cwd: rootDir, encoding: 'utf8' }).trim();
} catch {}
date ||= new Date().toISOString().slice(0, 10);
const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
writeFileSync(file, readFileSync(file, 'utf8')
  .replaceAll('__APP_VERSION__', version)
  .replaceAll('__RELEASE_DATE__', date)
  .replaceAll('__RELEASE_NOTES__', escape(notes)));
