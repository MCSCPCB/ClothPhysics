import { upperBone } from './test-player.mjs';
// Structural/trajectory checks for the generated burn expressions. This executes
// the same Molang statement trees as the pack, with independent coordinate math.
import assert from 'node:assert/strict';
import { burnClock, burnCell, burnVar, burnOrders, burnDepths, burnProfiles, RESTORE_TILE_TIME, BURN_END } from './burn.mjs';
import { channels, program, geometry, bones, renderController, meshVariants, COLS, ROWS, H, W, ZMID, restX, restY } from './cloth.mjs';
import { set, compileJs, jsReturn, MATH, strict, toMolang, checkMolang, compactNames } from './molang.mjs';

// Regression from Bedrock's actual parser: JavaScript accepts 1??1, but a
// shoulder visibility expression containing it invalidates all nine channels.
for (const expression of ['1??1', '(1??1)>.99?2:0', '(v.x+1)??0', 'v.x+v.y??0', 'q.life_time??0'])
  assert.throws(() => checkMolang(expression, 'invalid fallback'), /direct variable/);
for (const expression of ['v.x??1', '(v.x??1)>.99?2:0', 'return v.x??0;', 'return (v.x??(v.y??0));', 'v.x=(v.y??0)+(v.z??0);'])
  assert.doesNotThrow(() => checkMolang(expression, 'valid fallback'));
for (const [bone, definitions] of Object.entries(bones()))
  for (const [channel, expressions] of Object.entries(definitions))
    expressions.forEach((expression, axis) => checkMolang(String(expression), `${bone}.${channel}[${axis}]`));

const axes = ['x', 'y', 'z'], rad = Math.PI / 180;
const add = (a, b) => a.map((x, k) => x + b[k]);
const sub = (a, b) => a.map((x, k) => x - b[k]);
const scale = (a, s) => a.map(x => x * s);
const dot = (a, b) => a.reduce((n, x, k) => n + x * b[k], 0);
const mul = (m, p) => m.map(row => dot(row, p));
// Generated constants retain five decimal places, so allow 0.00001 model pixels.
const close = (a, b, label, eps = 1e-5) => assert.ok(Math.hypot(...sub(a, b)) < eps, `${label}: ${a} != ${b}`);
const tiles = Array.from({ length: (ROWS-1)*COLS }, (_, i) => ({ r: 1 + Math.floor(i/COLS), c: i % COLS }));
const value = (v, r, c, f, fallback = 0) => v.__opt(burnVar(r, c, f).slice(2)) ?? fallback;
const clock = compileJs(burnClock());
const rawH = [0.98, 0.1, 0.2], rawI = [0.1, 1, 0.1];
const tileFns = tiles.map(({ r, c }) => {
  const f = s => burnVar(r, c, s), m = [restX(c) + W / 2, restY(r) - H(r) / 2, ZMID];
  const nodes = [axes.map((a, k) => [set('t.m' + a, m[k]), set('t.h' + a, rawH[k]), set('t.i' + a, rawI[k])]),
    set(f('z'), 1), burnCell(r, c, H(r), f('z')),
    ['m', 'h', 'i'].map(n => axes.map(a => set(f('out' + n + a), 't.' + n + a)))];
  checkMolang(toMolang(nodes), `burn ${r},${c}`);
  return { r, c, m, fn: compileJs(nodes) };
});

for (const order of burnOrders) {
  assert.equal(new Set(order.map(x => x.r+','+x.c)).size, order.length);
  const depths = Array.from({length:COLS},(_,c)=>order.filter(x=>x.c===c).length);
  assert.equal(Math.min(...depths), 3);
  assert.equal(Math.max(...depths), 4);
  for (const {r,c,due} of order) if(r<ROWS-1) {
    const lower=order.find(x=>x.r===r+1&&x.c===c);
    assert.ok(lower&&lower.due+0.15<due,'burn only an exposed edge');
  }
}
// The baked alternatives preserve texel density; only one per tile is visible.
const geo=geometry()['minecraft:geometry'][0];
for(let r=0;r<ROWS;r++)for(let c=0;c<COLS;c++) {
  for(const variant of meshVariants(r,c)) {
    const cube=geo.bones.find(b=>b.name==='cloth_'+r+'_'+c+'_m_'+variant.code).cubes[0];
    assert.equal(cube.size[0],cube.uv.north.uv_size[0]);
    assert.equal(cube.size[1],cube.uv.north.uv_size[1]);
    assert.equal(cube.origin[1],restY(r+1)-variant.B,'bottom overlap follows attachment');
    if(!variant.L)assert.ok(Number.isInteger(cube.origin[0]));
    if(!variant.R)assert.ok(Number.isInteger(cube.origin[0]+cube.size[0]));
  }
}

