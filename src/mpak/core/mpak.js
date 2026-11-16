// Reference reader and writer for .mpak (Music Pack) version 1, portable core.
// Runs wherever Uint8Array, TextDecoder, Compression Streams and Web Crypto exist: Node 22, browsers, webviews.
// It reads an archive through a ByteSource (see source.js), so a large file is read by range and never held whole.
import { LIMITS, MpakError, checkEntryName, readDirectory, readEntry, entryRange, entryStream, zipParts } from './zip.js';
import { validateManifest, validateSync, validateBeats, ANCHOR } from './check.js';

/** The media type of a .mpak file. It is not written inside the archive. */
export const MEDIA_TYPE = 'application/vnd.mpak+zip';

/** The namespace of the derived pack id (SPEC section 4, "Pack identity"). */
export const PACK_ID_NAMESPACE = '03924935-9520-4f8c-91cd-ebd5f6cf57c5';

/**
 * The `id` a tool gives a pack that has none: the UUID version 5 (RFC 4122) of the primary score's `sha256` (64 lowercase hex
 * characters, as UTF-8) in PACK_ID_NAMESPACE. Two tools that do this for the same file choose the same id.
 */
export async function derivedPackId(scoreSha256) {
  const ns = PACK_ID_NAMESPACE.replace(/-/g, '').match(/../g).map((h) => parseInt(h, 16));
  const name = new TextEncoder().encode(String(scoreSha256).toLowerCase());
  const input = new Uint8Array(ns.length + name.length);
  input.set(ns); input.set(name, ns.length);
  const h = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-1', input)).slice(0, 16);
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** Lowercase hex SHA-256 of a Uint8Array, using Web Crypto. */
export async function sha256(bytes) {
  const d = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Opens a bundle from a ByteSource. Throws MpakError for a bundle a reader must reject.
 * Reads the end of the archive, the central directory, the manifest, the score and the sync files, and no audio.
 * Hash mismatches are warnings, not errors (SPEC section 12).
 *
 * Returns { manifest, entries, warnings, score, scoreBytes(id), sync(recId, scoreId), defaultRecording(), file(path, maxSize), stream(path), range(path) }:
 *   score        the primary score file's bytes (or null when it uses externalPath and no externalScore was provided/resolved)
 *   scoreBytes(id)  the same for any score or alternate by its id
 *   beats(id)   the recording's beat file (beats and sections), resolved on its own timeline (section 7), or null
 *   sync(id, scoreId)   the recording's sync points for a score (default: the primary), resolved on its own timeline (section 9), or null
 *   file(path) one entry read whole; stream(path) one entry as chunks; range(path) a Stored entry's {start, end} in the archive
 */
export async function openMpak(source, { limits = LIMITS, hash = sha256, externalScore } = {}) {
  const entries = await readDirectory(source, limits);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const me = byName.get('manifest.json');
  if (!me) throw new MpakError('missing manifest.json');
  const mbytes = await readEntry(source, me, { maxSize: limits.maxManifest, limits });
  if (mbytes[0] === 0xef && mbytes[1] === 0xbb && mbytes[2] === 0xbf) throw new MpakError('manifest has a byte order mark');
  let manifest;
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(mbytes)); } catch (e) { throw new MpakError(`manifest is not JSON: ${e.message}`); }
  if (typeof manifest?.version === 'number' && manifest.version > 1) throw new MpakError(`unsupported version ${manifest.version}`);
  const errs = validateManifest(manifest);
  if (errs.length) throw new MpakError(`invalid manifest:\n  ${errs.join('\n  ')}`);

  const warnings = [];
  const need = (p) => { const e = byName.get(p); if (!e) throw new MpakError(`missing entry ${p}`); return e; };
  const file = (p, maxSize = Infinity) => readEntry(source, need(p), { maxSize, limits });
  const stream = (p) => entryStream(source, need(p), { limits });
  const range = (p) => entryRange(need(p));
  // Every score in `scores`, primary first, then each one's alternates. A score stored outside the archive (externalPath) is null unless it was resolved.
  const scoreBytes = new Map();
  for (const t of manifest.scores.flatMap((x) => [x, ...(x.alternates || [])])) {
    let bytes = null;
    if (t.path) {
      bytes = await file(t.path);
      if (await hash(bytes) !== t.sha256) warnings.push(`score sha256 mismatch: ${t.path}`);
      if (t.size !== undefined && t.size !== bytes.length) warnings.push(`score size mismatch: ${t.path}`);
    } else {
      checkEntryName(t.externalPath);
      if (externalScore) {
        bytes = typeof externalScore === 'function' ? await externalScore(t.externalPath, warnings) : externalScore;
        if (bytes && await hash(bytes) !== t.sha256) warnings.push(`score sha256 mismatch: ${t.externalPath}`);
      }
    }
    scoreBytes.set(t.id, bytes ?? null);
  }
  const primary = manifest.scores[0];
  const score = scoreBytes.get(primary.id);
  const scoreOf = (id) => manifest.scores.find((t) => t.id === id);
  // A sync or beat file listed in `entries` is checked against its size and hash (SPEC section 4, "Integrity"). A mismatch is a warning.
  const checked = new Set();
  const checkEntry = async (path, bytes) => {
    const info = manifest.entries?.[path];
    if (!info || checked.has(path)) return;
    checked.add(path);
    if (info.size !== bytes.length) warnings.push(`${path}: size differs from the manifest`);
    else if (await hash(bytes) !== info.sha256) warnings.push(`${path}: sha256 differs from the manifest`);
  };
  const syncs = new Map(); // `${scoreId}\n${recordingId}` -> sync file
  const beatFiles = new Map(); // recordingId -> beat file
  for (const r of manifest.recordings || []) {
    for (const [sid, sp] of Object.entries(r.sync || {})) {
      const t = scoreOf(sid);
      if (!byName.has(sp)) { warnings.push(`${r.id}: missing sync file ${sp}`); continue; }
      let sf;
      try { const sb = await file(sp, limits.maxSync); await checkEntry(sp, sb); sf = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(sb)); } catch (e) { warnings.push(`${sp}: ${e.message}`); continue; }
      const se = validateSync(sf, t.format);
      if (se.length) { warnings.push(`${sp}: ${se.join('; ')}`); continue; }
      if (sf.recording !== r.id) { warnings.push(`${sp}: recording id mismatch`); continue; }
      if (sf.score !== sid) { warnings.push(`${sp}: score id mismatch`); continue; }
      syncs.set(`${sid}\n${r.id}`, sf);
    }
    if (r.beats) {
      if (!byName.has(r.beats)) warnings.push(`${r.id}: missing beat file ${r.beats}`);
      else {
        try {
          const bb = await file(r.beats, limits.maxSync);
          await checkEntry(r.beats, bb);
          const bf = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bb));
          const be = validateBeats(bf);
          if (be.length) warnings.push(`${r.beats}: ${be.join('; ')}`);
          else if (bf.recording !== r.id) warnings.push(`${r.beats}: recording id mismatch`);
          else beatFiles.set(r.id, bf);
        } catch (e) { warnings.push(`${r.beats}: ${e.message}`); }
      }
    }
    for (const src of r.sources || []) {
      if (src.type === 'embedded') {
        const holder = scoreOf(src.score ?? primary.id);
        if (holder.format !== 'gp') warnings.push(`${r.id}: embedded source on a ${holder.format} score, skipped`);
      }
      if (src.type === 'file' && !byName.has(src.path)) warnings.push(`${r.id}: missing audio file ${src.path}`);
      else if (src.type === 'file' && src.size !== undefined && src.size !== byName.get(src.path).usize) warnings.push(`${r.id}: audio size differs from the manifest: ${src.path}`);
    }
  }
  // Sync of a recording for a score: its own file, else syncFrom (plus syncOffsetMs), else stemOf. Offsets add along the chain.
  // The score defaults to the primary score.
  const resolveSync = (id, scoreId = primary.id) => {
    const recs = manifest.recordings || [];
    let cur = recs.find((r) => r.id === id), offset = 0;
    for (let n = 0; cur && n <= recs.length; n++) {
      const own = syncs.get(`${scoreId}\n${cur.id}`);
      if (own) return { ...own, recording: id, points: own.points.map((p) => ({ ...p, timeMs: p.timeMs + offset })).filter((p) => p.timeMs >= 0) };
      if (cur.syncFrom) offset += cur.syncOffsetMs || 0;
      cur = recs.find((r) => r.id === (cur.syncFrom || cur.stemOf));
    }
    return null;
  };
  // Beat file of a recording: its own, else syncFrom (plus syncOffsetMs), else stemOf (section 7, "Beat file").
  const resolveBeats = (id) => {
    const recs = manifest.recordings || [];
    let cur = recs.find((r) => r.id === id), offset = 0;
    for (let n = 0; cur && n <= recs.length; n++) {
      const own = beatFiles.get(cur.id);
      if (own) {
        const move = (x) => ({ ...x, timeMs: x.timeMs + offset });
        const keep = (x) => x.timeMs >= 0;
        return { ...own, recording: id, beats: own.beats.map(move).filter(keep), ...(own.sections ? { sections: own.sections.map(move).filter(keep) } : {}) };
      }
      if (cur.syncFrom) offset += cur.syncOffsetMs || 0;
      cur = recs.find((r) => r.id === (cur.syncFrom || cur.stemOf));
    }
    return null;
  };
  const defaultRecording = () => (manifest.recordings || [])[0] || null;
  return { manifest, entries: entries.map((e) => e.name), warnings, score, scoreBytes: (id) => scoreBytes.get(id) ?? null, sync: resolveSync, beats: resolveBeats, defaultRecording, file, stream, range };
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
 * `files` is a Map or object of archive path -> Uint8Array | { source, start?, end? } (score, audio, sync).
 * The caller puts the score's `format` and `sha256` in `manifest`.
 */
export async function buildMpak(manifest, files, { zip64Threshold } = {}) {
  const errs = validateManifest(manifest);
  if (errs.length) throw new MpakError(`invalid manifest:\n  ${errs.join('\n  ')}`);
  const list = [
    { name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest, null, 2) + '\n') },
  ];
  for (const [name, data] of files instanceof Map ? files : Object.entries(files))
    list.push({ name, data, store: name.startsWith('audio/') });
  return zipParts(list, { zip64Threshold });
}

/** A score entry for the manifest: path, format (from the extension) and sha256. */
const EXT_FORMAT = { atex: 'alphatex', mid: 'midi' };
export async function scoreEntry(path, bytes) {
  const ext = path.split('.').pop().toLowerCase();
  return { path, format: EXT_FORMAT[ext] ?? ext, sha256: await sha256(bytes) };
}

export { LIMITS, MpakError, ANCHOR, validateManifest, validateSync, validateBeats };
