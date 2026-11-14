// Reference reader and writer for .mtab (Multi-Track Tab) version 1, portable core.
// Runs wherever Uint8Array, TextDecoder, Compression Streams and Web Crypto exist: Node 22, browsers, webviews.
// It reads an archive through a ByteSource (see source.js), so a large file is read by range and never held whole.
import { LIMITS, MtabError, checkEntryName, readDirectory, readEntry, entryRange, entryStream, zipParts } from './zip.js';
import { validateManifest, validateSync, ANCHOR } from './check.js';

/** The media type of a .mtab file. It is not written inside the archive. */
export const MEDIA_TYPE = 'application/vnd.mtab+zip';

/** Lowercase hex SHA-256 of a Uint8Array, using Web Crypto. */
export async function sha256(bytes) {
  const d = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Opens a bundle from a ByteSource. Throws MtabError for a bundle a reader must reject.
 * Reads the end of the archive, the central directory, the manifest, the tab and the sync files, and no audio.
 * Hash mismatches are warnings, not errors (SPEC section 12).
 *
 * Returns { manifest, entries, warnings, tab, sync(recId), defaultRecording(), file(path, maxSize), stream(path), range(path) }:
 *   tab        the tab file's bytes (or null when tab.externalPath is used and no externalTab was provided/resolved)
 *   sync(id)   the recording's sync points resolved on its own timeline (section 9), or null
 *   file(path) one entry read whole; stream(path) one entry as chunks; range(path) a Stored entry's {start, end} in the archive
 */
export async function openMtab(source, { limits = LIMITS, hash = sha256, externalTab } = {}) {
  const entries = await readDirectory(source, limits);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const me = byName.get('manifest.json');
  if (!me) throw new MtabError('missing manifest.json');
  const mbytes = await readEntry(source, me, { maxSize: limits.maxManifest, limits });
  if (mbytes[0] === 0xef && mbytes[1] === 0xbb && mbytes[2] === 0xbf) throw new MtabError('manifest has a byte order mark');
  let manifest;
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(mbytes)); } catch (e) { throw new MtabError(`manifest is not JSON: ${e.message}`); }
  if (typeof manifest?.version === 'number' && manifest.version > 1) throw new MtabError(`unsupported version ${manifest.version}`);
  const errs = validateManifest(manifest);
  if (errs.length) throw new MtabError(`invalid manifest:\n  ${errs.join('\n  ')}`);

  const warnings = [];
  const need = (p) => { const e = byName.get(p); if (!e) throw new MtabError(`missing entry ${p}`); return e; };
  const file = (p, maxSize = Infinity) => readEntry(source, need(p), { maxSize, limits });
  const stream = (p) => entryStream(source, need(p), { limits });
  const range = (p) => entryRange(need(p));
  let tab = null;
  if (manifest.tab.path) {
    tab = await file(manifest.tab.path);
    if (await hash(tab) !== manifest.tab.sha256) warnings.push(`tab sha256 mismatch: ${manifest.tab.path}`);
  } else {
    checkEntryName(manifest.tab.externalPath);
    if (externalTab) {
      tab = typeof externalTab === 'function' ? await externalTab(manifest.tab.externalPath, warnings) : externalTab;
      if (tab && await hash(tab) !== manifest.tab.sha256) warnings.push(`tab sha256 mismatch: ${manifest.tab.externalPath}`);
    }
  }
  const syncs = new Map();
  for (const r of manifest.recordings || []) {
    if (r.sync) {
      if (!byName.has(r.sync)) { warnings.push(`${r.id}: missing sync file ${r.sync}`); continue; }
      let s;
      try { s = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await file(r.sync, limits.maxSync))); } catch (e) { warnings.push(`${r.sync}: ${e.message}`); continue; }
      const se = validateSync(s, manifest.tab.format);
      if (se.length) { warnings.push(`${r.sync}: ${se.join('; ')}`); continue; }
      if (s.recording !== r.id) { warnings.push(`${r.sync}: recording id mismatch`); continue; }
      syncs.set(r.id, s);
    }
    for (const src of r.sources || []) {
      if (src.type === 'embedded' && manifest.tab.format !== 'gp') warnings.push(`${r.id}: embedded source on a ${manifest.tab.format} tab, skipped`);
      if (src.type === 'file' && !byName.has(src.path)) warnings.push(`${r.id}: missing audio file ${src.path}`);
    }
  }
  // Sync of a recording: its own file, else syncFrom (plus syncOffsetMs), else stemOf. Offsets add along the chain.
  const resolveSync = (id) => {
    const recs = manifest.recordings || [];
    let cur = recs.find((r) => r.id === id), offset = 0;
    for (let n = 0; cur && n <= recs.length; n++) {
      if (syncs.has(cur.id)) {
        const s = syncs.get(cur.id);
        return { ...s, recording: id, points: s.points.map((p) => ({ ...p, timeMs: p.timeMs + offset })).filter((p) => p.timeMs >= 0) };
      }
      if (cur.syncFrom) offset += cur.syncOffsetMs || 0;
      cur = recs.find((r) => r.id === (cur.syncFrom || cur.stemOf));
    }
    return null;
  };
  const defaultRecording = () => {
    const recs = manifest.recordings || [];
    return recs.find((r) => r.id === manifest.defaultRecording) || recs.find((r) => r.role === 'original') || recs[0] || null;
  };
  return { manifest, entries: entries.map((e) => e.name), warnings, tab, sync: resolveSync, defaultRecording, file, stream, range };
}

/**
 * Checks an audio source's `sha256` by streaming it, so no audio is held whole. Returns true, false, or null when the
 * recording source has no hash. `hasher` is `() => ({ update(u8), digest() -> hex })`; the core has no streaming SHA-256
 * of its own, because Web Crypto has none, so a caller supplies one (Node's `crypto.createHash`, or a WASM hash).
 */
export async function verifyAudioHash(opened, src, hasher) {
  if (src.type !== 'file' || !src.sha256) return null;
  const h = hasher();
  const reader = opened.stream(src.path).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    h.update(value);
  }
  return h.digest() === src.sha256;
}

/**
 * Builds a bundle as parts (see zipParts), without holding the audio in memory.
 * `files` is a Map or object of archive path -> Uint8Array | { source, start?, end? } (tab, audio, sync).
 * The caller puts the tab's `format` and `sha256` in `manifest`.
 */
export async function buildMtab(manifest, files, { zip64Threshold } = {}) {
  const errs = validateManifest(manifest);
  if (errs.length) throw new MtabError(`invalid manifest:\n  ${errs.join('\n  ')}`);
  const list = [
    { name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest, null, 2) + '\n') },
  ];
  for (const [name, data] of files instanceof Map ? files : Object.entries(files))
    list.push({ name, data, store: name.startsWith('audio/') });
  return zipParts(list, { zip64Threshold });
}

/** A tab entry for the manifest: path, format (from the extension) and sha256. */
export async function tabEntry(path, bytes) {
  return { path, format: path.split('.').pop().toLowerCase(), sha256: await sha256(bytes) };
}

export { LIMITS, MtabError, ANCHOR, validateManifest, validateSync };
