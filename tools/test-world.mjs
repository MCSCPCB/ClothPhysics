import { upperBone } from './test-player.mjs';

import assert from 'node:assert/strict';
import { program } from './cloth.mjs';
import { compileJs, MATH, strict } from './molang.mjs';
const update=compileJs(program());
export function playerFixture(fps=60) {
  const s = { time: 100, dt: 1 / fps, water: false, rain: false, roof: true, biome: [], ui: false, noEntity: false };
  const v = strict({}), bones = {
    body: { t: { x: 0, y: 24, z: 0 }, r: { x: 0, y: 0, z: 0 } },
    rightleg: { t: { x: -1.9, y: 12, z: 0 }, r: { x: 0, y: 0, z: 0 } },
    leftleg: { t: { x: 1.9, y: 12, z: 0 }, r: { x: 0, y: 0, z: 0 } },
  };
  s.bones = bones;
  const tagsAt = y => s.water && y >= 64 && y < 67 ? ['water'] :
    y < 64 || (s.roof && y >= 66) ? ['minecraft:is_pickaxe_item_destructible'] : [];
  const actor = {
    anim_time: () => s.animTime ?? Math.min(s.time,.5), life_time: () => s.time, delta_time: () => s.dt, frame_alpha: () => (s.time * 20) % 1,
    position: k => [.5, 65.62, .5][k], body_y_rotation: () => 0, is_riding: () => 0,
    bone_orientation_trs: name => { assert.ok(!s.missingBones, "bone query during reload"); return s.bones[name] ?? upperBone(name); }, get_root_locator_offset: () => 0, has_armor_slot: () => 0,
    has_cape: () => 1, is_in_ui: () => +s.ui, is_spectator: () => 0, is_item_name_any: () => 0,
    is_on_ground: () => 1, is_on_fire: () => 0, time_stamp: () => Math.floor(s.time * 20),
    is_in_water: () => +s.water, is_in_contact_with_water: () => +s.water, is_in_lava: () => 0,
    is_in_water_or_rain: () => +(s.water || (s.rain && !s.roof)),
    entity_biome_has_any_tags: (...tags) => +tags.some(tag => s.biome.includes(tag)),
    time_of_day: () => .25, cape_flap_amount: () => 0, is_local_player: () => 1, distance_from_camera: () => 50,
    block_has_any_tag: (x, y, z, ...tags) => +tags.some(tag => tagsAt(y).includes(tag)),
    block_has_all_tags: (x, y, z, ...tags) => +tags.every(tag => tagsAt(y).includes(tag)),
  };
  const q = new Proxy(actor, { get(target, name) {
    assert.ok(name in target, `unmocked query ${name}`);
    if (s.noEntity && !['is_in_ui', 'get_root_locator_offset', 'cape_flap_amount'].includes(name))
      throw new Error(`actorless preview queried ${name}`);
    return target[name];
  } });
  const tick = () => { s.time += s.dt; update(v, q, MATH); };
  const advance = seconds => { for (let i = 0; i < Math.ceil(seconds * fps - 1e-8); i++) tick(); };
  advance(.3); // normal geometry warmup, not included in moisture timings
  return { s, v, q, tick, advance };
}
