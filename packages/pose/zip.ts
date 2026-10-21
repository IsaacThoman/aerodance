// Portable ZIPs: deterministic stored exports and bounded stored/deflated imports. Dance Studio
// writes and reads them; the game reads exported songs with them (apps/web/src/songs/customSongs.ts).
const encoder = new TextEncoder(), decoder = new TextDecoder();
const table = Array.from({ length: 256 }, (_, i) => {
  let n = i;
  for (let j = 0; j < 8; j++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc(bytes: Uint8Array) {
  let n = 0xffffffff;
  for (const byte of bytes) n = table[(n ^ byte) & 255] ^ (n >>> 8);
  return (n ^ 0xffffffff) >>> 0;
}
export function safePath(name: string): boolean {
  return name.length > 0 && name.length <= 240 && !/[\\\0:]/.test(name) &&
    name.split("/").every(p => p && p !== "." && p !== "..");
}
function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}
export function makeZip(files: ReadonlyMap<string, Uint8Array>): Uint8Array<ArrayBuffer> {
  if (files.size > 500) throw Error("Too many archive entries");
  const local: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    if (!safePath(name)) throw Error("Unsafe archive path");
    const filename = encoder.encode(name), checksum = crc(data);
    const h = new Uint8Array(30), v = new DataView(h.buffer);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true);
    v.setUint16(6, 0x800, true); v.setUint16(12, 33, true);
    v.setUint32(14, checksum, true); v.setUint32(18, data.length, true);
    v.setUint32(22, data.length, true); v.setUint16(26, filename.length, true);
    local.push(h, filename, data);
    const c = new Uint8Array(46), d = new DataView(c.buffer);
    d.setUint32(0, 0x02014b50, true); d.setUint16(4, 20, true);
    d.setUint16(6, 20, true); d.setUint16(8, 0x800, true); d.setUint16(14, 33, true);
    d.setUint32(16, checksum, true); d.setUint32(20, data.length, true);
    d.setUint32(24, data.length, true); d.setUint16(28, filename.length, true);
    d.setUint32(42, offset, true); central.push(c, filename);
    offset += h.length + filename.length + data.length;
  }
  const directory = concat(central), end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.size, true);
  e.setUint16(10, files.size, true); e.setUint32(12, directory.length, true); e.setUint32(16, offset, true);
  return concat([...local, directory, end]);
}
async function inflate(source: Uint8Array, size: number): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(source)]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader(), parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > size) throw Error("Archive exceeds expanded limit");
      parts.push(value);
    }
    return concat(parts);
  } finally { await reader.cancel().catch(() => {}); }
}
export async function readZip(bytes: Uint8Array, maxBytes = 256 * 1024 * 1024): Promise<Map<string, Uint8Array>> {
  if (bytes.length > maxBytes || bytes.length < 22) throw Error("Invalid/oversized ZIP");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && v.getUint32(end, true) !== 0x06054b50) end--;
  if (end < Math.max(0, bytes.length - 65557)) throw Error("Invalid ZIP");
  if (v.getUint16(end + 4, true) || v.getUint16(end + 6, true)) throw Error("Multi-disk ZIP unsupported");
  const count = v.getUint16(end + 10, true);
  if (count > 500) throw Error("Too many archive entries");
  let cursor = v.getUint32(end + 16, true), total = 0;
  const files = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || v.getUint32(cursor, true) !== 0x02014b50) throw Error("Invalid ZIP directory");
    const method = v.getUint16(cursor + 10, true), compressed = v.getUint32(cursor + 20, true),
      size = v.getUint32(cursor + 24, true), len = v.getUint16(cursor + 28, true),
      extra = v.getUint16(cursor + 30, true), comment = v.getUint16(cursor + 32, true), offset = v.getUint32(cursor + 42, true);
    if (cursor + 46 + len + extra + comment > end) throw Error("Truncated ZIP directory");
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + len));
    // Folder entries (archives zipped by the Finder or Explorer have them) hold no data.
    if (name.endsWith("/") && safePath(name.slice(0, -1)) && !size && !compressed) { cursor += 46 + len + extra + comment; continue; }
    if (!safePath(name) || files.has(name) || ((v.getUint32(cursor + 38, true) >>> 16) & 0xf000) === 0xa000)
      throw Error("Unsafe/duplicate ZIP entry");
    if (v.getUint16(cursor + 8, true) & 1) throw Error("Encrypted ZIP unsupported");
    total += size;
    if (total > maxBytes) throw Error("Archive exceeds expanded limit");
    if (offset + 30 > cursor || v.getUint32(offset, true) !== 0x04034b50) throw Error("Invalid ZIP entry");
    const begin = offset + 30 + v.getUint16(offset + 26, true) + v.getUint16(offset + 28, true);
    if (begin + compressed > cursor) throw Error("Truncated ZIP");
    const source = bytes.subarray(begin, begin + compressed);
    const data = method === 0 ? source : method === 8 ? await inflate(source, size) : null;
    if (!data || data.length !== size || crc(data) !== v.getUint32(cursor + 16, true)) throw Error("Invalid ZIP content/checksum");
    files.set(name, data); cursor += 46 + len + extra + comment;
  }
  return files;
}
