// ZIP reader and writer for .mtab containers (SPEC.md sections 3 and 12). No Node, DOM or Buffer dependency: it runs on
// Uint8Array, DataView, TextDecoder and the standard Compression Streams (Node 18+, current browsers, webviews).
// Stored and Deflate only, no encryption. The reader understands ZIP64 and never loads more than it is asked for.
import { crc32 } from './crc32.js';
import { CHUNK, readExact } from './source.js';

export const LIMITS = {
  maxEntries: 1000,
  maxRatio: 100,
  maxManifest: 1 << 20,
  maxSync: 8 << 20,
  maxDirectory: 16 << 20,
};

export class MtabError extends Error {}

const SIG_LOCAL = 0x04034b50, SIG_CEN = 0x02014b50, SIG_EOCD = 0x06054b50;
const SIG_Z64_LOC = 0x07064b50, SIG_Z64_EOCD = 0x06064b50;
const U32 = 0xffffffff;
const NAME = new TextDecoder('utf-8', { fatal: true });
const view = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
const big = (dv, at) => {
  const n = Number(dv.getBigUint64(at, true));
  if (!Number.isSafeInteger(n)) throw new MtabError('zip64 value out of range');
  return n;
};

export function checkEntryName(name) {
  if (name === '' || name.startsWith('/') || name.includes('\\') || /[\u0000-\u001f]/.test(name))
    throw new MtabError(`bad entry name: ${JSON.stringify(name)}`);
  const parts = name.replace(/\/$/, '').split('/');
  if (parts.some((p) => p === '' || p === '..' || p === '.'))
    throw new MtabError(`bad entry name: ${JSON.stringify(name)}`);
}

/**
 * Parses the central directory of the archive in `source`. Reads the end of the archive, the directory, and 30 bytes at
 * each entry's local header, and nothing else. Returns [{name, method, crc, csize, usize, offset, dataStart, localExtra}].
 */
export async function readDirectory(source, limits = LIMITS) {
  const size = source.size;
  if (size < 22) throw new MtabError('not a zip archive (too small)');
  const tailLen = Math.min(size, 22 + 65535 + 20);
  const tail = await readExact(source, size - tailLen, size);
  const tv = view(tail);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  if (eocd < 0) throw new MtabError('not a zip archive (no end of central directory)');
  let count = tv.getUint16(eocd + 10, true);
  let cdSize = tv.getUint32(eocd + 12, true);
  let cdOff = tv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === U32 || cdOff === U32) {
    const loc = eocd - 20;
    if (loc < 0 || tv.getUint32(loc, true) !== SIG_Z64_LOC) throw new MtabError('missing zip64 locator');
    const z = big(tv, loc + 8);
    if (z + 56 > size) throw new MtabError('bad zip64 end record');
    const zb = await readExact(source, z, z + 56);
    const zv = view(zb);
    if (zv.getUint32(0, true) !== SIG_Z64_EOCD) throw new MtabError('bad zip64 end record');
    count = big(zv, 32);
    cdSize = big(zv, 40);
    cdOff = big(zv, 48);
  }
  if (count > limits.maxEntries) throw new MtabError(`too many entries (${count})`);
  if (cdSize > limits.maxDirectory) throw new MtabError('central directory too large');
  if (cdOff + cdSize > size) throw new MtabError('central directory out of range');
  const cd = await readExact(source, cdOff, cdOff + cdSize);
  const dv = view(cd);
  const entries = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cd.length || dv.getUint32(p, true) !== SIG_CEN) throw new MtabError('bad central directory entry');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    let csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    let offset = dv.getUint32(p + 42, true);
    if (p + 46 + nlen + xlen + clen > cd.length) throw new MtabError('bad central directory entry');
    let name;
    try { name = NAME.decode(cd.subarray(p + 46, p + 46 + nlen)); } catch { throw new MtabError('entry name is not UTF-8'); }
    if (flags & 1) throw new MtabError(`encrypted entry: ${name}`);
    if (method !== 0 && method !== 8) throw new MtabError(`unsupported compression method ${method}: ${name}`);
    if (usize === U32 || csize === U32 || offset === U32) {
      let x = p + 46 + nlen; const xend = x + xlen;
      while (x + 4 <= xend) {
        const id = dv.getUint16(x, true), sz = dv.getUint16(x + 2, true);
        if (id === 1) {
          let q = x + 4;
          if (usize === U32) { usize = big(dv, q); q += 8; }
          if (csize === U32) { csize = big(dv, q); q += 8; }
          if (offset === U32) { offset = big(dv, q); }
        }
        x += 4 + sz;
      }
    }
    checkEntryName(name);
    if (offset + 30 > size) throw new MtabError(`bad local header: ${name}`);
    const lh = await readExact(source, offset, offset + 30);
    const lv = view(lh);
    if (lv.getUint32(0, true) !== SIG_LOCAL) throw new MtabError(`bad local header: ${name}`);
    const localExtra = lv.getUint16(28, true);
    const dataStart = offset + 30 + lv.getUint16(26, true) + localExtra;
    if (dataStart + csize > size) throw new MtabError(`entry data out of range: ${name}`);
    entries.push({ name, method, crc, csize, usize, offset, dataStart, localExtra });
    p += 46 + nlen + xlen + clen;
  }
  const seen = new Set();
  for (const e of entries) {
    const k = e.name.toLowerCase();
    if (seen.has(k)) throw new MtabError(`duplicate entry name: ${e.name}`);
    seen.add(k);
  }
  const spans = entries.map((e) => [e.offset, e.dataStart + e.csize, e.name]).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++)
    if (spans[i][0] < spans[i - 1][1]) throw new MtabError(`overlapping entries: ${spans[i - 1][2]}, ${spans[i][2]}`);
  return entries;
}

