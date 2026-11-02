import { createHash } from 'node:crypto';
import reserved from '../export/reserved.mjs';
import { actionsAndStuff } from '../actions-and-stuff.mjs';

export const basePath = name => name.replace(/^subpacks\/[^/]+\//, '');
export const isResource = name => /^(animations\/|models\/entity\/|render_controllers\/).+\.json$/i.test(basePath(name));
const variables = /'[^']*'|(?<![\w.])(v|variable|t|temp)\.([a-z_]\w*)/gi;
const scope = name => /^(v|variable)$/i.test(name) ? 'v' : 't';

function visitStrings(value, fn) {
  if (typeof value === 'string') fn(value);
  else if (value && typeof value === 'object') Object.values(value).forEach(item => visitStrings(item, fn));
}

// Same-length variable aliases keep the already compacted solver under its
// 61,500-character budget. Hashes make the build reproducible for a given seed.
function allocator(seed, kind, occupied) {
  let counter = 0;
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const rest = kind === 'v' || kind === 't' ? letters + '0123456789' : letters;
  return length => {
    for (let attempt = 0; attempt < 10000; attempt++) {
      let name = '';
      while (name.length < length) {
        const bytes = createHash('sha256').update(`${seed}\0${kind}\0${counter++}`).digest();
        for (const byte of bytes) {
          const alphabet = name.length ? rest : letters;
          name += alphabet[byte % alphabet.length];
          if (name.length === length) break;
        }
      }
      name = name.slice(0, length);
      if (!occupied.has(name)) { occupied.add(name); return name; }
    }
    // A short namespace can be nearly full. Finish deterministically instead
    // of depending on random retries finding its last available name.
    if (length <= 3) for (let index = 0; index < 26 * rest.length ** (length - 1); index++) {
      let n = index, name = letters[n % 26];
      n = Math.floor(n / 26);
      while (name.length < length) { name += rest[n % rest.length]; n = Math.floor(n / rest.length); }
      if (!occupied.has(name)) { occupied.add(name); return name; }
    }
    throw new Error(`Cannot allocate ${length}-character ${kind} aliases`);
  };
}

export function createMaps(resources, seed) {
  const external = new Set([...reserved, ...actionsAndStuff.externalNames].map(n => n.toLowerCase()));
  const seen = new Set(), assigned = new Set(), boneNames = new Set(), fileNames = new Set();
  for (const { name, json } of resources) {
    fileNames.add(basePath(name));
    for (const geo of json['minecraft:geometry'] ?? [])
      for (const bone of geo.bones ?? []) boneNames.add(bone.name);
    visitStrings(json, text => {
      for (const match of text.matchAll(variables)) {
        if (!match[1]) continue; // Molang string literal
        const key = `${scope(match[1])}.${match[2].toLowerCase()}`;
        seen.add(key);
        if (/^\s*=(?!=)/.test(text.slice(match.index + match[0].length))) assigned.add(key);
      }
    });
  }
  // Only variables written by this pack are private. Read-only engine inputs
  // and A&S variables (even written ones such as v.tsrqrd) keep their names.
  const privateNames = new Set([...seen].filter(n => !external.has(n) && (n.startsWith('t.') || assigned.has(n))));
  const variableMap = new Map();
  for (const prefix of ['v', 't']) {
    const occupied = new Set([...external, ...seen].filter(n => n.startsWith(prefix + '.') && !privateNames.has(n)).map(n => n.slice(2)));
    const allocate = allocator(seed, prefix, occupied);
    for (const name of [...privateNames].filter(n => n.startsWith(prefix + '.')).sort()) variableMap.set(name, `${prefix}.${allocate(name.length - 2)}`);
  }
  const bones = new Map(), allocateBone = allocator(seed, 'bone', new Set(boneNames));
  // root/waist/body and any other shared player bones remain public.
  for (const name of [...boneNames].filter(n => /^cloth_/.test(n)).sort()) bones.set(name, allocateBone(6));
  const files = new Map(), usedFiles = new Set(fileNames), allocateFile = allocator(seed, 'file', new Set());
  for (const name of [...fileNames].sort()) {
    let output;
    do { output = name.slice(0, name.lastIndexOf('/') + 1) + allocateFile(6) + '.json'; } while (usedFiles.has(output));
    usedFiles.add(output);
    files.set(name, output);
  }
  return { variables: variableMap, bones, files };
}

