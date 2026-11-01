// Cost per second of one caped player, measured like VanillaRagdoll's
// check-contact-performance.mjs: every executed assignment is a write, every block query
// a query. Counts the second second of each run (warm-up and reset are over).
import { program, channels } from "./cloth.mjs";
import { compileJs, jsReturn, MATH, strict } from "./molang.mjs";

const count = nodes => nodes.flat(Infinity).flatMap(n =>
  n.kind === "set" ? [n, { kind: "set", name: "v.diag", expr: "v.diag+1" }]
  : n.kind === "if" ? [{ ...n, yes: count(n.yes), no: count(n.no) }]
  : n.kind === "loop" ? [{ ...n, body: count(n.body) }] : [n]);
const prog = compileJs(count(program()), "return 0;");
const chans = channels().map(ch => compileJs(count(ch.nodes), jsReturn(ch.value)));

function measure({ fps, speed = 0, roof = false, water, rain = false, viewer = false }) {
  const v = strict({ diag: 0 }), solid = (x, y) => y <= 63 || (roof && y >= 66);
  let z = 0.3, phase = 0, tick = -1, prev, cur, writes = 0, queries = 0;
  for (let f = 0; f < 2 * fps; f++) {
    const t = f / fps, now = Math.floor(t * 20 + 0.001);
    z += speed / fps; phase += speed / fps;
    if (now !== tick) { prev = cur; cur = [0.5, 64, z]; tick = now; }
    const sw = Math.sin(phase * 140) * Math.min(1, speed * 0.2) * 80;
    const bones = { body: { t: { x: 0, y: 24, z: 0 }, r: { x: 0, y: 0, z: 0 } },
      rightleg: { t: { x: -1.9, y: 12, z: 0 }, r: { x: sw, y: 0, z: 0 } }, leftleg: { t: { x: 1.9, y: 12, z: 0 }, r: { x: -sw, y: 0, z: 0 } } };
    const wet = y => water !== undefined && y < water;
    let q0 = 0;
    const q = { life_time: () => t, delta_time: () => 1 / fps, frame_alpha: () => t * 20 - now, position: k => cur[k] + (k === 1 ? 1.62 : 0),
      body_y_rotation: () => 0, is_riding: () => 0, bone_orientation_trs: n => bones[n], get_root_locator_offset: () => 0, has_armor_slot: () => 0,
      has_cape: () => 1, is_in_ui: () => 0, is_spectator: () => 0, is_item_name_any: () => 0, is_on_ground: () => 1, is_on_fire: () => 0,
      time_stamp: () => 5000 + now, is_in_water: () => +wet(64), is_in_contact_with_water: () => +wet(63.9), is_in_lava: () => 0,
      is_in_water_or_rain: () => +(wet(64) || (rain && !roof)), entity_biome_has_any_tags: () => 0, time_of_day: () => 0.25,
      cape_flap_amount: () => 0, is_local_player: () => +!viewer, distance_from_camera: () => viewer ? 0.9 : 50, rotation_to_camera: k => k ? 180 : -10,
      block_has_any_tag: (x, y, z, ...tags) => { q0++; return +tags.some(t => (wet(y) ? ["water"] : solid(x, y, z) ? ["minecraft:is_pickaxe_item_destructible"] : []).includes(t)); },
      block_has_all_tags: (x, y, z, ...tags) => { q0++; return +tags.every(t => (wet(y) ? ["water"] : solid(x, y, z) ? ["minecraft:is_pickaxe_item_destructible"] : []).includes(t)); } };
    const before = v.diag;
    prog(v, q, MATH);
    for (const fn of chans) fn(v, q, MATH);
    if (f >= fps) { writes += v.diag - before; queries += q0; }
  }
  return { writes, queries };
}

const cases = [
  ["indoor, standing (asleep)", { fps: 60, roof: true }],
  ["outdoor, standing in wind", { fps: 60 }],
  ["outdoor, standing in rain", { fps: 60, rain: true }],
  ["outdoor, sprinting 30 fps", { fps: 30, speed: 5.6 }],
  ["outdoor, sprinting 60 fps", { fps: 60, speed: 5.6 }],
  ["outdoor, sprinting 144 fps", { fps: 144, speed: 5.6 }],
  ["underwater", { fps: 60, water: 67 }],
  ["another player beside it", { fps: 60, viewer: true }],
];
console.log("per second, one caped player".padEnd(30), "writes".padStart(8), "queries".padStart(8));
for (const [name, opt] of cases) {
  const { writes, queries } = measure(opt);
  console.log(name.padEnd(30), String(writes).padStart(8), String(queries).padStart(8));
}