const capOf = (e, maxSize, limits) => Math.min(maxSize, Math.max(1024, e.csize * limits.maxRatio));

/** The archive byte range of a Stored entry, or null for a compressed one. Nothing is read. */
export function entryRange(e) {
  return e.method === 0 ? { start: e.dataStart, end: e.dataStart + e.csize } : null;
}

async function inflate(raw, cap, name) {
  const ds = new DecompressionStream('deflate-raw');
  const w = ds.writable.getWriter();
  w.write(raw).catch(() => {});
  w.close().catch(() => {});
  const r = ds.readable.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await r.read();
      if (done) break;
      total += value.length;
      if (total > cap) { r.cancel().catch(() => {}); throw new MtabError(`entry exceeds size or ratio limit: ${name}`); }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof MtabError) throw err;
    throw new MtabError(`cannot inflate ${name}: ${err.message}`);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** Reads one entry whole, checks its size and CRC-32. `maxSize` caps the output; deflate output is also capped by the ratio. */
export async function readEntry(source, e, { maxSize = Infinity, limits = LIMITS } = {}) {
  if (e.usize > maxSize) throw new MtabError(`entry too large: ${e.name}`);
  const raw = await readExact(source, e.dataStart, e.dataStart + e.csize);
  let out;
  if (e.method === 0) out = raw.slice();
  else out = await inflate(raw, capOf(e, maxSize, limits), e.name);
  if (out.length !== e.usize) throw new MtabError(`size mismatch: ${e.name}`);
  if (crc32(out) !== e.crc) throw new MtabError(`crc mismatch: ${e.name}`);
  return out;
}

/**
 * Streams one entry in chunks, so a large entry is never held whole. Inflated output is counted as it is produced and the
 * stream errors past the ratio cap; the size and CRC-32 are checked when the stream ends. To play a Stored entry without
 * copying it, use entryRange and read the range from the source instead.
 */
export function entryStream(source, e, { limits = LIMITS } = {}) {
  let pos = e.dataStart;
  const end = e.dataStart + e.csize;
  const raw = new ReadableStream({
    async pull(c) {
      if (pos >= end) { c.close(); return; }
      const next = Math.min(end, pos + CHUNK);
      c.enqueue(await readExact(source, pos, next));
      pos = next;
    },
  });
  const cap = capOf(e, Infinity, limits);
  let total = 0, crc = 0;
  const check = new TransformStream({
    transform(chunk, c) {
      total += chunk.length;
      if (e.method !== 0 && total > cap) throw new MtabError(`entry exceeds size or ratio limit: ${e.name}`);
      crc = crc32(chunk, crc);
      c.enqueue(chunk);
    },
    flush() {
      if (total !== e.usize) throw new MtabError(`size mismatch: ${e.name}`);
      if (crc !== e.crc) throw new MtabError(`crc mismatch: ${e.name}`);
    },
  });
  return (e.method === 0 ? raw : raw.pipeThrough(new DecompressionStream('deflate-raw'))).pipeThrough(check);
}

// ---------------------------------------------------------------------------------------------------------------------
// Writer

