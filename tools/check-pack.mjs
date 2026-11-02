// Verify the shipped ZIP and reversibility of every renamed reference.
// No Minecraft installation or npm dependencies are required.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { readSource, preparePack, packageSource } from './pack.mjs';
import { crc32, zip } from './pack/zip.mjs';
import { encodeBrarchive, decodeBrarchive, optimizePack, expandPack, PACK_OPTIMIZATION_VERSION } from './pack/brarchive.mjs';
import { isResource, transformResource, transformPath, rewriteExpression, validateResources } from './pack/obfuscate.mjs';
import reserved from './export/reserved.mjs';
import { actionsAndStuff } from './actions-and-stuff.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = readSource(path.join(root, 'src'));
const packed = preparePack(source), plain = preparePack(source, { plain: true });
const inverse = Object.fromEntries(Object.entries(packed.maps).map(([kind, map]) => [kind, new Map([...map].map(([a, b]) => [b, a]))]));
for (const [kind, map] of Object.entries(packed.maps)) {
  assert.equal(map.size, inverse[kind].size, `${kind}: bijective names`);
  assert.ok(map.size > 0, `${kind}: names actually collected`);
}
for (const [from, to] of packed.maps.variables) {
  assert.equal(from.length, to.length, 'Molang aliases must not grow');
  assert.ok(!reserved.includes(to) && !actionsAndStuff.externalNames.includes(to), `external variable collision: ${to}`);
}
for (const name of actionsAndStuff.externalNames) assert.ok(!packed.maps.variables.has(name), `external name changed: ${name}`);
assert.ok(!['root', 'waist', 'body', 'head', 'cape'].some(n => packed.maps.bones.has(n)));
for (const file of source) {
  const exported = packed.entries.find(e => e.name === transformPath(file.name, packed.maps));
  const unrenamed = plain.entries.find(e => e.name === file.name);
  assert.ok(exported && unrenamed, `missing file ${file.name}`);
  if (file.name.endsWith('.json')) {
    const original = JSON.parse(file.data), json = JSON.parse(exported.data);
    // Byte-for-byte expressions after inverse renaming prove numbers, operator
    // order, query arguments and every public entry point were preserved.
    assert.deepEqual(isResource(file.name) ? transformResource(json, inverse) : json, original, file.name);
    assert.deepEqual(JSON.parse(unrenamed.data), original, `plain ${file.name}`);
  } else {
    assert.deepEqual(exported.data, file.data, `binary/text asset ${file.name}`);
    assert.deepEqual(unrenamed.data, file.data);
  }
}
assert.deepEqual(packed.entries, preparePack(source).entries, 'default seed is deterministic');
assert.notDeepEqual(packed.entries, preparePack(source, { seed: 'another-release' }).entries);
const expressions = { variables: new Map([['v.a', 'v.z'], ['t.a', 't.x']]), bones: new Map([['cloth_0_0', 'abcdef']]) };
assert.equal(rewriteExpression("v.a+variable.a+t.a+temp.a+v.aa+q.is_name_any('v.a','cloth_0_0')+q.bone_orientation_trs('cloth_0_0').t.x", expressions),
  "v.z+variable.z+t.x+temp.x+v.aa+q.is_name_any('v.a','cloth_0_0')+q.bone_orientation_trs('abcdef').t.x");
console.log('Both profiles: complete reversible renaming, public interfaces, literals, source assets and expression lengths preserved.');

