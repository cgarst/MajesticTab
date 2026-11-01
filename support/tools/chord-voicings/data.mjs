// Loads the three chord sets. src/referenceLibrary.js pulls in browser-only modules, so its 6-string array is read
// out of the source text instead of being imported.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const referenceLibraryPath = path.join(rootDir, 'src', 'referenceLibrary.js');
export const extendedRangePath = path.join(rootDir, 'src', 'extendedRangeChords.js');

export async function loadChordSets() {
  const source = readFileSync(referenceLibraryPath, 'utf8');
  const start = source.indexOf('export const chordData = [');
  const end = source.indexOf('\n];', start) + 3;
  const chordData = new Function(`${source.slice(start, end).replace('export const chordData =', 'return')}`)();
  const { chordData7, chordData8 } = await import(pathToFileURL(extendedRangePath).href);
  return { 6: chordData, 7: chordData7, 8: chordData8 };
}
