// Structural/trajectory checks for the generated burn expressions. This executes
// the same Molang statement trees as the pack, with independent coordinate math.
import assert from 'node:assert/strict';
import { burnClock, burnCell, burnVar, burnOrders } from './burn.mjs';
import { channels, program, geometry, H, W, ZMID, restX, restY } from './cloth.mjs';
import { set, compileJs, jsReturn, MATH, strict, toMolang, checkMolang } from './molang.mjs';

const axes = ['x', 'y', 'z'], rad = Math.PI / 180;
const add = (a, b) => a.map((x, k) => x + b[k]);
const sub = (a, b) => a.map((x, k) => x - b[k]);
const scale = (a, s) => a.map(x => x * s);
const dot = (a, b) => a.reduce((n, x, k) => n + x * b[k], 0);
const mul = (m, p) => m.map(row => dot(row, p));
// Generated constants retain five decimal places, so allow 0.00001 model pixels.
const close = (a, b, label, eps = 1e-5) => assert.ok(Math.hypot(...sub(a, b)) < eps, `${label}: ${a} != ${b}`);
const tiles = Array.from({ length: 12 }, (_, i) => ({ r: 3 + (i >> 2), c: i % 4 }));
const value = (v, r, c, f, fallback = 0) => v.__opt(burnVar(r, c, f).slice(2)) ?? fallback;
const clock = compileJs(burnClock());
const rawH = [0.98, 0.1, 0.2], rawI = [0.1, 1, 0.1];
const tileFns = tiles.map(({ r, c }) => {
  const f = s => burnVar(r, c, s), m = [restX(c) + W / 2, restY(r) - H / 2, ZMID];
  const nodes = [axes.map((a, k) => [set('t.m' + a, m[k]), set('t.h' + a, rawH[k]), set('t.i' + a, rawI[k])]),
    set(f('z'), 1), burnCell(r, c, H, f('z')),
    ['m', 'h', 'i'].map(n => axes.map(a => set(f('out' + n + a), 't.' + n + a)))];
  checkMolang(toMolang(nodes), `burn ${r},${c}`);
  return { r, c, m, fn: compileJs(nodes) };
});

for (const order of burnOrders) {
  assert.equal(new Set(order.map(x => x.join(','))).size, 12);
  for (let i = 0; i < order.length; i++) {
    const [r, c] = order[i];
    if (r < 5) assert.ok(order.findIndex(([rr, cc]) => rr === r + 1 && cc === c) <= i - 2, 'burn only an exposed edge');
  }
}
assert.equal(geometry()['minecraft:geometry'][0].bones.flatMap(b => b.cubes ?? []).length, 24);

function simulate({ fps = 60, fire = t => t >= 0.5 && t < 7, seconds = 12, start = 0, seed = 11, inspect = () => {} } = {}) {
  const v = strict({ cwbf: 0, cwbe: 0, cwbt: 0, cwbr: 4.2, cwbs: seed, cwbx: 0, cwby: 64, cwbz: 0 });
  let q;
  const events = [], previous = new Map();
  for (let n = 0; n < seconds * fps; n++) {
    const t = n / fps, yaw = t * 137 * rad, tilt = Math.sin(t * 3) * 0.25;
    // World transform includes the model/world z reflection and animated pitch.
    const Y = [[Math.cos(yaw), 0, Math.sin(yaw)], [0, 1, 0], [Math.sin(yaw), 0, -Math.cos(yaw)]];
    const R = [[1, 0, 0], [0, Math.cos(tilt), Math.sin(tilt)], [0, -Math.sin(tilt), Math.cos(tilt)]];
    const G = Y.map(row => axes.map((_, j) => row.reduce((s, x, k) => s + x * R[k][j], 0)));
    G.forEach((row, k) => row.forEach((x, j) => v[`cwg${k}${j}`] = x));
    const body = [t * 9, 24 + Math.sin(t), -t * 2];
    axes.forEach((a, k) => v['cwk' + a] = body[k]);
    q = { life_time: () => start + t, delta_time: () => 1 / fps, is_on_fire: () => +fire(t), position: k => [seed, 65.62, 0][k] };
    clock(v, q, MATH);
    if (v.cwbt > 0 && (v.cwbf || v.cwbr < 4.2)) for (const { r, c, m, fn } of tileFns) {
      const f = s => value(v, r, c, s);
      fn(v, q, MATH);
      const s = f('s'), id = r + ',' + c;
      if (previous.get(id) !== s) events.push({ t, r, c, s });
      previous.set(id, s);
      const out = n => axes.map(a => f('out' + n + a));
      assert.ok(['m', 'h', 'i'].flatMap(out).every(Number.isFinite), 'finite output');
      if (s === 1 || s === 4) for (const side of [-1, 1]) {
        const actual = add(add(out('m'), scale(out('i'), H / 2)), scale(out('h'), side * W / 2));
        const wanted = add(add(m, scale(rawI, H / 2)), scale(rawH, side * W / 2));
        close(actual, wanted, 'attached top corner');
      }
      if (s === 2) {
        const u = f('p') / 0.4;
        const actual = add(body, mul(G, sub(out('m'), [0, 24, 0])));
        const wanted = add(axes.map(a => f('m' + a)), add(scale(axes.map(a => f('d' + a)), 3.5 * u), [0, 3.5 * u, 0]));
        close(actual, wanted, 'world ash position despite turn and movement');
        close(mul(G, out('h')), scale(axes.map(a => f('h' + a)), 1 - u * u), 'world ash horizontal axis');
      }
      inspect({ t, r, c, s, v, out, rawI, f });
    }
  }
  return { v, events };
}