// Read the central directory independently, and compare it with local headers.
function unzip(data) {
  const end = data.length - 22;
  assert.equal(data.readUInt32LE(end), 0x06054b50);
  const count = data.readUInt16LE(end + 10), offset = data.readUInt32LE(end + 16);
  assert.equal(offset + data.readUInt32LE(end + 12), end);
  let at = offset, localEnd = 0;
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(data.readUInt32LE(at), 0x02014b50);
    assert.equal(data.readUInt16LE(at + 10), 8);
    assert.equal(data.readUInt16LE(at + 8), 0x800);
    const size = data.readUInt32LE(at + 20), expected = data.readUInt32LE(at + 24);
    const length = data.readUInt16LE(at + 28), local = data.readUInt32LE(at + 42);
    const name = data.subarray(at + 46, at + 46 + length).toString('utf8');
    assert.equal(local, localEnd);
    assert.equal(data.readUInt32LE(local), 0x04034b50);
    assert.deepEqual(data.subarray(local + 6, local + 30), data.subarray(at + 8, at + 32));
    assert.equal(data.subarray(local + 30, local + 30 + length).toString('utf8'), name);
    localEnd = local + 30 + length + size;
    const inflated = inflateRawSync(data.subarray(local + 30 + length, localEnd));
    assert.equal(inflated.length, expected);
    assert.equal(crc32(inflated), data.readUInt32LE(at + 16));
    assert.ok(!entries.has(name));
    entries.set(name, inflated);
    at += 46 + length;
  }
  assert.equal(localEnd, offset);
  assert.equal(at, end);
  return entries;
}
assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926, 'standard CRC-32 check vector');
const optimized = optimizePack(packed.entries), archive = zip(optimized), extracted = unzip(archive);
assert.equal(extracted.size, optimized.length);
for (const file of optimized) assert.deepEqual(extracted.get(file.name), file.data);
assert.deepEqual(zip([...optimized].reverse()), archive, 'ZIP order and timestamps are reproducible');
assert.ok(extracted.has('manifest.json') && extracted.has('pack_icon.png') && extracted.has('README.md'));
assert.ok(![...extracted.keys()].some(name => name.startsWith('src/') || name.startsWith('_sample/') || name.endsWith('.map')));
assert.ok(extracted.has('__brarchive/animations.brarchive'));
assert.ok(extracted.has('subpacks/actions_and_stuff_1_13/__brarchive/models/entity.brarchive'));
assert.ok(extracted.has('subpacks/default/__brarchive/texts.brarchive'));
assert.equal(decodeBrarchive(extracted.get('__brarchive/models.brarchive')).length, 0, 'index the parent of models/entity');
assert.ok(!optimized.some(e => isResource(e.name)), 'runtime resources live in brarchives');
const virtual = new Map(expandPack([...extracted].map(([name, data]) => ({ name, data }))).map(e => [e.name, e.data]));
assert.equal(virtual.size, source.length);
for (const file of packed.entries) {
  if (file.name === 'manifest.json') {
    const manifest = JSON.parse(virtual.get(file.name));
    assert.equal(manifest.header.pack_optimization_version, PACK_OPTIMIZATION_VERSION);
    delete manifest.header.pack_optimization_version;
    const expected = JSON.parse(file.data);
    delete expected.header.pack_optimization_version;
    assert.deepEqual(manifest, expected);
  } else assert.deepEqual(virtual.get(file.name), file.data, `virtual file ${file.name}`);
}
const textIndex = decodeBrarchive(extracted.get('__brarchive/texts.brarchive'));
assert.equal(textIndex.find(e => e.name === 'zh_CN.lang').data.length, 0, 'language text uses a loose-file placeholder');
assert.deepEqual(textIndex.find(e => e.name === 'languages.json').data, extracted.get('texts/languages.json'));
for (const name of ['en_US.lang', 'zh_CN.lang']) assert.deepEqual(extracted.get('texts/' + name), virtual.get('texts/' + name));

