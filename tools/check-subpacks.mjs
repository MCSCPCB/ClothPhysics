// Check the actual selectable pack contents, not only the generated expressions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as standard from './cloth.mjs';
import * as actions from './cloth.mjs?profile=actions_and_stuff_1_13';
import { exportPack } from './export-pack.mjs';

const root = new URL('../src/', import.meta.url);
const read = file => JSON.parse(fs.readFileSync(new URL(file, root), 'utf8'));
const manifest = read('manifest.json');
const profiles = [standard, actions];
assert.equal(manifest.subpacks.at(-1).folder_name, standard.profile.folder);
assert.deepEqual(new Set(manifest.subpacks.map(p => p.folder_name)), new Set(profiles.map(p => p.profile.folder)));
const resources = [
  ['animations/cloth_cape.animation.json', 'animation'],
  ['models/entity/cloth_cape.geo.json', 'geometry'],
  ['render_controllers/cloth_cape.render_controllers.json', 'render'],
];
for (const [file] of resources)
  assert.ok(!fs.existsSync(new URL('subpacks/default/' + file, root)), `obsolete split resource: ${file}`);
assert.ok(fs.existsSync(new URL('subpacks/default/texts/languages.json', root)), 'default subpack remains selectable');
for (const cloth of profiles) {
  const folder = cloth.profile.folder === 'default' ? '' : `subpacks/${cloth.profile.folder}/`, expected = exportPack(cloth);
  for (const [file, key] of resources) assert.deepEqual(read(folder + file), expected[key], folder + file);
  const animation = read(folder + resources[0][0]).animations;
  const entries = [cloth.profile.animation, ...(cloth.profile.additionalAnimations ?? [])];
  assert.deepEqual(Object.keys(animation), entries);
  assert.ok(animation['animation.player.cape'], 'each selection must keep the native cape entry');
  for (const id of entries) assert.deepEqual(animation[id], animation[cloth.profile.animation], `mismatched entry ${id}`);
  const geometry = read(folder + resources[1][0])['minecraft:geometry'];
  assert.equal(geometry.length, 1);
  assert.equal(geometry[0].description.identifier, 'geometry.cape');
  const names = new Set(geometry[0].bones.map(b => b.name));
  for (const name of Object.keys(animation[cloth.profile.animation].bones)) assert.ok(names.has(name), `missing animated bone ${name}`);
  const controller = read(folder + resources[2][0]).render_controllers['controller.render.player.cape'];
  const visible = new Set(controller.part_visibility.flatMap(part => Object.keys(part)));
  for (const name of visible) assert.ok(names.has(name), `missing visible bone ${name}`);
  for (const bone of geometry[0].bones.filter(b => b.cubes?.length)) assert.ok(visible.has(bone.name), `uncontrolled tile ${bone.name}`);
  console.log(`${cloth.profile.folder}: complete animation/model/renderer, all bones matched, no obsolete default-subpack copies`);
}
