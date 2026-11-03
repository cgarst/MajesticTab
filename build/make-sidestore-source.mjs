// Stamps source.json (SideStore / AltStore / LiveContainer source) with the release's version, date and IPA size.
// Usage: node build/make-sidestore-source.mjs [--canary] <version> <ipaFile> <outFile> [releaseUrl] [notes]
// --canary stamps the "MajesticTab Canary" entry (apps[1]) instead of the stable one, and keeps its fixed download URL.
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const canary = args.includes('--canary');
const [version, ipaFile, outFile, releaseUrl = '', notes = ''] = args.filter((a) => a !== '--canary');
if (!version || !ipaFile || !outFile) {
  console.error('Usage: node build/make-sidestore-source.mjs <version> <ipaFile> <outFile> [releaseUrl] [notes]');
  process.exit(2);
}

const source = JSON.parse(await readFile(new URL('../source.json', import.meta.url), 'utf8'));
const app = source.apps[canary ? 1 : 0];
app.version = version;
app.versionDate = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
app.size = (await stat(ipaFile)).size;
// The IPA name carries the version, so the download URL points at this release's asset.
if (releaseUrl && !canary) app.downloadURL = `${releaseUrl.replace('/releases/tag/', '/releases/download/')}/${path.basename(ipaFile)}`;
if (notes) app.versionDescription = releaseUrl ? `${notes}\n\n${releaseUrl}` : notes;
else if (releaseUrl) app.versionDescription = `See ${releaseUrl}`;
await writeFile(outFile, JSON.stringify(source, null, 2) + '\n');
