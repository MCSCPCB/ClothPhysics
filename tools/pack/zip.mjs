// A standard, deterministic ZIP (DEFLATE), readable by Bedrock as .mcpack.
import { deflateRawSync } from 'node:zlib';

const table = Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function zip(entries) {
  if (entries.length >= 65535) throw new Error('Too many files for a classic ZIP');
  const local = [], central = [], names = new Set();
  let offset = 0;
  for (const { name, data } of [...entries].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (!name || name.includes('\\') || name.includes(':') || name.includes('\0') || name.split('/').some(s => !s || s === '.' || s === '..'))
      throw new Error(`Invalid archive path: ${name}`);
    if (names.has(name.toLowerCase())) throw new Error(`Duplicate archive path: ${name}`);
    names.add(name.toLowerCase());
    const filename = Buffer.from(name), compressed = deflateRawSync(data, { level: 9 });
    if (filename.length > 65535 || Math.max(data.length, compressed.length, offset) >= 0xffffffff)
      throw new Error('ZIP64 is not supported');
    const crc = crc32(data), header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6); // UTF-8 names
    header.writeUInt16LE(8, 8); // DEFLATE
    header.writeUInt16LE(33, 12); // 1980-01-01, independent of local time
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, compressed);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    header.copy(directory, 8, 6, 30);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, filename);
    offset += header.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  if (offset + directory.length >= 0xffffffff) throw new Error('ZIP64 is not supported');
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
