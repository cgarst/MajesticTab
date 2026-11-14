// A ByteSource is the one thing the core needs from the outside world to read an archive:
//   { size: number, read(start, end): Promise<Uint8Array> }
// `read` returns the bytes in [start, end), clamped to the size. A browser wraps a Blob or File
// (`blob.slice(start, end).arrayBuffer()`), the desktop shell wraps a ranged file read, Node wraps a file handle.

export const bytesSource = (bytes) => ({
  size: bytes.length,
  read: async (start, end) => bytes.subarray(start, Math.min(end, bytes.length)),
});

/** Reads [start, end) and fails if the source returned fewer bytes than asked for. */
export async function readExact(source, start, end) {
  const out = await source.read(start, end);
  if (out.length !== end - start) throw new Error(`short read at ${start}: wanted ${end - start} bytes, got ${out.length}`);
  return out;
}

export const CHUNK = 1 << 20;