const timing = [];
for (const fps of [30, 60, 144]) {
  let overshoot = 0, undershoot = 1, minAsh = 1, gone = 0;
  const { v, events } = simulate({ fps, inspect: ({ t, s, f, out }) => {
    if (s === 4) {
      const ratio = Math.hypot(...out('i')) / Math.hypot(...rawI);
      overshoot = Math.max(overshoot, ratio);
      if (f('p') > 0.3 * 0.75) undershoot = Math.min(undershoot, ratio);
    }
    if (s === 2) minAsh = Math.min(minAsh, f('z'));
    if (t > 6.8 && t < 7 && s === 3) gone++;
  } });
  const starts = events.filter(e => e.s === 1), ends = events.filter(e => e.s === 4);
  assert.equal(starts.length, 12, 'every tile burns exactly once');
  assert.equal(ends.length, 12, 'every tile restores exactly once');
  assert.ok(starts[0].t >= 1.4 && starts[0].t <= 1.6, 'about one second of anticipation');
  assert.ok(gone > 0 && minAsh < 0.2, 'ash shrinks away before the burnt hold');
  assert.ok(overshoot > 1.1 && overshoot < 1.16 && undershoot < 0.98, 'unfold overshoot and settling');
  assert.ok(Math.max(...ends.map(e => e.t)) + 0.3 < 11.1, 'restored within about four seconds');
  for (const { r, c } of tiles) {
    assert.equal(value(v, r, c, 's'), 0);
    assert.equal(+value(v, r, c, 'show'), 1);
  }
  timing.push({ fps, first: starts[0].t, last: starts.at(-1).t, restored: ends.at(-1).t + 0.3 });
}
for (const item of timing) close([item.first, item.last, item.restored], [timing[1].first, timing[1].last, timing[1].restored], 'FPS-independent timing', 0.1);

// New ignition order, short exposure, and reignition during ash/restoration.
const a = simulate({ start: 0 }), b = simulate({ start: 1.27 });
assert.notDeepEqual(a.events.filter(e => e.s === 1).map(e => [e.r, e.c]), b.events.filter(e => e.s === 1).map(e => [e.r, e.c]));
const short = simulate({ fire: t => t > 0.5 && t < 0.8, seconds: 6 });
assert.equal(short.events.filter(e => e.s === 1).length, 0, 'short fire must not eat a tile');
for (const resume of [1.65, 8.8, 10.5]) {
  const spins = new Map();
  const { v } = simulate({ fire: t => (t > 0.5 && t < (resume < 2 ? 1.6 : 7)) || (t > resume && t < resume + 3), seconds: resume + 8,
    inspect: ({ r, c, s, f }) => {
      const id = r + ',' + c;
      if (s === 2) {
        if (spins.has(id)) assert.equal(f('spin'), spins.get(id), 'reignition must not redirect an airborne ash');
        spins.set(id, f('spin'));
      } else spins.delete(id);
    } });
  for (const { r, c } of tiles) assert.equal(value(v, r, c, 's'), 0, 'repeated fire eventually restores every tile');
}

