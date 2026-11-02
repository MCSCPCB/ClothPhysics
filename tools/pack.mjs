// Package the current src/ without regenerating or changing any source files.
// Run: node tools/pack.mjs [--plain] [--loose] [--seed TEXT] [--output FILE.mcpack]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { zip } from './pack/zip.mjs';
import { optimizePack, expandPack, BRARCHIVE_VERSION, PACK_OPTIMIZATION_VERSION } from './pack/brarchive.mjs';
import { isResource, createMaps, transformResource, transformPath, validateResources } from './pack/obfuscate.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

export function readSource(directory) {
  const files = [];
  function walk(relative = '') {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (entry.name.startsWith('.') || /(?:~|\.bak|\.tmp)$/i.test(entry.name)) continue;
      const name = relative + entry.name, full = path.join(directory, name);
      if (entry.isSymbolicLink()) throw new Error(`Source symlinks are not supported: ${name}`);
      if (entry.isDirectory()) walk(name + '/');
      else if (entry.isFile()) files.push({ name, data: fs.readFileSync(full) });
    }
  }
  walk();
  return files;
}

export function preparePack(source, { plain = false, seed } = {}) {
  const jsonFiles = new Map();
  for (const { name, data } of source) if (name.endsWith('.json')) {
    try { jsonFiles.set(name, JSON.parse(data.toString('utf8').replace(/^\uFEFF/, ''))); }
    catch (error) { throw new Error(`${name}: invalid JSON: ${error.message}`); }
  }
  const manifest = jsonFiles.get('manifest.json');
  if (!manifest?.header?.uuid || !manifest.modules?.some(m => m.type === 'resources')) throw new Error('src/manifest.json must describe a resource pack');
  const version = Array.isArray(manifest.header.version) ? manifest.header.version.join('.') : manifest.header.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('Invalid manifest version');
  for (const subpack of manifest.subpacks ?? []) {
    if (!/^[a-zA-Z0-9_-]+$/.test(subpack.folder_name) || !source.some(f => f.name.startsWith(`subpacks/${subpack.folder_name}/`)))
      throw new Error(`Missing or invalid subpack: ${subpack.folder_name}`);
  }
  const resources = [...jsonFiles].filter(([name]) => isResource(name)).map(([name, json]) => ({ name, json }));
  validateResources(resources, manifest);
  const maps = plain ? { variables: new Map(), bones: new Map(), files: new Map() } : createMaps(resources, seed ?? manifest.header.uuid);
  const entries = source.map(({ name, data }) => {
    if (!jsonFiles.has(name)) return { name, data };
    const json = jsonFiles.get(name), resource = isResource(name);
    return { name: resource ? transformPath(name, maps) : name,
      data: Buffer.from(JSON.stringify(resource ? transformResource(json, maps) : json)) };
  });
  validateResources(entries.filter(e => isResource(e.name)).map(e => ({ name: e.name, json: JSON.parse(e.data) })), manifest);
  return { entries, maps, version };
}

export function packageSource({ sourceDir = path.join(root, 'src'), output, plain = false, loose = false, seed } = {}) {
  const source = readSource(sourceDir), prepared = preparePack(source, { plain, seed });
  output = path.resolve(output ?? path.join(root, 'packs', `CapePhysics${plain ? '-plain' : ''}${loose ? '-loose' : ''}.mcpack`));
  if (path.extname(output).toLowerCase() !== '.mcpack') throw new Error('Output must end in .mcpack');
  const relative = path.relative(path.resolve(sourceDir), output);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)))
    throw new Error('Output must be outside src/');
  const entries = loose ? prepared.entries.map(file => {
    if (file.name !== 'manifest.json') return file;
    const manifest = JSON.parse(file.data);
    delete manifest.header.pack_optimization_version;
    return { name: file.name, data: Buffer.from(JSON.stringify(manifest)) };
  }) : optimizePack(prepared.entries);
  const expanded = expandPack(entries), manifest = JSON.parse(expanded.find(e => e.name === 'manifest.json').data);
  validateResources(expanded.filter(e => isResource(e.name)).map(e => ({ name: e.name, json: JSON.parse(e.data) })), manifest);
  const archive = zip(entries);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  // Validate and compress everything before replacing a previous successful build.
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, archive, { flag: 'wx' });
    fs.renameSync(temporary, output);
  } finally { fs.rmSync(temporary, { force: true }); }
  return { output, bytes: archive.length, sourceBytes: source.reduce((sum, f) => sum + f.data.length, 0),
    files: entries.length, archives: entries.filter(e => e.name.endsWith('.brarchive')).length,
    variables: prepared.maps.variables.size, bones: prepared.maps.bones.size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { plain: { type: 'boolean' }, loose: { type: 'boolean' }, seed: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
    if (values.help) console.log(`Usage: node tools/pack.mjs [--plain] [--loose] [--seed TEXT] [--output FILE.mcpack]\nReads src/ directly. Default: packs/CapePhysics.mcpack\nDefault format: brarchive v${BRARCHIVE_VERSION}, pack_optimization_version ${PACK_OPTIMIZATION_VERSION}.\n--plain: keep original names, still use brarchive; writes -plain.mcpack.\n--loose: development ZIP with loose resources; writes -loose.mcpack.\n--seed: repeatable obfuscation seed (default: manifest UUID).\n--output: explicit output path, relative to the current directory.`);
    else {
      const result = packageSource(values);
      console.log(`Created ${result.output}\n${result.files} ZIP entries, ${result.archives} brarchives; ${result.sourceBytes.toLocaleString('en-US')} -> ${result.bytes.toLocaleString('en-US')} bytes\nRenamed ${result.variables} variables and ${result.bones} private bones; public cape entries preserved.`);
    }
  } catch (error) { console.error(`Pack failed: ${error.message}`); process.exitCode = 1; }
}