// Empty/loose entries after stored data MUST have offset zero, as in vanilla.
const fixture = encodeBrarchive([{ name: 'a.json', data: Buffer.from('{}') }, { name: 'z.lang', data: Buffer.alloc(0) }]);
assert.equal(fixture.readUInt32LE(16 + 256 + 248), 0);
assert.equal(decodeBrarchive(fixture)[1].data.length, 0);
const unicode = [{ name: '中文.json', data: Buffer.from('{"披风":true}') }];
assert.deepEqual(decodeBrarchive(encodeBrarchive(unicode)), unicode);
const unsorted = [{ name: 'z.json', data: Buffer.from('{}') }, { name: 'a.lang', data: Buffer.alloc(0) }];
assert.deepEqual(decodeBrarchive(encodeBrarchive(unsorted, { preserveOrder: true })), unsorted, 'A&S insertion-order tables');
assert.throws(() => encodeBrarchive([{ name: '中'.repeat(83), data: Buffer.alloc(0) }]), /Invalid brarchive filename/);
assert.throws(() => decodeBrarchive(fixture.subarray(0, 20)), /Truncated/);
assert.throws(() => decodeBrarchive(fixture.subarray(0, fixture.length - 1)), /offset\/size/);
const badVersion = Buffer.from(fixture); badVersion.writeUInt32LE(2, 12);
assert.throws(() => decodeBrarchive(badVersion), /Unsupported brarchive version/);
const badOffset = Buffer.from(fixture); badOffset.writeUInt32LE(1, 16 + 248);
assert.throws(() => decodeBrarchive(badOffset), /offset\/size/);
assert.throws(() => optimizePack(optimized), /existing brarchive/);
assert.equal(unzip(zip([{ name: 'texts/中文.lang', data: Buffer.from('披风') }])).get('texts/中文.lang').toString(), '披风');
assert.throws(() => zip([{ name: '../bad', data: Buffer.alloc(0) }]), /Invalid archive path/);
assert.throws(() => zip([{ name: 'a', data: Buffer.alloc(0) }, { name: 'A', data: Buffer.alloc(0) }]), /Duplicate archive path/);

const resources = [...virtual].filter(([name]) => isResource(name)).map(([name, data]) => ({ name, json: JSON.parse(data) }));
const manifest = JSON.parse(extracted.get('manifest.json'));
validateResources(resources, manifest);
const brokenBones = structuredClone(resources);
brokenBones.find(e => e.json['minecraft:geometry']).json['minecraft:geometry'][0].bones[1].parent = 'missing_bone';
assert.throws(() => validateResources(brokenBones, manifest), /missing bone/);
const brokenOverride = structuredClone(resources);
brokenOverride.find(e => e.name.startsWith('subpacks/') && e.json.animations).name = 'subpacks/actions_and_stuff_1_13/animations/different.json';
assert.throws(() => validateResources(brokenOverride, manifest), /duplicate resource/);
const brokenLength = structuredClone(resources);
brokenLength.find(e => e.json.animations).json.animations['animation.player.cape'].anim_time_update = 'v.a=0;'.repeat(11000);
assert.throws(() => validateResources(brokenLength, manifest), /exceeds 61500/);
console.log('ZIP/brarchive: headers, UTF-8, CRCs, virtual files, language fallbacks, empty directories and subpack overrides checked.');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'clothphysics-pack-'));
try {
  const output = path.join(temporary, 'release.mcpack');
  const cli = spawnSync(process.execPath, [path.join(root, 'tools/pack.mjs'), '--output', output], { cwd: temporary, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(fs.readFileSync(output), archive, 'CLI works outside repository working directory');
  packageSource({ output });
  assert.deepEqual(fs.readFileSync(output), archive, 'existing release can be replaced');
  const debugOutput = path.join(temporary, 'debug.mcpack');
  packageSource({ output: debugOutput, plain: true, loose: true });
  const debugFiles = unzip(fs.readFileSync(debugOutput));
  assert.ok(debugFiles.has('animations/cloth_cape.animation.json'));
  assert.ok(!JSON.parse(debugFiles.get('manifest.json')).header.pack_optimization_version);
  assert.ok(![...debugFiles.keys()].some(n => n.endsWith('.brarchive')));
  const invalidSource = path.join(temporary, 'broken');
  fs.mkdirSync(invalidSource);
  fs.writeFileSync(path.join(invalidSource, 'manifest.json'), '{bad');
  assert.throws(() => packageSource({ sourceDir: invalidSource, output }), /invalid JSON/);
  assert.deepEqual(fs.readFileSync(output), archive, 'a failed build preserves the previous release');
  assert.throws(() => packageSource({ output: path.join(root, 'src', 'invalid.mcpack') }), /outside src/);
  assert.deepEqual(readSource(path.join(root, 'src')), source, 'packaging never modifies src');
} finally {
  // Delete only the resolved, uniquely created test directory inside the OS temp directory.
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('clothphysics-pack-'));
  fs.rmSync(temporary, { recursive: true, force: true });
}
console.log(`CLI and failure recovery passed. ${extracted.size} files, ${archive.length} bytes; src unchanged.`);