async function deflate(data) {
  const cs = new CompressionStream('deflate-raw');
  const w = cs.writable.getWriter();
  w.write(data).catch(() => {});
  w.close().catch(() => {});
  const chunks = [];
  const r = cs.readable.getReader();
  for (let total = 0; ;) {
    const { done, value } = await r.read();
    if (done) break;
    chunks.push(value); total += value.length;
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

const isBytes = (d) => d instanceof Uint8Array;
const dataLength = (d) => (isBytes(d) ? d.length : (d.end ?? d.source.size) - (d.start ?? 0));

async function crcOfRange(source, start, end) {
  let crc = 0;
  for (let at = start; at < end; at += CHUNK) crc = crc32(await readExact(source, at, Math.min(end, at + CHUNK)), crc);
  return crc;
}

/**
 * Plans an archive as a list of parts, without building it in memory.
 * files: [{ name, data, store? }] in the order to write. `data` is a Uint8Array, or `{ source, start?, end? }` for a range
 * of a ByteSource (written Stored; its CRC-32 is computed in one pass over the source, and it is not copied).
 * Returns { parts, size }: each part is a Uint8Array, or `{ source, start, end }` for a range to copy from a source.
 * Uses ZIP64 where the format requires it. `zip64Threshold` exists so tests can force ZIP64 on small data.
 */
export async function zipParts(files, { unchecked = false, zip64Threshold = 0xfffffff0 } = {}) {
  const T = zip64Threshold;
  const parts = [], cens = [];
  let offset = 0;
  const date = (1 << 5) | 1; // 1980-01-01, keeps output reproducible
  const enc = new TextEncoder();
  const push = (p) => { parts.push(p); offset += isBytes(p) ? p.length : p.end - p.start; };
  for (const [index, f] of files.entries()) {
    if (!unchecked) checkEntryName(f.name);
    const name = enc.encode(f.name);
    const usize = dataLength(f.data);
    let crc, method = 0, body, csize = usize, range = null;
    if (isBytes(f.data)) {
      crc = crc32(f.data);
      body = f.data;
      if (!f.store && usize > 0) {
        const d = await deflate(f.data);
        if (d.length < usize) { method = 8; body = d; csize = d.length; }
      }
    } else {
      const start = f.data.start ?? 0;
      range = { source: f.data.source, start, end: start + usize };
      crc = await crcOfRange(range.source, range.start, range.end);
    }
    const sizeBig = usize >= T || csize >= T;
    const offBig = offset >= T;
    const lextra = new Uint8Array(sizeBig ? 20 : 0);
    if (sizeBig) {
      const v = view(lextra);
      v.setUint16(0, 1, true); v.setUint16(2, 16, true); v.setBigUint64(4, BigInt(usize), true); v.setBigUint64(12, BigInt(csize), true);
    }
    const lh = new Uint8Array(30);
    const lv = view(lh);
    lv.setUint32(0, SIG_LOCAL, true); lv.setUint16(4, sizeBig ? 45 : 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, method, true);
    lv.setUint16(10, 0, true); lv.setUint16(12, date, true); lv.setUint32(14, crc, true);
    lv.setUint32(18, sizeBig ? U32 : csize, true); lv.setUint32(22, sizeBig ? U32 : usize, true);
    lv.setUint16(26, name.length, true); lv.setUint16(28, lextra.length, true);
    const cextraLen = (sizeBig ? 16 : 0) + (offBig ? 8 : 0);
    const cextra = new Uint8Array(cextraLen ? 4 + cextraLen : 0);
    if (cextraLen) {
      const v = view(cextra);
      v.setUint16(0, 1, true); v.setUint16(2, cextraLen, true);
      let q = 4;
      if (sizeBig) { v.setBigUint64(q, BigInt(usize), true); q += 8; v.setBigUint64(q, BigInt(csize), true); q += 8; }
      if (offBig) v.setBigUint64(q, BigInt(offset), true);
    }
    const ch = new Uint8Array(46);
    const cv = view(ch);
    cv.setUint32(0, SIG_CEN, true); cv.setUint16(4, 45, true); cv.setUint16(6, sizeBig || offBig ? 45 : 20, true); cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true); cv.setUint16(12, 0, true); cv.setUint16(14, date, true); cv.setUint32(16, crc, true);
    cv.setUint32(20, sizeBig ? U32 : csize, true); cv.setUint32(24, sizeBig ? U32 : usize, true);
    cv.setUint16(28, name.length, true); cv.setUint16(30, cextra.length, true); cv.setUint32(42, offBig ? U32 : offset, true);
    cens.push(ch, name, cextra);
    push(lh); push(name); push(lextra);
    push(range ?? body);
  }
  const cdSize = cens.reduce((n, c) => n + c.length, 0);
  const cd = new Uint8Array(cdSize);
  let at = 0;
  for (const c of cens) { cd.set(c, at); at += c.length; }
  const cdOff = offset;
  const needZ64 = files.length >= 0xffff || cdOff >= T || cdSize >= T;
  push(cd);
  if (needZ64) {
    const z = new Uint8Array(56 + 20);
    const v = view(z);
    v.setUint32(0, SIG_Z64_EOCD, true); v.setBigUint64(4, 44n, true); v.setUint16(12, 45, true); v.setUint16(14, 45, true);
    v.setBigUint64(24, BigInt(files.length), true); v.setBigUint64(32, BigInt(files.length), true);
    v.setBigUint64(40, BigInt(cdSize), true); v.setBigUint64(48, BigInt(cdOff), true);
    v.setUint32(56, SIG_Z64_LOC, true); v.setBigUint64(64, BigInt(offset), true); v.setUint32(72, 1, true);
    push(z);
  }
  const end = new Uint8Array(22);
  const ev = view(end);
  ev.setUint32(0, SIG_EOCD, true);
  ev.setUint16(8, needZ64 ? 0xffff : files.length, true); ev.setUint16(10, needZ64 ? 0xffff : files.length, true);
  ev.setUint32(12, needZ64 ? U32 : cdSize, true); ev.setUint32(16, needZ64 ? U32 : cdOff, true);
  push(end);
  return { parts, size: offset };
}

/** Joins parts into one Uint8Array. For small archives, tests and tools; a large archive is written part by part instead. */
export async function concatParts(parts) {
  const chunks = [];
  for (const p of parts) chunks.push(isBytes(p) ? p : await readExact(p.source, p.start, p.end));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}
