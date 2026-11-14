// Fills the metainfo template in place from the release itself, so nothing in it is edited per release:
// version (tauri.conf.json), summary and description (support/listing), notes (support/listing/changelogs/<version>.txt), date (HEAD commit date).
// Usage: node render-metainfo.mjs <metainfo.xml>
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const file = process.argv[2];
const version = JSON.parse(readFileSync(path.join(rootDir, 'build/tauri/src-tauri/tauri.conf.json'), 'utf8')).version;
const notes = execFileSync('node', [path.join(rootDir, 'build/release-notes.mjs'), '--platform', 'linux'], {
  cwd: rootDir,
  encoding: 'utf8',
}).trim();
let date;
try {
  date = execFileSync('git', ['log', '-1', '--format=%cs'], { cwd: rootDir, encoding: 'utf8' }).trim();
} catch {}
date ||= new Date().toISOString().slice(0, 10);
const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const listing = (name) => readFileSync(path.join(rootDir, 'support/listing', name), 'utf8').trim();
// Blocks separated by blank lines: "• " lines become a list, anything else (including the section titles) a paragraph.
const description = listing('full_description.txt').split(/\n\s*\n/).flatMap((block) => {
  const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.map((line, i) => {
    if (!line.startsWith('• ')) return `<p>${escape(line)}</p>`;
    const start = i === 0 || !lines[i - 1].startsWith('• ');
    const end = i === lines.length - 1 || !lines[i + 1].startsWith('• ');
    return `${start ? '<ul>' : ''}<li>${escape(line.slice(2))}</li>${end ? '</ul>' : ''}`;
  });
}).map((line) => `    ${line}`).join('\n');
// "- " lines become a list, anything else a paragraph.
const lines = notes.split('\n').map((line) => line.trim()).filter(Boolean);
const items = lines.filter((line) => line.startsWith('- ')).map((line) => `<li>${escape(line.slice(2))}</li>`);
const markup = items.length === lines.length
  ? `<ul>${items.join('')}</ul>`
  : lines.map((line) => `<p>${escape(line)}</p>`).join('');
writeFileSync(file, readFileSync(file, 'utf8')
  .replaceAll('__SUMMARY__', escape(listing('short_description.txt').replace(/\.$/, '')))
  .replaceAll('__DESCRIPTION__', () => description)
  .replaceAll('__APP_VERSION__', version)
  .replaceAll('__RELEASE_DATE__', date)
  .replaceAll('__RELEASE_NOTES__', markup));