// Actual complete animation channels: shuffled evaluation order, duplicate passes,
// UI isolation, and no game-only query access from fresh/UI-only instances.
const prog = compileJs(program()), all = channels().map(ch => ({ ...ch, fn: compileJs(ch.nodes, jsReturn(ch.value)) }));
const v = strict({}), s = { t: 0, ui: false, fire: false };
const q = {
  life_time: () => s.t, delta_time: () => 1 / 60, frame_alpha: () => (s.t * 20) % 1,
  position: k => [0.5, 65.62, 0.5][k], body_y_rotation: () => s.t * 67,
  bone_orientation_trs: n => ({ t: { x: n === 'leftleg' ? 1.9 : n === 'rightleg' ? -1.9 : 0, y: n === 'body' ? 24 : 12, z: 0 }, r: { x: 0, y: 0, z: 0 } }),
  get_root_locator_offset: () => 0, has_cape: () => 1, is_in_ui: () => +s.ui, is_spectator: () => 0,
  is_item_name_any: () => 0, is_on_ground: () => 1, is_on_fire: () => +s.fire,
  time_stamp: () => Math.floor(s.t * 20), time_of_day: () => 0.25,
  is_in_water: () => 0, is_in_lava: () => 0, is_in_water_or_rain: () => 0, entity_biome_has_any_tags: () => 0,
  is_local_player: () => 1, distance_from_camera: () => 50, cape_flap_amount: () => 0,
  block_has_any_tag: (x, y, z, ...tags) => +(y < 64 || y > 65) * +tags.includes('minecraft:is_pickaxe_item_destructible'),
  block_has_all_tags: () => 0,
};
for (const ch of all) assert.ok(Number.isFinite(ch.fn(strict({}), q, MATH)), 'fresh channel before update');
for (let frame = 0; frame < 13 * 60; frame++) {
  s.t = frame / 60; s.fire = s.t > 0.5 && s.t < 7;
  prog(v, q, MATH);
  const order = frame % 2 ? [...all].reverse() : all;
  const results = order.map(ch => ch.fn(v, q, MATH));
  assert.ok(results.every(Number.isFinite));
  const cell = {};
  order.forEach((ch, i) => (cell[ch.r + ',' + ch.c] ??= {})[ch.field] = results[i]);
  for (const { r, c } of tiles) if (value(v, r, c, 's') === 2) {
    const f = n => value(v, r, c, n), cl = cell[r + ',' + c];
    const G = axes.map((_, k) => axes.map((_, j) => v[`cwg${k}${j}`]));
    const m = [restX(c) + W / 2 + cl.px, restY(r) - H / 2 + cl.py - 24, ZMID + cl.pz];
    const actual = add(axes.map(a => v['cwk' + a]), mul(G, m)), u = f('p') / 0.4;
    const wanted = add(axes.map(a => f('m' + a)), add(scale(axes.map(a => f('d' + a)), 3.5 * u), [0, 3.5 * u, 0]));
    close(actual, wanted, 'final bone position preserves the detached world frame', 1e-4);
  }
  const before = JSON.stringify({ ...v });
  assert.deepEqual(order.map(ch => ch.fn(v, q, MATH)), results, 'channel order and duplicate pass');
  assert.equal(JSON.stringify({ ...v }), before, 'duplicate pass must not advance timers');
  s.ui = true; prog(v, q, MATH);
  const uiState = JSON.stringify({ ...v });
  for (const ch of order) assert.ok(Number.isFinite(ch.fn(v, q, MATH)));
  assert.equal(JSON.stringify({ ...v }), uiState, 'UI channels must not mutate effect state');
  const world = JSON.parse(before), ui = JSON.parse(uiState);
  delete world.cwon; delete ui.cwon;
  assert.deepEqual(ui, world, 'UI update must not advance physics or burn');
  s.ui = false;
}
assert.equal(tiles.filter(({ r, c }) => value(v, r, c, 's') !== 0).length, 0);
assert.ok(toMolang(program()).length + 9 <= 61500);
console.log('PASS: burn frontier, pinned edges, world-space ashes, overshoot, repeat ignition, UI and channel order');
console.table(timing);
