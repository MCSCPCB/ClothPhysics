// Format observed in Windows Bedrock 1.26.6005.0 and Preview 1.26.7022.0.
// See brarchive.md for the verified binary layout and reference-pack evidence.
import path from 'node:path';

export const BRARCHIVE_VERSION = 1;
export const PACK_OPTIMIZATION_VERSION = '0.1.0';
const MAGIC = Buffer.from('7d2725b1a0527026', 'hex');
const HEADER_SIZE = 16, ENTRY_SIZE = 256, NAME_LIMIT = 247;
const compare = (a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name));
const validName = name => typeof name === 'string' && name.length && !/[\\/:\0]/.test(name) && name !== '.' && name !== '..';

export function encodeBrarchive(entries, { preserveOrder = false } = {}) {
  // Vanilla sorts names. Some marketplace archives retain insertion order;
  // preserve it only when reproducing a reference archive for verification.
  const sorted = preserveOrder ? [...entries] : [...entries].sort(compare), names = new Set();
  const table = Buffer.alloc(HEADER_SIZE + ENTRY_SIZE * sorted.length), payloads = [];
  MAGIC.copy(table);
  table.writeUInt32LE(sorted.length, 8);
  table.writeUInt32LE(BRARCHIVE_VERSION, 12);
  let offset = 0;
  sorted.forEach(({ name, data }, index) => {
    const filename = Buffer.from(name);
    if (!validName(name) || filename.length > NAME_LIMIT) throw new Error(`Invalid brarchive filename: ${name}`);
    if (names.has(name.toLowerCase())) throw new Error(`Duplicate brarchive filename: ${name}`);
    names.add(name.toLowerCase());
    if (!Buffer.isBuffer(data)) throw new Error(`Expected a Buffer for ${name}`);
    if (offset + data.length > 0xffffffff) throw new Error('brarchive payload exceeds 32-bit offsets');
    const at = HEADER_SIZE + index * ENTRY_SIZE;
    table[at] = filename.length;
    filename.copy(table, at + 1);
    // Loose-file placeholders have BOTH fields zero, even after stored data.
    table.writeUInt32LE(data.length ? offset : 0, at + 248);
    table.writeUInt32LE(data.length, at + 252);
    payloads.push(data);
    offset += data.length;
  });
  return Buffer.concat([table, ...payloads]);
}

export function decodeBrarchive(data) {
  if (data.length < HEADER_SIZE || !data.subarray(0, 8).equals(MAGIC)) throw new Error('Invalid brarchive magic/header');
  const count = data.readUInt32LE(8), version = data.readUInt32LE(12);
  if (version !== BRARCHIVE_VERSION) throw new Error(`Unsupported brarchive version: ${version}`);
  const payloadStart = HEADER_SIZE + count * ENTRY_SIZE;
  if (payloadStart > data.length) throw new Error('Truncated brarchive table');
  const entries = [], names = new Set(), decoder = new TextDecoder('utf-8', { fatal: true });
  let end = 0;
  for (let i = 0; i < count; i++) {
    const at = HEADER_SIZE + i * ENTRY_SIZE, length = data[at];
    if (!length || length > NAME_LIMIT) throw new Error('Invalid brarchive filename length');
    const filename = data.subarray(at + 1, at + 1 + length), name = decoder.decode(filename);
    if (!validName(name) || data.subarray(at + 1 + length, at + 248).some(byte => byte !== 0)) throw new Error('Invalid brarchive name/padding');
    if (names.has(name.toLowerCase())) throw new Error('Duplicate brarchive names');
    names.add(name.toLowerCase());
    const offset = data.readUInt32LE(at + 248), size = data.readUInt32LE(at + 252);
    if ((size ? offset !== end : offset !== 0) || payloadStart + offset + size > data.length) throw new Error('Invalid brarchive offset/size');
    entries.push({ name, data: data.subarray(payloadStart + offset, payloadStart + offset + size) });
    if (size) end += size;
  }
  if (payloadStart + end !== data.length) throw new Error('Unexpected brarchive trailing data');
  return entries;
}

const splitLayer = name => {
  const prefix = /^subpacks\/[^/]+\//.exec(name)?.[0] ?? '';
  return { prefix, local: name.slice(prefix.length) };
};

export function optimizePack(entries) {
  const archives = new Map(), loose = [];
  for (const { name, data } of entries) {
    if (name.split('/').includes('__brarchive') || name.endsWith('.brarchive')) throw new Error('Expected unpacked src; found existing brarchive data');
    const { prefix, local } = splitLayer(name), directory = path.posix.dirname(local);
    if (directory === '.') { loose.push({ name, data }); continue; }
    // Each resource directory has its own index. Also index parents such as
    // models/ even when their only contents are subdirectories.
    for (let parent = directory; parent !== '.'; parent = path.posix.dirname(parent)) {
      const archivePath = `${prefix}__brarchive/${parent}.brarchive`;
      if (!archives.has(archivePath)) archives.set(archivePath, []);
    }
    const stored = local.toLowerCase().endsWith('.json');
    archives.get(`${prefix}__brarchive/${directory}.brarchive`).push({ name: path.posix.basename(local), data: stored ? data : Buffer.alloc(0) });
    // Match vanilla/A&S: language text stays loose; languages.json is both
    // indexed/stored and loose so import/UI language discovery can read it.
    if (!stored || local === 'texts/languages.json') loose.push({ name, data });
  }
  const manifestFile = loose.find(file => file.name === 'manifest.json');
  if (!manifestFile) throw new Error('Missing manifest.json');
  const manifest = JSON.parse(manifestFile.data);
  manifest.header.pack_optimization_version = PACK_OPTIMIZATION_VERSION;
  const output = loose.map(file => file === manifestFile ? { name: file.name, data: Buffer.from(JSON.stringify(manifest)) } : file);
  for (const [name, files] of archives) output.push({ name, data: encodeBrarchive(files) });
  return output;
}

// Reconstruct virtual file paths to check the actual published pack, including
// loose-file fallbacks and identical languages.json copies.
export function expandPack(entries) {
  const result = new Map(entries.filter(e => !e.name.endsWith('.brarchive')).map(e => [e.name, e.data]));
  for (const { name, data } of entries.filter(e => e.name.endsWith('.brarchive'))) {
    const { prefix, local } = splitLayer(name);
    if (!local.startsWith('__brarchive/')) throw new Error(`Invalid brarchive path: ${name}`);
    const directory = local.slice('__brarchive/'.length, -'.brarchive'.length);
    for (const file of decodeBrarchive(data)) {
      const target = `${prefix}${directory}/${file.name}`, existing = result.get(target);
      if (file.data.length === 0 && existing) continue;
      if (existing && !existing.equals(file.data)) throw new Error(`Conflicting archive/loose file: ${target}`);
      result.set(target, file.data);
    }
  }
  return [...result].map(([name, data]) => ({ name, data }));
}
