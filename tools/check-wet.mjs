import { upperBone } from './test-player.mjs';
// Wetness timing and isolation through the complete world animation entry point.
// These are offline logic checks, not a substitute for Bedrock's material rendering.
import assert from 'node:assert/strict';
const { program, renderController, wetUpdate, wetTint, profile } = await import(process.env.CLOTH_PROFILE ? `./cloth.mjs?profile=${process.env.CLOTH_PROFILE}` : './cloth.mjs');
import { set, when, loop, cacheConstants, compileJs, jsReturn, MATH, strict, checkMolang } from './molang.mjs';

const update = compileJs(program());
const close = (actual, expected, label, tolerance = 1e-8) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected}`);

// Literal sharing must not rewrite quoted query arguments or part of another number.
const tree = [set('v.a', '0.001+10.001+0.0011'),
  when("q.entity_biome_has_any_tags('0.001','17.06667')", loop('2', set('v.a', 'v.a+0.001')))];
const cached = cacheConstants(tree, ['0.001', '17.06667']);
for (const nodes of [tree, cached]) {
  const v = strict({});
  compileJs(nodes)(v, { entity_biome_has_any_tags: (...tags) => {
    assert.deepEqual(tags, ['0.001', '17.06667']); return 1;
  } }, MATH);
  close(v.a, 10.0051, 'cached literal arithmetic');
}

function simulation(fps) {
  const s = { time: 100, dt: 1 / fps, water: false, rain: false, roof: true, biome: [], ui: false, noEntity: false };
  const v = strict({}), bones = {
    body: { t: { x: 0, y: 24, z: 0 }, r: { x: 0, y: 0, z: 0 } },
    rightleg: { t: { x: -1.9, y: 12, z: 0 }, r: { x: 0, y: 0, z: 0 } },
    leftleg: { t: { x: 1.9, y: 12, z: 0 }, r: { x: 0, y: 0, z: 0 } },
  };
  const tagsAt = y => s.water && y >= 64 && y < 67 ? ['water'] :
    y < 64 || (s.roof && y >= 66) ? ['minecraft:is_pickaxe_item_destructible'] : [];
  const actor = {
    anim_time: () => s.animTime ?? Math.min(s.time,.5), life_time: () => s.time, delta_time: () => s.dt, frame_alpha: () => (s.time * 20) % 1,
    position: k => [.5, 65.62, .5][k], body_y_rotation: () => 0, is_riding: () => 0,
    bone_orientation_trs: name => bones[name] ?? upperBone(name), get_root_locator_offset: () => 0, has_armor_slot: () => 0,
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

for (const fps of [10, 30, 60, 144]) {
  const { s, v, q, tick, advance } = simulation(fps);
  assert.equal(v.cwwet, 0);
  assert.equal(v.cwwet_water, 0);
  s.water = true; advance(.25);
  close(v.cwwet, 1, `water saturates at ${fps} fps`);
  close(v.cwwet_water, 1, `water enables physical wetness at ${fps} fps`);
  const once = { ...v };
  for (let i = 0; i < 4; i++) update(v, q, MATH);
  assert.deepEqual({ ...v }, once, 'duplicate render passes do not advance moisture');
  s.water = false; advance(5);
  close(v.cwwet, .5, `half dry at 5 s / ${fps} fps`);
  close(v.cwwet_water, .5, `half physical wetness after 5 s / ${fps} fps`);
  advance(5); close(v.cwwet, 0, `dry at 10 s / ${fps} fps`);
  close(v.cwwet_water, 0, `normal physics after 10 s / ${fps} fps`);
  s.rain = true; advance(2);
  assert.equal(v.cwwet, 0, 'rain outside a roof does not wet sheltered cloth');
  s.roof = false; advance(1.5);
  close(v.cwwet, 1, 'rain saturates exposed cloth');
  close(v.cwwet_water, 0, 'rain changes tint only');
  s.rain = false;
  for (const biome of ['desert', 'nether']) {
    s.biome = [biome]; v.cwwet = v.cwwet_water = 1;
    advance(2); close(v.cwwet, .4, `${biome} dries faster`);
    close(v.cwwet_water, .4, `${biome} restores physics faster`);
    advance(4 / 3); close(v.cwwet, 0, `${biome} fully dry by 3.34 s`);
    close(v.cwwet_water, 0, `${biome} restores normal physics by 3.34 s`);
  }
  s.biome = ['cold', 'frozen']; advance(2);
  assert.equal(v.cwwet, 0, 'cold-biome wind alone does not wet the cape');
  s.rain = true; tick();
  close(v.cwwet, .7 / fps, 'actual rain wets in cold biomes too');
  close(v.cwwet_water, 0, 'cold-biome precipitation never adds physical wetness');
  for (const paperdoll of [false, true]) {
    s.ui = !paperdoll; s.noEntity = true; v.is_paperdoll = +paperdoll;
    const moisture = v.cwwet, physical = v.cwwet_water;
    tick(); assert.equal(v.cwwet, moisture, 'preview leaves moisture untouched');
    assert.equal(v.cwwet_water, physical, 'preview leaves physical wetness untouched');
    update(strict({ is_paperdoll: +paperdoll }), q, MATH);
    s.ui = false; s.noEntity = false; v.is_paperdoll = 0;
  }
  console.log(`${profile.folder}: wet/dry timing, rain isolation and UI guards: ${fps} fps passed`);
}

// Drying alone must not defeat sleep in a sheltered, motionless scene.
{
  const { v, advance } = simulation(60);
  advance(4);
  assert.ok(v.cwqt >= 30, 'dry cloth has settled');
  v.cwwet = v.cwwet_water = 1;
  const stamp = v.cwst;
  advance(5);
  close(v.cwwet, .5, 'moisture clock still runs while asleep');
  close(v.cwwet_water, .5, 'physical moisture clock still runs while asleep');
  assert.equal(v.cwst, stamp, 'still-air drying does not restart the solver');
}

// A cosmetic pass can evaluate this before the animation has initialised anything.
const alpha = renderController().render_controllers['controller.render.player.cape'].overlay_color.a;
checkMolang(alpha, 'wet tint alpha');
const tint = compileJs([], jsReturn(wetTint));
for (const [state, ui, expected] of [
  [{}, false, 0], [{}, true, 0], [{ cwwet: 0 }, false, 0],
  [{ cwwet: .5 }, false, .225], [{ cwwet: 1 }, false, .45],
  [{ cwwet: 1 }, true, 0], [{ cwwet: 1, is_paperdoll: 1 }, false, 0],
]) close(tint(strict(state), { is_in_ui: () => +ui }, MATH), expected, 'wet tint / preview');
console.log('wet sleep and tint guards: passed');

const renderWet = compileJs([wetUpdate()], jsReturn(wetTint));
{
 const {s,v,q,advance} = simulation(60);
 v.is_first_person=1;s.water=true;
 for(let f=0;f<60;f++){s.time+=s.dt;renderWet(v,q,MATH);renderWet(v,q,MATH);}
 close(v.cwwet,1,'render entry wets hidden first-person cape');
 close(v.cwwet_water,1,'render entry retains water-soaked physics in first person');
 s.water=false;
 for(let f=0;f<300;f++){s.time+=s.dt;renderWet(v,q,MATH);}
 close(v.cwwet,.5,'render entry dries without any cape animation calls');
 close(v.cwwet_water,.5,'physical moisture dries without animation calls');
 const before=v.cwwet;update(v,q,MATH);close(v.cwwet,before,'animation and renderer share one moisture stamp');
 v.is_first_person=0;advance(.2);assert.ok(v.cwwet>.45,'switching view retains stored wetness');
 const fresh=strict({});s.water=true;s.time+=s.dt;renderWet(fresh,q,MATH);
 const first=fresh.cwwet;update(fresh,q,MATH);close(fresh.cwwet,first,'animation init preserves earlier render wetness');
 close(fresh.cwwet_water,first,'animation init preserves earlier render physical wetness');
}
console.log('first-person render entry, shared timestamp and render-before-animation: passed');

// Rain after a swim must not replenish or hold the physical wetness clock.
{
 const {s,v,q} = simulation(60);
 s.roof=false;s.water=true;
 for(let i=0;i<15;i++){s.time+=s.dt;renderWet(v,q,MATH);}
 close(v.cwwet_water,1,'brief swim saturates physical wetness');
 s.water=false;s.rain=true;
 for(let i=0;i<300;i++){s.time+=s.dt;renderWet(v,q,MATH);}
 close(v.cwwet,1,'rain keeps the wet appearance');
 close(v.cwwet_water,.5,'physical response continues drying during rain');
 for(let i=0;i<300;i++){s.time+=s.dt;renderWet(v,q,MATH);}
 close(v.cwwet_water,0,'physics fully recovers even in continuous rain');
}

// Cold biomes already share the same wind with or without detected precipitation.
// Compare actual particle trajectories, isolating wet tint from the weather wind.
{
 const dry=simulation(60),rain=simulation(60);
 for(const f of [dry,rain]){f.s.biome=['cold','frozen'];f.s.roof=false;}
 rain.s.rain=true;
 for(let i=0;i<120;i++){
  dry.tick();rain.tick();
  for(const key of Object.keys(dry.v).filter(k=>/^c[pq][0-9a-z][xyz]$/.test(k)))
   assert.equal(rain.v[key],dry.v[key],`precipitation tint must not affect particle ${key}`);
 }
 close(rain.v.cwwet,1,'precipitation darkens the cape');
 close(dry.v.cwwet,0,'control cape stays dry');
 close(rain.v.cwwet_water,0,'precipitation leaves physical wetness zero');
}
console.log(`${profile.folder}: physical recovery in rain and identical rain/dry particle trajectories under equal wind passed`);