export function rewriteExpression(text, maps) {
  return text.replace(variables, (token, prefix, name) => {
    if (!prefix) return token;
    const replacement = maps.variables.get(`${scope(prefix)}.${name.toLowerCase()}`);
    return replacement ? `${prefix}.${replacement.slice(2)}` : token;
  // Bone query arguments are names, not identifiers in the Molang namespace.
  }).replace(/((?<![\w.])(?:q|query)\.bone_[a-z_]+\(\s*)'([^']+)'/gi,
    (token, prefix, name) => maps.bones.has(name) ? `${prefix}'${maps.bones.get(name)}'` : token);
}

export function transformResource(value, maps) {
  if (typeof value === 'string') return maps.bones.get(value) ?? rewriteExpression(value, maps);
  if (Array.isArray(value)) return value.map(item => transformResource(item, maps));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [maps.bones.get(key) ?? key, transformResource(item, maps)]));
  return value;
}

// Keep root and subpack paths identical after renaming: Bedrock must replace
// the whole animation file when switching to the A&S profile.
export function transformPath(name, maps) {
  const base = basePath(name);
  return name.slice(0, name.length - base.length) + (maps.files.get(base) ?? base);
}

export function validateResources(resources, manifest) {
  const layers = ['', ...(manifest.subpacks ?? []).map(p => `subpacks/${p.folder_name}/`)];
  for (const layer of layers) {
    const effective = new Map();
    for (const prefix of layer ? ['', layer] : [''])
      for (const item of resources) if (item.name.slice(0, item.name.length - basePath(item.name).length) === prefix)
        effective.set(basePath(item.name), item.json);
    const animations = new Map(), geometries = new Map(), renders = new Map();
    for (const json of effective.values()) {
      for (const [collection, entries] of [[animations, Object.entries(json.animations ?? {})],
        [renders, Object.entries(json.render_controllers ?? {})],
        [geometries, (json['minecraft:geometry'] ?? []).map(g => [g.description.identifier, g])]]) {
        for (const [id, value] of entries) {
          if (collection.has(id)) throw new Error(`${layer || 'root'}: duplicate resource ${id}`);
          collection.set(id, value);
        }
      }
      visitStrings(json, text => {
        if (text.length > 61500) throw new Error(`${layer || 'root'}: expression exceeds 61500 characters (${text.length})`);
      });
    }
    const geometry = geometries.get('geometry.cape'), render = renders.get('controller.render.player.cape');
    if (!geometry || !render || !animations.has('animation.player.cape')) throw new Error(`${layer || 'root'}: missing public cape entry`);
    const bones = new Set(geometry.bones.map(b => b.name));
    if (bones.size !== geometry.bones.length) throw new Error(`${layer || 'root'}: duplicate bone names`);
    const requireBone = name => { if (!bones.has(name)) throw new Error(`${layer || 'root'}: missing bone ${name}`); };
    for (const bone of geometry.bones) if (bone.parent) requireBone(bone.parent);
    for (const id of ['animation.player.cape', ...(layer === `subpacks/${actionsAndStuff.folder}/` ? [actionsAndStuff.animation] : [])]) {
      if (!animations.has(id)) throw new Error(`${layer}: missing ${id}`);
      Object.keys(animations.get(id).bones ?? {}).forEach(requireBone);
    }
    const visible = new Set(render.part_visibility.flatMap(part => Object.keys(part)));
    for (const name of visible) if (name !== '*') requireBone(name);
    for (const bone of geometry.bones) if (bone.cubes?.length && !visible.has('*') && !visible.has(bone.name))
      throw new Error(`${layer || 'root'}: missing visibility for ${bone.name}`);
  }
}