// Stable damage contours select bare borders at every exposed edge, including
// the top shoulder strip. No overlap texels survive beyond the intended cut.
for(const profiles of burnProfiles)for(const depths of profiles) {
  const live=(r,c)=>r>=0&&r<ROWS&&c>=0&&c<COLS&&r<ROWS-depths[c];
  for(let r=0;r<ROWS;r++)for(let c=0;c<COLS;c++)if(live(r,c)) {
    const code=(live(r,c-1)?1:0)+(live(r,c+1)?2:0)+(live(r+1,c)?8:0);
    const shape=meshVariants(r,c).find(v=>v.code===code);
    assert.ok(shape);
    if(!live(r,c-1))assert.equal(shape.L,0);
    if(!live(r,c+1))assert.equal(shape.R,0);
    if(!live(r+1,c))assert.equal(shape.B,0);
  }
  const heights=depths.map(d=>restY(ROWS-d));
  assert.ok(Math.max(...heights)-Math.min(...heights)<=5,'controlled silhouette variation');
}

function simulate({ fps = 60, fire = t => t >= 0.5 && t < 7, seconds = 12, start = 0, seed = 11, inspect = () => {} } = {}) {
  const v = strict({ cwbf: 0, cwbe: 0, cwbt: 0, cwbr: BURN_END, cwbs: seed, cwfirst: ROWS-1, cwrd: 1, cwdirty: 0, cwbx: 0, cwby: 64, cwbz: 0 });
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
    if (v.cwbt > 0 && (v.cwbf || v.cwbr < BURN_END)) for (const { r, c, m, fn } of tileFns) {
      const f = s => value(v, r, c, s);
      fn(v, q, MATH);
      const s = f('s'), id = r + ',' + c;
      if (previous.get(id) !== s) events.push({ t, r, c, s });
      previous.set(id, s);
      const out = n => axes.map(a => f('out' + n + a));
      assert.ok(['m', 'h', 'i'].flatMap(out).every(Number.isFinite), 'finite output');
      if (s === 1 || s === 4) for (const side of [-1, 1]) {
        const actual = add(add(out('m'), scale(out('i'), H(r) / 2)), scale(out('h'), side * W / 2));
        const wanted = add(add(m, scale(rawI, H(r) / 2)), scale(rawH, side * W / 2));
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
      if (f('p') > RESTORE_TILE_TIME * 0.75) undershoot = Math.min(undershoot, ratio);
    }
    if (s === 2) minAsh = Math.min(minAsh, f('z'));
    if (t > 6.8 && t < 7 && s === 3) gone++;
  } });
  const starts = events.filter(e => e.s === 1), ends = events.filter(e => e.s === 4);
  const expected = burnOrders[Math.floor(v.cwbs) % burnOrders.length].filter(x=>x.due<6.5);
  assert.deepEqual(starts.map(e => [e.r, e.c]), expected.map(e=>[e.r,e.c]), 'only the selected profile burns');
  assert.equal(ends.length, expected.length, 'every burnt tile restores exactly once');
  assert.ok(starts[0].t >= 0.8 && starts[0].t <= 0.9, 'short exposure gives a light bite');
  assert.ok(gone > 0 && minAsh < 0.2, 'ash shrinks away before the burnt hold');
  assert.ok(overshoot > 1.1 && overshoot < 1.16 && undershoot < 0.98, 'unfold overshoot and settling');
  assert.ok(ends[0].t >= 8.5 && ends[0].t < 8.7, 'keep the original ember pause');
  const completed = events.filter(e => e.s === 0 && e.t > 8).at(-1).t;
  assert.ok(completed <= 9.6 && completed - ends[0].t <= 1.05, 'unfold completes within one second');
  for (const { r, c } of tiles) {
    assert.equal(value(v, r, c, 's'), 0);
    assert.equal(+value(v, r, c, 'show'), 1);
  }
  timing.push({ fps, first: starts[0].t, last: starts.at(-1).t, restoreStart: ends[0].t, restored: completed });
}
for (const item of timing) close([item.first, item.last, item.restored], [timing[1].first, timing[1].last, timing[1].restored], 'FPS-independent timing', 0.1);

// Keep the final edge uneven even under sustained fire. Verify every selectable
// profile, not just a different animation order leading to the same flat cutoff.
for (let profile = 0; profile < burnDepths.length; profile++) {
  const { v, events } = simulate({ fps: 30, seed: (profile + 0.1 - 68.5) / 17, seconds: 24, fire:()=>true, start:0.5 });
  assert.equal(Math.floor(v.cwbs) % burnDepths.length, profile);
  for (const { r, c } of tiles) {
    const gone = r >= ROWS - burnDepths[profile][c];
    assert.equal(value(v, r, c, 's'), gone ? 3 : 0, 'stable uneven silhouette');
    assert.equal(+value(v, r, c, 'show'), gone ? 0 : 1);
  }
  assert.equal(events.filter(e => e.s === 1).length, burnOrders[profile].length);
}

