// Exercise the generated wind expressions with independent environmental scenarios.
// No renderer or block queries are needed: wind reuses the existing exposure cache.
import assert from 'node:assert/strict';
import * as standard from './cloth.mjs';
import * as actions from './cloth.mjs?profile=actions_and_stuff_1_13';
import { compileJs, MATH, set, strict, toMolang, checkMolang } from './molang.mjs';

const magnitude = v => Math.hypot(v.cwux, v.cwuz);
const close = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

for (const cloth of [standard, actions]) {
  const nodes = cloth.sections().wind;
  checkMolang(toMolang(nodes), 'wind');
  const update = compileJs([
    set('t.sr', 'q.life_time==0'),
    set('t.tk', 't.sr||math.floor(q.life_time*20+0.001)!=v.cwtk'),
    set('v.cwtk', 'math.floor(q.life_time*20+0.001)'),
    nodes,
  ]);
  const defaults = cloth.initDefaults();
  function fixture({ fps = 60, biome = [], rain = false, day = .25, stamp = 0, walls = [], roof = false, water = false } = {}) {
    const s = { time: 0, dt: 1 / fps, biome, rain, day, stamp, water };
    const v = strict({ ...defaults, cwwe: +water });
    walls.forEach(i => v['cwj' + i] = 1);
    v.cwce = +roof;
    const query = {
      life_time: () => s.time, delta_time: () => s.dt,
      time_stamp: () => s.stamp, time_of_day: () => s.day, position: () => 64,
      entity_biome_has_any_tags: (...tags) => +tags.some(tag => s.biome.includes(tag)),
      is_in_water_or_rain: () => +(s.water || s.rain), is_in_water: () => +s.water,
    };
    const q = new Proxy(query, { get(target, name) {
      assert.ok(name in target, `unexpected wind query: ${name}`);
      return target[name];
    } });
    update(v, q, MATH);
    const tick = () => { s.time += s.dt; update(v, q, MATH); };
    const advance = seconds => { for (let f = 0; f < Math.round(seconds * fps); f++) tick(); };
    return { s, v, tick, advance };
  }

  // A calm dawn/dusk must not erase all coastal wind, including weather gusts.
  for (const day of [.25, .75]) for (const biome of [['ocean'], ['beach'], ['river']]) {
    const dry = fixture({ day, biome }), wet = fixture({ day, biome, rain: true });
    dry.advance(2); wet.advance(2);
    assert.ok(magnitude(dry.v) > .15, 'coastal background survives sunrise/sunset');
    assert.ok(magnitude(wet.v) > magnitude(dry.v) * 2, 'rain wind survives sunrise/sunset');
  }
  const noon = fixture({ biome: ['beach'], day: .5 }), midnight = fixture({ biome: ['beach'], day: 0 });
  assert.ok(noon.v.cwuz > 0 && midnight.v.cwuz < 0, 'daylight breeze changes direction');
  assert.ok(noon.v.cwux > 0 && midnight.v.cwux > 0, 'background is retained in both directions');

  // A passage can enhance an aligned flow, but cannot turn perpendicular flow into a draft.
  const open = fixture(), aligned = fixture({ walls: [1, 3] }), across = fixture({ walls: [0, 2] });
  assert.ok(magnitude(aligned.v) > magnitude(open.v));
  assert.ok(magnitude(aligned.v) <= 1.7 * magnitude(open.v) + 1e-9);
  close(magnitude(across.v), 0);
  for (const stamp of [0, 1, 999999]) {
    const a = fixture({ stamp }), passage = fixture({ stamp, walls: [0, 2] });
    assert.ok(magnitude(passage.v) <= 1.7 * Math.abs(a.v.cwuz) + 1e-9, 'only along-passage wind is amplified');
  }
  for (const options of [{ water: true }, { walls: [0, 1, 2, 3], roof: true }]) {
    const f = fixture(options); f.advance(2);
    close(magnitude(f.v), 0);
  }
  const cold = fixture({ biome: ['frozen'] }), rainy = fixture({ rain: true });
  cold.advance(2); rainy.advance(2);
  close(magnitude(cold.v), magnitude(rainy.v));

  // Fixed-target smoothing must have the same response over one second at every FPS.
  const responses = [20, 30, 60, 144].map(fps => {
    const f = fixture({ fps }); f.v.cwnx = f.v.cwnz = 0;
    f.advance(1);
    return f.v.cwnx / f.v.cwux;
  });
  for (const response of responses) close(response, 1 - Math.exp(-2));

  // Cross a biome boundary and back. Compare the continuous target and frame response,
  // not just the stored biome flags, including crossing into the stronger desert wind.
  const transitions = [];
  for (const fps of [20, 30, 60, 144]) {
    const f = fixture({ fps, day: .5 }); f.advance(2);
    const start = [f.v.cwux, f.v.cwuz];
    f.s.biome = ['beach'];
    const samples = [];
    for (let frame = 0; frame < fps; frame++) {
      f.tick();
      samples.push([f.v.cwux, f.v.cwuz]);
    }
    const goal = fixture({ biome: ['beach'], day: .5 });
    const delta = Math.hypot(goal.v.cwux - start[0], goal.v.cwuz - start[1]);
    let previous = start, largest = 0;
    for (const sample of samples) {
      largest = Math.max(largest, Math.hypot(sample[0] - previous[0], sample[1] - previous[1]));
      previous = sample;
    }
    assert.ok(largest < delta * .2, 'boundary crossing must not instantly switch target');
    transitions.push([f.v.cwnx, f.v.cwnz]);
    f.advance(4);
    assert.ok(Math.hypot(f.v.cwux - goal.v.cwux, f.v.cwuz - goal.v.cwuz) < .001);
    f.s.biome = ['desert']; f.advance(5);
    const desert = fixture({ biome: ['desert'], day: .5 });
    assert.ok(Math.hypot(f.v.cwux - desert.v.cwux, f.v.cwuz - desert.v.cwuz) < .001);
  }
  for (const response of transitions) assert.ok(Math.hypot(response[0] - transitions[0][0], response[1] - transitions[0][1]) < .02, 'biome blending is consistent across FPS');
  console.log(`${cloth.profile.folder}: dawn/dusk weather, corridor projection, shelter/water, cold biome and 20/30/60/144 FPS transitions passed`);
}