// New ignition order, short exposure, and reignition during ash/restoration.
const a = simulate({ start: 0 }), b = simulate({ start: 1.27 });
assert.notDeepEqual(a.events.filter(e => e.s === 1).map(e => [e.r, e.c]), b.events.filter(e => e.s === 1).map(e => [e.r, e.c]));
const short = simulate({ fire: t => t > 0.5 && t < 0.8, seconds: 6 });
assert.equal(short.events.filter(e => e.s === 1).length, 0, 'short fire must not eat a tile');
for (const resume of [1.65, 8.65, 9.1]) {
  const spins = new Map();
  let shape;
  const { v } = simulate({ fire: t => (t > 0.5 && t < (resume < 2 ? 1.6 : 7)) || (t > resume && t < resume + 3), seconds: resume + 8,
    inspect: ({ r, c, s, f, v }) => {
      if (shape === undefined) shape = v.cwbs;
      assert.equal(v.cwbs, shape, 'interrupted burning keeps the same damage limit');
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
const rawProgram=program(), rawChannels=channels(), rawRender=renderController();
const rawText=toMolang(rawProgram)+'return 0;';
const packed=compactNames([rawText,JSON.stringify(bones()),JSON.stringify(rawRender)]);
const rename=n=>Array.isArray(n)?n.map(rename):n&&typeof n==='object'?Object.fromEntries(Object.entries(n).map(([k,x])=>[k,rename(x)])):typeof n==='string'?packed.encode(n):n;
assert.equal(new Set(packed.map.values()).size,packed.map.size,'bijective compact names');
const packedProg=compileJs(rename(rawProgram)),packedChannels=rawChannels.map(ch=>compileJs(rename(ch.nodes),jsReturn(packed.encode(ch.value))));
const packedState=strict({});
const v = strict({}), s = { t: 0, ui: false, fire: false };
const visibility=Object.entries(rawRender.render_controllers['controller.render.player.cape'].part_visibility[0]).map(([name,expr])=>[name,compileJs([],jsReturn(expr.replaceAll('query.','q.').replaceAll('variable.','v.')))]);
let fullMass=0,leastMass=Infinity,detachedChecked=false;
const materialMass=state=>Object.entries(state).filter(([k])=>/^cm[0-9a-z]$/.test(k)).reduce((sum,[,m])=>sum+m,0);
const q = {
  armor_texture_slot:()=>0, anim_time: () => Math.min(s.t,.5), life_time: () => s.t, delta_time: () => 1 / 60, frame_alpha: () => (s.t * 20) % 1,
  position: k => [0.5, 65.62, 0.5][k], body_y_rotation: () => s.t * 67, is_riding: () => 0,
  bone_orientation_trs: n => ['head','rightarm','leftarm'].includes(n) ? upperBone(n) : ({ t: { x: n === 'leftleg' ? 1.9 : n === 'rightleg' ? -1.9 : 0, y: n === 'body' ? 24 : 12, z: 0 }, r: { x: 0, y: 0, z: 0 } }),
  get_root_locator_offset: () => 0, has_armor_slot: () => 0, has_cape: () => 1, is_in_ui: () => +s.ui, is_spectator: () => 0,
  is_item_name_any: () => 0, is_on_ground: () => 1, is_on_fire: () => +s.fire,
  time_stamp: () => Math.floor(s.t * 20), time_of_day: () => 0.25,
  is_in_water: () => 0, is_in_lava: () => 0, is_in_water_or_rain: () => 0, entity_biome_has_any_tags: () => 0,
  is_local_player: () => 1, distance_from_camera: () => 50, cape_flap_amount: () => 0,
  block_has_any_tag: (x, y, z, ...tags) => +(y < 64 || y > 65) * +tags.includes('minecraft:is_pickaxe_item_destructible'),
  block_has_all_tags: () => 0,
};
for (const ch of all) assert.ok(Number.isFinite(ch.fn(strict({}), q, MATH)), 'fresh channel before update');
for (let frame = 0; frame < 30 * 60; frame++) {
  s.t = frame / 60; s.fire = s.t > 0.5 && s.t < 24;
  prog(v, q, MATH);
  const order = frame % 2 ? [...all].reverse() : all;
  const results = order.map(ch => ch.fn(v, q, MATH));
  assert.ok(results.every(Number.isFinite));
  packedProg(packedState,q,MATH);
  const packedResults=packedChannels.map(fn=>fn(packedState,q,MATH));
  const rawResults=all.map(ch=>ch.fn(v,q,MATH));
  assert.deepEqual(packedResults,rawResults,'compacted export channel values');
  const expectedState=Object.fromEntries(Object.entries(v).map(([k,x])=>[packed.encode('v.'+k).slice(2),x]));
  assert.deepEqual({...packedState},expectedState,'compacted export state');
  const renderState=strict({...v,is_first_person:0,is_paperdoll:0,map_face_icon:0});
  const shown=visibility.filter(([,fn])=>fn(renderState,q,MATH)).map(([name])=>name);
  for(let r=0;r<ROWS;r++)for(let c=0;c<COLS;c++) {
    const matches=shown.filter(name=>name.startsWith('cloth_'+r+'_'+c+'_m_'));
    assert.equal(matches.length, v.cwon?+value(v,r,c,'show',1):1,'one selected mesh per visible tile');
  }
  assert.ok(shown.length<=25,'at most 25 visible cloth pieces');
  if(v.cwok) {
    const mass=materialMass(v);fullMass=Math.max(fullMass,mass);leastMass=Math.min(leastMass,mass);
    if(s.t>23&&s.t<24)assert.ok(mass<fullMass*.5,'heavy burn sheds most of its physical load');
    if(s.t>29)assert.ok(Math.abs(mass-fullMass)<1e-4,'restoration rebuilds all material');
    if(!detachedChecked&&s.t>23) {
      const source={...v},perturbed={...v};
      for(const [name,mass]of Object.entries(v))if(/^cm[0-9a-z]$/.test(name)&&mass<.001)for(const a of axes) {
        perturbed['cp'+name.slice(2)+a]+=1000;perturbed['cq'+name.slice(2)+a]-=1000;
      }
      const time=s.t;s.t+=1/60;prog(strict(source),q,MATH);prog(strict(perturbed),q,MATH);s.t=time;
      for(const [name,mass]of Object.entries(source))if(/^cm[0-9a-z]$/.test(name)&&mass>.001)for(const a of axes)
        assert.equal(source['cp'+name.slice(2)+a],perturbed['cp'+name.slice(2)+a],'hidden cloth cannot drag attached cloth');
      detachedChecked=true;
    }
  }
  const cell = {};
  order.forEach((ch, i) => (cell[ch.r + ',' + ch.c] ??= {})[ch.field] = results[i]);
  for (const { r, c } of tiles) if (value(v, r, c, 's') === 2) {
    const f = n => value(v, r, c, n), cl = cell[r + ',' + c];
    const G = axes.map((_, k) => axes.map((_, j) => v[`cwg${k}${j}`]));
    const m = [restX(c) + W / 2 + cl.px, restY(r) - H(r) / 2 + cl.py - 24, ZMID + cl.pz];
    const actual = add(axes.map(a => v['cwk' + a]), mul(G, m)), u = f('p') / 0.4;
    const wanted = add(axes.map(a => f('m' + a)), add(scale(axes.map(a => f('d' + a)), 3.5 * u), [0, 3.5 * u, 0]));
    close(actual, wanted, 'final bone position preserves the detached world frame', 1e-4);
  }
  const before = JSON.stringify({ ...v });
  assert.deepEqual(order.map(ch => ch.fn(v, q, MATH)), results, 'channel order and duplicate pass');
  assert.equal(JSON.stringify({ ...v }), before, 'duplicate pass must not advance timers');
  s.ui = true; prog(v, q, MATH); packedProg(packedState,q,MATH);
  const uiState = JSON.stringify({ ...v });
  for (const ch of order) assert.ok(Number.isFinite(ch.fn(v, q, MATH)));
  assert.equal(JSON.stringify({ ...v }), uiState, 'UI channels must not mutate effect state');
  const world = JSON.parse(before), ui = JSON.parse(uiState);
  delete world.cwon; delete ui.cwon;
  assert.deepEqual(ui, world, 'UI update must not advance physics or burn');
  s.ui = false;
}
assert.equal(tiles.filter(({ r, c }) => value(v, r, c, 's') !== 0).length, 0);
assert.ok(detachedChecked&&leastMass<fullMass*.5);
console.log({fullMass,leastMass,exportLength:packed.expression(rawText).length});
const raw=toMolang(program())+'return 0;', packTexts=[raw,JSON.stringify(bones()),JSON.stringify(renderController())];
assert.ok(compactNames(packTexts).expression(raw).length <= 61500);
console.log('PASS: burn frontier, pinned edges, world-space ashes, overshoot, repeat ignition, UI and channel order');
console.table(timing);
