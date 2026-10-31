// Cloth cape: a pinned PBD particle grid simulated inside animation.player.cape.
// Frames, all in model pixels:
//   body-local = geometry coordinates of the rest body (pivot 0,24,0)
//   sim        = world axes, origin at the rebased block position v.cwb
// G = Y*R maps body-local offsets into sim. R is the animated body rotation from
// q.bone_orientation_trs; Y is the yaw and z flip used by Simple Ragdoll's boneOutput.
import { set, when, loop, flat, num, toMolang } from "./molang.mjs";

export const COLS = 4, ROWS = 6, W = 10 / COLS, H = 16 / ROWS;
export const ZMID = 2.5;                 // cape mid-plane at rest (cube z 2..3)
const PX = 16 / 0.9375;                  // model pixels per block at the vanilla player scale
const MARGIN = 0.5, HIP_Y = 12;          // half thickness; legs only push rows below the hip
const envNum = (k, d) => process.env[k] === undefined ? d : Number(process.env[k]);  // tuning sweeps
// Leg collider: half width of the column band each leg catches (4 = its whole side), margin
// past the leg's back face, and the share of the leg's speed handed to the cape. Sweep with
// check.mjs: narrower bands fold the cape between pushed and free columns (worse seams);
// LEG_CARRY 0.3 cut the in-place hem kick from 5.9 to 3.7 px with less leg clipping.
const LEG_HALF = envNum("LEG_HALF", 4), LEG_MARGIN = envNum("LEG_MARGIN", 0.5), LEG_CARRY = envNum("LEG_CARRY", 0.3);
// DRAG: linear air damping per second. AIR: quadratic air drag per pixel of motion, which
// lifts the cape with speed. BEND: stiffness of skip-one horizontal links keeping it spread.
// Sweep (sprint): AIR 0 -> 40° lift, 0.02 -> 53°, 0.04 -> 62°, 0.06 -> 68°; hem stays full width
// for any AIR > 0. BEND 0.5 costs 5000 chars and changed nothing once AIR > 0, so it is off.
const GRAVITY = 16 * PX, DRAG = envNum("DRAG", 2), AIR = envNum("AIR", 0.04), BEND = envNum("BEND", 0), FLUTTER = envNum("FLUTTER", 5) * PX;  // sweep: 0.6 -> 0.05 px ripple, 5 -> 0.45 px; 6 breaks 144fps seams, 16 starts side sway
const SUB_DT = 1 / 60, MAX_SUB = 3, ITER = 2, STRETCH = 1.02, REBASE = 4096;
// Sleep once the hem moves less than SLEEP_EPS px per step for SLEEP_FRAMES stepped frames;
// wake when an anchor or a leg moves by WAKE_EPS (VanillaRagdoll sleeps the same way).
const SLEEP_FRAMES = 30, SLEEP_EPS = envNum("SLEEP_EPS", 0.002), WAKE_EPS = 0.01;
// Solid blocks: Simple Ragdoll's default terrain tags. Water and lava carry none of them.
const SOLID = "'minecraft:is_axe_item_destructible','minecraft:is_hoe_item_destructible','minecraft:is_pickaxe_item_destructible','minecraft:is_shovel_item_destructible','not_feature_replaceable'";
// Cloth stops this many px short of a block face. VIEWER: radius and height (blocks) of
// another player's body as seen from their camera, for pushing this cape.
const WALL_GAP = 0.5, VIEWER_R = 0.35, VIEWER_H = 1.8;
export const CLAMP_ROW = envNum("CLAMP_ROW", 2); // rows from here down collide with terrain (row 1 sits on the back)
// Wind, blocks per second. Base speed drifts over minutes; gusts come every few seconds and
// grow in rain; WIND_CALM is the dead zone that lets the cape sleep indoors.
// Halved after the first in-game test: everyday wind should only just lift a cape facing
// into it, and rain at 1.0 blew it flat.
const WIND = envNum("WIND", 0.5), WIND_RAIN = 2.5, WIND_SNOW = 1.3, WIND_CALM = 0.15, AIR_MAX = 6;
// Fluids: velocity kept per 60 Hz step and the share of gravity left after buoyancy.
// Fire: the heat (0..1) takes HEAT_LIFT of the weight off the cape and makes it billow (sweep:
// lift above 1 flips the cape over the head, flutter 4 opens 2 px seams; 1 and 2 lift the hem
// about 6 px with 0.8 px seams); the
// hem burns away up to BURN_ROWS rows, one row per 1/BURN_RATE s on fire, and grows back one
// row per 1/REGROW_RATE s once out (hidden rows still simulate, only their cubes are hidden).
const HEAT_LIFT = envNum("HEAT_LIFT", 1), HEAT_FLUTTER = envNum("HEAT_FLUTTER", 2), BURN_ROWS = 3, BURN_RATE = 0.5, REGROW_RATE = 0.1;
const WATER_DRAG = envNum("WATER_DRAG", 0.8), WATER_G = envNum("WATER_G", -0.05), LAVA_DRAG = 0.6, LAVA_G = 0.05;

const NP = (ROWS + 1) * (COLS + 1);
if (NP > 36 || ROWS * COLS > 36) throw new Error("grid too large for one-character keys");
const key = i => i.toString(36);
const AX = ["x", "y", "z"];
export const pid = (r, c) => r * (COLS + 1) + c;
export const restX = c => -5 + c * W, restY = r => 24 - r * H;
const isPinned = i => i <= COLS;
// v.cp/v.cq: particle position and previous position (sim). v.cu: body-local position,
// persisted so bone channels can read it after anim_time_update. v.cc: per-cell outputs.
const P = (i, a) => `v.cp${key(i)}${a}`, Q = (i, a) => `v.cq${key(i)}${a}`, U = (i, a) => `v.cu${key(i)}${a}`;
export const CV = (r, c, f) => `v.cc${key(r * COLS + c)}${f}`;

const free = [];
for (let r = 1; r <= ROWS; r++) for (let c = 0; c <= COLS; c++) free.push({ i: pid(r, c), r, c });
const links = [];
for (let r = 0; r <= ROWS; r++) for (let c = 0; c <= COLS; c++) {
  if (c < COLS && r > 0) links.push([pid(r, c), pid(r, c + 1), W]);
  if (r < ROWS) links.push([pid(r, c), pid(r + 1, c), H]);
  if (BEND > 0 && r > 0 && c + 2 <= COLS) links.push([pid(r, c), pid(r, c + 2), 2 * W, BEND]);
}

// Bedrock euler (degrees) -> Rz(-rz)*Ry(ry)*Rx(-rx), the convention of Simple Ragdoll's modelQuaternion.
const euler = s => [set("t.ca", `math.cos(${s}.r.x)`), set("t.sa", `-math.sin(${s}.r.x)`), set("t.cb", `math.cos(${s}.r.y)`),
  set("t.sb", `math.sin(${s}.r.y)`), set("t.cc", `math.cos(${s}.r.z)`), set("t.sc", `-math.sin(${s}.r.z)`)];
const R = [
  ["t.cc*t.cb", "t.cc*t.sb*t.sa-t.sc*t.ca", "t.cc*t.sb*t.ca+t.sc*t.sa"],
  ["t.sc*t.cb", "t.sc*t.sb*t.sa+t.cc*t.ca", "t.sc*t.sb*t.ca-t.cc*t.sa"],
  ["-t.sb", "t.cb*t.sa", "t.cb*t.ca"],
];
// Model vector -> world axes (physical z flip, then yaw), as Simple Ragdoll's activate().
const yawMap = (x, y, z) => [`t.cy*${x}+t.sy*${z}`, y, `t.sy*${x}-t.cy*${z}`];
const simPoint = (out, s) => yawMap(`${s}.t.x`, `${s}.t.y`, `${s}.t.z`).map((e, k) => set(out + AX[k], `t.o${AX[k]}+${e}`));
const dot = (n, i) => `${n[0]}*${P(i, "x")}+${n[1]}*${P(i, "y")}+${n[2]}*${P(i, "z")}`;
const TORSO = ["t.g02", "t.g12", "t.g22"], RLEG = ["t.rnx", "t.rny", "t.rnz"], LLEG = ["t.lnx", "t.lny", "t.lnz"];
// Interpolate the tick-stepped actor position, as Simple Ragdoll's anchorPrograms(). A
// player's q.position(1) is the eye, 1.62 above the feet (VanillaRagdoll's player rig
// subtracts it too); everything here works from the feet.
export const EYE = 1.62;
const feetY = `(q.position(1)-${EYE})`;
function origin() {
  const e = k => k === 1 ? feetY : `q.position(${k})`;
  return [
    set("t.now", "math.floor(q.life_time*20+0.001)"),
    set("t.j", `math.abs(${e(0)}-v.cwcx)+math.abs(${e(1)}-v.cwcy)+math.abs(${e(2)}-v.cwcz)`),
    // Also reset far from the base so sim coordinates stay small (float precision).
    set("t.sr", `!v.cwok||q.delta_time>0.25||t.j>8||math.abs(${e(0)}-v.cwbx)+math.abs(${e(2)}-v.cwbz)>${REBASE}`),
    set("t.tk", "t.sr||t.now!=v.cwtk"),  // a new game tick: per-tick sampling below
    when("t.sr||t.now<v.cwtk||t.now-v.cwtk>1", [AX.map((a, k) => [set("v.cwp" + a, e(k)), set("v.cwc" + a, e(k))]), set("v.cwtk", "t.now")]),
    when("t.now!=v.cwtk", [AX.map(a => set("v.cwp" + a, "v.cwc" + a)), set("v.cwtk", "t.now")]),
    AX.map((a, k) => [set("v.cwc" + a, e(k)), set("t.r" + a, `math.lerp(v.cwp${a},v.cwc${a},math.clamp(q.frame_alpha,0,1))`)]),
    when("t.sr", [AX.map(a => [set("v.cwb" + a, "t.r" + a), set("v.cwl" + a, "t.r" + a)]), set("v.cwvx", 0), set("v.cwvz", 0), set("v.cwh", 0)]),
    AX.map(a => set("t.o" + a, `(t.r${a}-v.cwb${a})*${num(PX)}`)),
    // Smoothed horizontal body velocity (blocks/s); flutter follows the speed relative to the wind.
    ["x", "z"].map(a => set("v.cwv" + a, `math.lerp(v.cwv${a},math.clamp((t.r${a}-v.cwl${a})/math.max(q.delta_time,0.001),-8,8),math.clamp(q.delta_time*8,0,1))`)),
    AX.map(a => set("v.cwl" + a, "t.r" + a)),
  ];
}

// Whole blocks around the feet, cached when the player enters a new block cell (and once a
// second for block edits), with absolute block queries at the feet as VanillaRagdoll's player
// rig does (relative queries and q.position are eye-based for players). Bits 0-17: the 3x3 columns around the feet at foot
// level (dy 0) and one up (dy 1), index (dy*3+dz+1)*3+dx+1; the player's own column (4, 13)
// is never queried, so a slab or stair the player stands in does not push the cape. Bit 18:
// ceiling (dy 2). Particles that land in a cached solid cell leave it through the face they
// crossed, as Simple Ragdoll's cell contacts do; below the ring only a floor plane remains.
const RING = 19, OWN = [4, 13];
function env() {
  const bit = n => `math.mod(math.floor(v.cwtb/${2 ** n}),2)`;
  return [
    AX.map((a, k) => set("t.e" + a, `math.floor(${k === 1 ? feetY : `q.position(${k})`})`)),
    set("v.cwtt", "v.cwtt+math.clamp(q.delta_time,0,0.1)"),
    when("t.sr||v.cwtt>1||t.ex!=v.cwex||t.ey!=v.cwey||t.ez!=v.cwez", [
      AX.map(a => set("v.cwe" + a, "t.e" + a)), set("v.cwtt", 0), set("v.cwtb", 0), set("t.i", 0),
      loop(RING, [
        set("t.dx", "t.i<18?math.mod(t.i,3)-1:0"), set("t.dz", "t.i<18?math.mod(math.floor(t.i/3),3)-1:0"),
        set("t.dy", "math.floor(t.i/9)"),
        when(`t.i!=${OWN[0]}&&t.i!=${OWN[1]}&&q.block_has_any_tag(t.ex+t.dx,t.ey+t.dy,t.ez+t.dz,${SOLID})`,
          set("v.cwtb", "v.cwtb+math.pow(2,t.i)")), set("t.i", "t.i+1"),
      ]),
      // Wind exposure one block up: +x, +z, -x, -z neighbours and the ceiling.
      [14, 16, 12, 10].map((n, d) => set("v.cwj" + d, bit(n))), set("v.cwce", bit(18)),
      set("v.cwfl", `q.block_has_any_tag(t.ex,t.ey-1,t.ez,${SOLID})?(t.ey-v.cwby)*${num(PX)}+${num(MARGIN)}:-1000000`),
      // Cell origin of the ring in sim pixels, for the per-particle lookup.
      AX.map(a => set("v.cwo" + a, `(t.e${a}-v.cwb${a})*${num(PX)}`)),
    ]),
    // Fluids, every tick while the player is in one (q.is_in_contact_with_water also counts
    // rain): the surface is 0.9 above the highest wet cell of the feet cell and the two above;
    // particles below it get drag and buoyancy.
    when("t.tk", [
      set("v.cwwe", "q.is_in_water||q.is_in_lava"),
      when("v.cwwe", [
        set("t.lv", "q.is_in_lava"),
        set("t.wy", "q.block_has_any_tag(t.ex,t.ey+2,t.ez,'water','lava')?2:q.block_has_any_tag(t.ex,t.ey+1,t.ez,'water','lava')?1:0"),
        set("v.cwfh", `(t.ey+t.wy+0.9-v.cwby)*${num(PX)}`),
        set("v.cwfd", `t.lv?${LAVA_DRAG}:${WATER_DRAG}`), set("v.cwfg", `t.lv?${LAVA_G}:${WATER_G}`),
      ], set("v.cwfh", -1000000)),
      set("v.cwht", "math.clamp(v.cwht+(q.is_on_fire?0.1:-0.05),0,1)"),
      set("v.cwbn", `math.clamp(v.cwbn+(q.is_on_fire?${num(BURN_RATE / 20)}:-${num(REGROW_RATE / 20)}),0,${BURN_ROWS})`),
      set("v.cwsg", "v.cwtb+v.cwwe*1048576+(v.cwht>0)*2097152"),
    ]),
  ];
}

// World wind from the level clock, so every client sees the same direction. Per tick:
// weather sets the strength (rain = wet but not in water; snow = rain in a cold biome),
// then the blocks around the player shape it: a wall upwind shelters, walls on both sides
// of a gap channel it along the gap, a roof keeps only a corridor's draft, height adds.
function wind() {
  const cos = x => `math.cos(${x})`, sin = x => `math.sin(${x})`;
  return [
    when("t.tk", [
      set("t.ts", "math.mod(q.time_stamp,1000000)"),
      set("t.wa", `t.ts*0.041+${sin("t.ts*0.023")}*120`),
      set("v.cwrn", `math.clamp(v.cwrn+((q.is_in_water_or_rain&&!q.is_in_water)?0.05:-0.003),0,1)`),
      set("t.ws", `${num(WIND)}*(0.9+0.5*${sin("t.ts*0.07")}+math.max(${sin("t.ts*1.9")}*${sin("t.ts*0.67")},0)*(0.8+1.6*v.cwrn))` +
        `*(1+${num(WIND_RAIN - 1)}*v.cwrn*(q.entity_biome_has_any_tags('cold','frozen')?${num(WIND_SNOW)}:1))`),
      set("t.ux", cos("t.wa")), set("t.uz", sin("t.wa")),
      // Sea and land breezes: by water the wind turns round between day and night and drops
      // at dawn and dusk; deserts blow hardest in the afternoon, other land a little by day.
      set("t.dn", "math.sin((q.time_of_day-0.25)*360)"),
      when("q.entity_biome_has_any_tags('ocean','beach','river')",
        [set("t.ux", "t.ux*t.dn"), set("t.uz", "t.uz*t.dn"), set("t.ws", "t.ws*(0.4+0.8*math.abs(t.dn))")],
        set("t.ws", "t.ws*(1+(q.entity_biome_has_any_tags('desert','mesa')?0.6:0.25)*t.dn)")),
      // Shelter: a wall on the side the wind comes from (wind toward -x comes from +x).
      set("t.sh", "1-0.7*math.max(v.cwj0*math.max(-t.ux,0)+v.cwj2*math.max(t.ux,0),v.cwj1*math.max(-t.uz,0)+v.cwj3*math.max(t.uz,0))"),
      set("t.cx", "v.cwj1&&v.cwj3&&!(v.cwj0&&v.cwj2)"), set("t.cz", "v.cwj0&&v.cwj2&&!(v.cwj1&&v.cwj3)"),
      when("t.cx||t.cz", [set("t.ux", "t.cx?(t.ux<0?-1:1):0"), set("t.uz", "t.cz?(t.uz<0?-1:1):0"), set("t.sh", 1.7)],
        when("v.cwj0&&v.cwj1&&v.cwj2&&v.cwj3", set("t.sh", 0.1))),
      set("t.ws", `t.ws*t.sh*(v.cwce?(t.cx||t.cz?0.6:0.1):1)*(1-v.cwwe)*math.clamp(1+(q.position(1)-64)/128,0.6,1.8)`),
      set("t.ws", `t.ws>${num(WIND_CALM)}?t.ws:0`),
      set("v.cwux", "t.ux*t.ws"), set("v.cwuz", "t.uz*t.ws"),
    ]),
    // Smooth the stepped tick values; airspeed drives the flutter.
    ["x", "z"].map(a => set("v.cwn" + a, `math.lerp(v.cwn${a},v.cwu${a},math.clamp(q.delta_time*2,0,1))`)),
    // In a fluid the air flutter gives way to a fixed slight sway standing in for currents
    // (buoyancy alone cannot tip a cape hanging straight down).
    set("v.cwsp", `v.cwwe?1.5:math.min(math.sqrt(math.pow(v.cwvx-v.cwnx,2)+math.pow(v.cwvz-v.cwnz,2))+v.cwht*${HEAT_FLUTTER},${AIR_MAX})`),
  ];
}

// Body frame G, torso and leg half-spaces, and the pinned top row.
function frame() {
  const G = [0, 1, 2].map(j => yawMap(`(${R[0][j]})`, `(${R[1][j]})`, `(${R[2][j]})`));
  const leg = (s, bone, out) => [set(s, `q.bone_orientation_trs('${bone}')`), euler(s),
    yawMap(`(${R[0][2]})`, `(${R[1][2]})`, `(${R[2][2]})`).map((e, k) => set(`t.${out}n${AX[k]}`, e)), simPoint(`t.${out}p`, s),
    set(`t.${out}d`, `t.${out}nx*t.${out}px+t.${out}ny*t.${out}py+t.${out}nz*t.${out}pz+${num(2 + LEG_MARGIN)}`)];
  return [
    set("t.cy", "math.cos(q.body_y_rotation)"), set("t.sy", "math.sin(q.body_y_rotation)"),
    set("t.bb", "q.bone_orientation_trs('body')"), euler("t.bb"),
    G.map((col, j) => col.map((e, k) => set(`t.g${k}${j}`, e))),
    simPoint("t.b", "t.bb"),
    // Bone channels convert particles back to body-local space, so they need G and b.
    [0, 1, 2].map(j => [0, 1, 2].map(k => set(`v.cwg${j}${k}`, `t.g${j}${k}`))), AX.map(a => set("v.cwk" + a, "t.b" + a)),
    set("t.td", `t.g02*t.bx+t.g12*t.by+t.g22*t.bz+${num(2 + MARGIN)}+v.cwaz`),
    // Another player's body (feet = camera - 1.62) close to this cape, in sim pixels.
    set("t.vn", "!q.is_local_player&&q.distance_from_camera<2.5"),
    when("t.vn", [set("t.vd", "q.distance_from_camera"), set("t.vp", "q.rotation_to_camera(0)"), set("t.vw", "q.rotation_to_camera(1)"),
      set("t.vh", `t.vd*math.cos(t.vp)*${num(PX)}`), set("t.vcx", "t.ox-t.vh*math.sin(t.vw)"), set("t.vcz", "t.oz+t.vh*math.cos(t.vw)"),
      set("t.vcy", `t.oy-t.vd*math.sin(t.vp)*${num(PX)}`)]),
    leg("t.rl", "rightleg", "r"), leg("t.ll", "leftleg", "l"),
    AX.map((a, k) => set("t.a" + a, `t.b${a}+t.g${k}2*(${num(ZMID)}+v.cwaz)`)),
    // Target anchors; step() moves the persistent top row toward them across substeps.
    Array.from({ length: COLS + 1 }, (_, c) => AX.map((a, k) => set(AN(c, a), `t.a${a}+t.g${k}0*${num(restX(c))}`))),
  ];
}
const AN = (c, a) => `t.an${key(c)}${a}`;
const pinnedIds = Array.from({ length: COLS + 1 }, (_, c) => c);

const reset = () => [pinnedIds.map(c => AX.map(a => set(P(c, a), AN(c, a)))),
  // Previous positions are not reset: v.cwh = 0 makes the next step use zero velocity.
  free.map(({ i, r, c }) => AX.map((a, k) => set(P(i, a), `${P(c, a)}-t.g${k}1*${num(r * H)}`)))];

// Back-face half-spaces: anything in front of the torso or leg back face is pushed
// behind it. Self-healing: a cape that swings through the body in a fast turn always
// returns to the back. Box or slab tests let the cloth snag across the body (tried).
const plane = (i, n, d) => [set("t.pd", `${d}-(${dot(n, i)})`),
  when("t.pd>0", AX.map((a, k) => set(P(i, a), `${P(i, a)}+${n[k]}*t.pd`)))];
const torso = i => plane(i, TORSO, "t.td");
// Legs push the cape out but only hand on LEG_CARRY of their own speed (the previous
// position moves with the rest of the push), so a swinging leg no longer drags the hem.
const legPlane = (i, n, d) => [set("t.pd", `${d}-(${dot(n, i)})`),
  when("t.pd>0", AX.map((a, k) => [set(P(i, a), `${P(i, a)}+${n[k]}*t.pd`), set(Q(i, a), `${Q(i, a)}+${n[k]}*t.pd*${num(1 - LEG_CARRY)}`)]))];

function constraint([a, b, len, stiff = 1]) {
  const pin = isPinned(a), w = (pin ? 1 : 0.5) * stiff;
  return [AX.map(x => set("t.d" + x, `${P(b, x)}-${P(a, x)}`)),
    // (|d| - len) / |d|, written as one statement to save characters.
    set("t.e", `(1-${num(len)}/math.max(math.sqrt(t.dx*t.dx+t.dy*t.dy+t.dz*t.dz),0.0001))${w === 1 ? "" : "*" + num(w)}`),
    AX.map(x => [pin ? [] : set(P(a, x), `${P(a, x)}+t.d${x}*t.e`), set(P(b, x), `${P(b, x)}-t.d${x}*t.e`)])];
}

// About 60 steps a second from an accumulator: at high frame rates a step runs once 3/4 of
// a 60 Hz step has built up (frames between steps reuse the cached cells), and each step
// covers exactly the time accumulated, at most three per frame.
function schedule() {
  return [
    set("v.cwac", "v.cwac+math.clamp(q.delta_time,0,0.1)"),
    set("t.n", `v.cwac<${num(0.75 * SUB_DT)}?0:math.min(math.floor(v.cwac/${num(SUB_DT)}+0.5),${MAX_SUB})`),
    set("t.h", "t.n>0?v.cwac/t.n:0"), when("t.n>0", set("v.cwac", 0)),
  ];
}
// The hem corners and centre stand for the whole cape's motion.
const hemProbe = [pid(ROWS, 0), pid(ROWS, COLS >> 1), pid(ROWS, COLS)];
const legSig = ["t.rd+t.rnz", "t.ld+t.lnz"];
// Drift of the persistent top row from its anchors, plus leg movement since the last step.
// Blocks, fluids and wind are compared with their values at the last step.
const wake = () => [...pinnedIds.flatMap(c => AX.map(a => `math.abs(${P(c, a)}-${AN(c, a)})`)),
  `math.abs(${legSig[0]}-v.cwrs)`, `math.abs(${legSig[1]}-v.cwls)`, "math.abs(v.cwsg-v.cwss)",
  "math.abs(v.cwnx-v.cwsx)", "math.abs(v.cwnz-v.cwsz)"].join("+") + `>${num(WAKE_EPS)}||t.vn||v.cwht>0`;

function step() {
  return [
    // Velocity rescale for a changed step length; 0 right after a reset (v.cwh = 0).
    set("t.k", "v.cwh>0?math.clamp(t.h/v.cwh,0.5,2):0"), set("v.cwh", "t.h"),
    hemProbe.map(i => AX.map(a => set("t.w" + key(i) + a, P(i, a)))),
    set("t.dm", `math.exp(-${num(DRAG)}*t.h)`), set("t.gh", `${num(GRAVITY)}*t.h*t.h`),
    set("t.fh", `v.cwsp*${num(FLUTTER)}*t.h*t.h`), set("t.tp", "math.mod(q.life_time,40)*900"),
    // Wind as a per-step displacement; fluid drag and the buoyancy-reduced gravity.
    set("t.wx", `v.cwnx*${num(PX)}*t.h`), set("t.wz", `v.cwnz*${num(PX)}*t.h`),
    set("t.fd", "math.pow(v.cwfd,t.h*60)"), set("t.gw", "v.cwfg*t.gh"),
    set("t.gh", `t.gh*(1-${num(HEAT_LIFT)}*v.cwht)`),  // hot air rising takes weight off the cape
    // A wave running from the shoulders to the hem, nearly in phase across a row.
    free.map(({ i, r, c }) => set("t.fq" + key(i), `math.sin(t.tp-${r * 50 + c * 8})*${num(r / ROWS)}`)),
    set("t.j", 0),
    loop("t.n", [
      pinnedIds.map(c => AX.map(a => set(P(c, a), `${P(c, a)}+(${AN(c, a)}-${P(c, a)})/(t.n-t.j)`))), set("t.j", "t.j+1"),
      // Verlet step. Sim axes are world axes, so P-Q minus the wind step is the speed through
      // the air; the quadratic term 1/(1+AIR*|step|) is an implicit, always-stable air drag.
      // Below the fluid surface the drag and buoyancy replace it.
      free.map(({ i }) => [set("t.wt", `${P(i, "y")}<v.cwfh`),
        AX.map(a => set("t.v" + a, `(${P(i, a)}-${Q(i, a)})*t.k${a === "y" ? "" : "-t.w" + a}`)),
        set("t.s", `t.wt?t.fd:t.dm/(1+${num(AIR)}*math.sqrt(t.vx*t.vx+t.vy*t.vy+t.vz*t.vz))`),
        AX.map((a, k) => [set(Q(i, a), P(i, a)),
          set(P(i, a), `${P(i, a)}+t.v${a}*t.s+t.fh*t.fq${key(i)}*t.g${k}2${a === "y" ? "-(t.wt?t.gw:t.gh)" : "+t.w" + a}`)])]),
      set("t.k", 1),
      free.map(({ i, r, c }) => {
        const top = pid(0, c), max = num(r * H * STRETCH);
        return [AX.map(a => set("t.d" + a, `${P(i, a)}-${P(top, a)}`)), set("t.e", "math.sqrt(t.dx*t.dx+t.dy*t.dy+t.dz*t.dz)"),
          when(`t.e>${max}`, AX.map(a => set(P(i, a), `${P(top, a)}+t.d${a}*${max}/t.e`)))];
      }),
      // Collision inside the iteration loop so the links spread each push over the cloth.
      // Rows hanging beside the torso collide with the torso; rows below the hip only with
      // the legs (a tilted torso plane would sweep through them when sneaking). Each leg only
      // catches columns inside its shrunken width, so edge and centre columns hang free.
      // Lower rows pick by their current body-local height: once the hem has lifted above
      // the hip (running), legs swinging up to ±80° no longer kick it, only the torso holds it.
      loop(ITER, [links.map(constraint), free.map(({ i, r, c }) => {
        const x = restX(c);
        if (restY(r) >= HIP_Y) return torso(i);
        const legs = [Math.abs(x + 1.9) < LEG_HALF ? legPlane(i, RLEG, "t.rd") : [], Math.abs(x - 1.9) < LEG_HALF ? legPlane(i, LLEG, "t.ld") : []];
        return [set("t.ly", `t.g01*(${P(i, "x")}-t.bx)+t.g11*(${P(i, "y")}-t.by)+t.g21*(${P(i, "z")}-t.bz)`),
          when(`t.ly>${num(HIP_Y - 24)}`, torso(i), legs)];
      }),
      // Terrain and other players last in each iteration, so the links settle around a block
      // edge (one pass after the iterations left the cloth stretched over corners) and the
      // rendered cloth never ends up inside a block.
      contacts()]),
    ]),
    // Sleep bookkeeping: hem motion per step this frame, and the leg pose it was taken in.
    set("t.mv", `(${hemProbe.map(i => AX.map(a => `math.abs(${P(i, a)}-t.w${key(i)}${a})`).join("+")).join("+")})/t.n`),
    set("v.cwqt", `t.mv<${num(SLEEP_EPS)}?v.cwqt+1:0`),
    set("v.cwrs", legSig[0]), set("v.cwls", legSig[1]),
    set("v.cwss", "v.cwsg"), set("v.cwsx", "v.cwnx"), set("v.cwsz", "v.cwnz"),
  ];
}
// Rows CLAMP_ROW.. collide in one shared loop (the per-particle code would not fit): load the
// particle, test its cell against the cached ring, leave a solid cell through the face it
// crossed since the last step (toward the player's own foot cell, never solid, if it was
// already inside: pushing up climbed stacked blocks and stretched the cape), clamp to the floor
// plane, push out of another player's body, and write back only if something moved it.
const colliders = free.filter(({ r }) => r >= CLAMP_ROW).map(({ i }) => i);
const choose = (idx, vals, s = 0) => { if (vals.length === 1) return vals[0]; const h = vals.length >> 1;
  return `(${idx}<${s + h}?${choose(idx, vals.slice(0, h), s)}:${choose(idx, vals.slice(h), s + h)})`; };
const dispatch = (idx, vals, fn, s = 0) => { if (vals.length === 1) return fn(vals[0]); const h = vals.length >> 1;
  return when(`${idx}<${s + h}`, dispatch(idx, vals.slice(0, h), fn, s), dispatch(idx, vals.slice(h), fn, s + h)); };
function contacts() {
  if (!colliders.length) return [];
  // Molang's math.min takes exactly two arguments (a three-argument call broke the whole
  // expression in game), so the lowest hem probe is nested.
  const gap = num(WALL_GAP), px = num(PX), low = hemProbe.map(i => P(i, "y")).reduce((a, b) => `math.min(${a},${b})`);
  return when(`v.cwtb>0||t.vn||${low}<v.cwfl+4`, [set("t.ci", 0), loop(colliders.length, [
    AX.map(a => [set("t.p" + a, choose("t.ci", colliders.map(i => P(i, a)))), set("t.q" + a, choose("t.ci", colliders.map(i => Q(i, a))))]),
    set("t.ch", 0), AX.map(a => set("t.za" + a, `math.floor((t.p${a}-v.cwo${a})/${px})`)),
    when("math.abs(t.zax)<2&&math.abs(t.zaz)<2&&t.zay>=0&&t.zay<2&&math.mod(math.floor(v.cwtb/math.pow(2,(t.zay*3+t.zaz+1)*3+t.zax+1)),2)", [
      AX.map(a => set("t.zb" + a, `math.floor((t.q${a}-v.cwo${a})/${px})`)),
      set("t.zf", "t.zbx==t.zax&&t.zby==t.zay&&t.zbz==t.zaz"),
      AX.map(a => set("t.zb" + a, `t.zf?0:t.zb${a}`)),
      // Candidate exit on each crossed axis; only the shallowest is taken (pushing every
      // crossed axis snapped a particle that grazed a corner onto its edge).
      AX.map(a => [set("t.zc" + a, `t.zb${a}>t.za${a}?v.cwo${a}+(t.za${a}+1)*${px}+${gap}:t.zb${a}<t.za${a}?v.cwo${a}+t.za${a}*${px}-${gap}:t.p${a}`),
        set("t.zd" + a, `t.zb${a}==t.za${a}?1000000:math.abs(t.zc${a}-t.p${a})`)]),
      set("t.zm", "math.min(t.zdx,math.min(t.zdy,t.zdz))"), AX.map(a => when(`t.zd${a}==t.zm`, set("t.p" + a, "t.zc" + a))),
      set("t.ch", 1)]),
    when("t.py<v.cwfl", [set("t.py", "v.cwfl"), set("t.ch", 1)]),
    when("t.vn", [set("t.yx", "t.px-t.vcx"), set("t.yz", "t.pz-t.vcz"), set("t.yd", "math.sqrt(t.yx*t.yx+t.yz*t.yz)"),
      when(`t.yd<${num(VIEWER_R * PX)}&&t.yd>0.001&&t.py>t.vcy&&t.py<t.vcy+${num(VIEWER_H * PX)}`,
        [set("t.px", `t.vcx+t.yx*${num(VIEWER_R * PX)}/t.yd`), set("t.pz", `t.vcz+t.yz*${num(VIEWER_R * PX)}/t.yd`), set("t.ch", 1)])]),
    when("t.ch", dispatch("t.ci", colliders, i => AX.map(a => set(P(i, a), "t.p" + a)))),
    set("t.ci", "t.ci+1"),
  ])]);
}

// A free particle back into body-local coordinates (G is orthonormal, so G^-1 = G^T).
// Runs inside bone channels, once per particle per frame behind its own stamp.
const toLocal = i => when(`(v.cu${key(i)}t??-1)!=v.cwst`, [AX.map(a => set("t.d" + a, `${P(i, a)}-v.cwk${a}`)),
  AX.map((a, k) => set(U(i, a), `v.cwg0${k}*t.dx+v.cwg1${k}*t.dy+v.cwg2${k}*t.dz${a === "y" ? "+24" : ""}`)), set(`v.cu${key(i)}t`, "v.cwst")]);

// Each cell is a parallelogram fitted to its four corners: outer bone = rotation U and
// offset, middle bone = in-plane scale, inner bone = in-plane rotation (closed-form 2x2 SVD).
function cell(r, c) {
  const A = pid(r, c), B = pid(r, c + 1), C = pid(r + 1, c), D = pid(r + 1, c + 1);
  const cv = (i, a) => !isPinned(i) ? U(i, a) : a === "x" ? num(restX(i)) : a === "y" ? "24" : `(${num(ZMID)}+v.cwaz)`;
  const pivot = [restX(c) + W / 2, restY(r) - H / 2, ZMID];
  return [
    [A, B, C, D].filter(i => !isPinned(i)).map(toLocal),
    AX.map(a => set("t.m" + a, `(${cv(A, a)}+${cv(B, a)}+${cv(C, a)}+${cv(D, a)})*.25`)),
    AX.map(a => set("t.h" + a, `(${cv(B, a)}-${cv(A, a)}+${cv(D, a)}-${cv(C, a)})*${num(1 / (2 * W))}`)),
    AX.map(a => set("t.i" + a, `(${cv(A, a)}-${cv(C, a)}+${cv(B, a)}-${cv(D, a)})*${num(1 / (2 * H))}`)),
    set("t.la", "math.max(math.sqrt(t.hx*t.hx+t.hy*t.hy+t.hz*t.hz),0.0001)"),
    AX.map(a => set("t.f" + a, `t.h${a}/t.la`)),
    set("t.lb", "t.ix*t.fx+t.iy*t.fy+t.iz*t.fz"),
    AX.map(a => set("t.i" + a, `t.i${a}-t.lb*t.f${a}`)),
    set("t.ld", "math.max(math.sqrt(t.ix*t.ix+t.iy*t.iy+t.iz*t.iz),0.0001)"),
    AX.map(a => set("t.k" + a, `t.i${a}/t.ld`)),
    set("t.se", "(t.la+t.ld)*.5"), set("t.sf", "(t.la-t.ld)*.5"), set("t.sg", "t.lb*.5"),
    set("t.sq", "math.sqrt(t.se*t.se+t.sg*t.sg)"), set("t.sw", "math.sqrt(t.sf*t.sf+t.sg*t.sg)"),
    set("t.a1", "math.atan2(t.sg,t.sf)"), set("t.a2", "math.atan2(-t.sg,t.se)"),
    set("t.ph", "(t.a2+t.a1)*.5"), set("t.cp", "math.cos(t.ph)"), set("t.sp", "math.sin(t.ph)"),
    set("t.u0", "t.cp*t.fx+t.sp*t.kx"), set("t.u1", "t.cp*t.fy+t.sp*t.ky"), set("t.u2", "t.cp*t.fz+t.sp*t.kz"),
    set("t.u3", "t.cp*t.kz-t.sp*t.fz"), set("t.u4", "t.fx*t.ky-t.fy*t.kx"),
    set(CV(r, c, "rx"), "-math.atan2(t.u3,t.u4)"), set(CV(r, c, "ry"), "math.asin(math.clamp(-t.u2,-1,1))"),
    set(CV(r, c, "rz"), "-math.atan2(t.u1,t.u0)"),
    AX.map((a, k) => set(CV(r, c, "p" + a), `t.m${a}-${num(pivot[k])}`)),
    set(CV(r, c, "sx"), "t.sq+t.sw"), set(CV(r, c, "sy"), "t.sq-t.sw"), set(CV(r, c, "iz"), "(t.a1-t.a2)*.5"),
  ];
}
const VISIBLE = "q.has_cape&&!(v.is_first_person??0)&&!(v.map_face_icon??0)&&!q.is_spectator&&!q.is_item_name_any('slot.armor.chest',0,'minecraft:elytra')";

// Bedrock errors on reading a variable that was never set, so every persistent variable
// gets a value once, behind the same (v.x??0) guard old/ used. Stamps start at -1.
export function initDefaults() {
  const text = toMolang(body()) + channels().map(ch => toMolang(ch.nodes) + ch.value).join("");
  // Cell outputs (v.cc) and body-local particles (v.cu) are only read behind ?? or after
  // being written in the same expression, so they need no defaults.
  const names = [...new Set([...text.matchAll(/\bv\.(c[wpq][a-z0-9]*)/g)].map(m => m[1]))].filter(n => n !== "cwin");
  return Object.fromEntries(names.sort().map(n => [n, n === "cwlt" ? -1 : 0]));
}

export const program = () => flat(
  when("!(v.cwin??0)", [Object.entries(initDefaults()).map(([n, x]) => set("v." + n, x)), set("v.cwin", 1)]),
  body());

// UI and paperdoll passes only read v.cwon=0 and render the rest pose; they never touch sim state.
function body() {
  return flat(
    set("v.cwaz", "q.get_root_locator_offset('armor_offset.default_neck',1)"),
    set("v.cwon", 0),
    when("!q.is_in_ui&&!(v.is_paperdoll??0)", [
      // Bone queries fail until the geometry has been evaluated: like old/, wait 0.1 s
      // after the cape becomes visible before the first q.bone_orientation_trs.
      when(VISIBLE, when("v.cwwu<0.1", [set("v.cwwu", "v.cwwu+math.clamp(q.delta_time,0,0.05)"), set("v.cwok", 0)],
        // v.cwlt guards against a second evaluation in the same frame; v.cwst counts the
        // frames that moved the cloth, and bone channels only recompute when it changes.
        when("q.life_time!=v.cwlt", [
          set("v.cwlt", "q.life_time"), origin(), env(), wind(),
          when("t.sr", set("v.cwac", 0)), schedule(),
          when("t.sr||t.n>0", [frame(),
            // Asleep: skip the step (the cells stay cached) until an anchor or a leg moves.
            when("t.sr", [reset(), set("v.cwqt", 0), set("v.cwst", "v.cwst+1")], when(`v.cwqt<${SLEEP_FRAMES}||${wake()}`, [
              when(`v.cwqt>=${SLEEP_FRAMES}`, set("v.cwqt", 0)), step(), set("v.cwst", "v.cwst+1")]))]),
          set("v.cwok", 1),
        ])), [set("v.cwok", 0), set("v.cwwu", 0)]),
      set("v.cwon", "v.cwok"),
    ]),
  );
}
export const boneNames = (r, c) => ({ outer: `cloth_${r}_${c}`, mid: `cloth_${r}_${c}_s`, mesh: `cloth_${r}_${c}_m` });
const each = fn => Array.from({ length: ROWS }, (_, r) => Array.from({ length: COLS }, (_, c) => fn(r, c))).flat();
const round = n => Math.round(n * 1e6) / 1e6;

// Every live channel of a cell carries the full cell math behind a per-frame stamp: the
// first channel Bedrock evaluates computes the cell, the rest read the cached values.
// This does not depend on channel order and keeps anim_time_update under the size limit.
export function channels() {
  const list = [];
  each((r, c) => {
    const n = boneNames(r, c), f = k => CV(r, c, k);
    // Reads here use ?? so a channel evaluated before the first anim_time_update cannot error.
    const nodes = flat(when(`(v.cwon??0)&&(${f("lt")}??-1)!=(v.cwst??-2)`, [cell(r, c), set(f("lt"), "v.cwst")]));
    const add = (bone, channel, axis, field, off) => list.push({ bone, channel, axis, r, c, field, nodes,
      value: `(v.cwon??0)?(${f(field)}??${off}):${off}` });
    const dy = num(restY(r) - H / 2 - 24), vr = "(6+126*q.cape_flap_amount)";
    ["rx", "ry", "rz"].forEach((k, axis) => add(n.outer, "rotation", axis, k, axis === 0 ? vr : 0));
    ["px", "py", "pz"].forEach((k, axis) => add(n.outer, "position", axis, k,
      [0, `${dy}*(math.cos(${vr})-1)`, `((v.cwaz??0)-${dy}*math.sin(${vr}))`][axis]));
    add(n.mid, "scale", 0, "sx", 1); add(n.mid, "scale", 1, "sy", 1);
    add(n.mesh, "rotation", 2, "iz", 0);
  });
  return list;
}

export function bones() {
  const out = {};
  for (const ch of channels()) {
    const bone = out[ch.bone] ??= {};
    const values = bone[ch.channel] ??= ch.channel === "scale" ? [1, 1, 1] : [0, 0, 0];
    values[ch.axis] = `${toMolang(ch.nodes)}return ${ch.value};`;
  }
  return out;
}

// UVs reproduce _sample, whose cape bone is turned 180° about y; our cells are not, so:
// outer (south) face u = 6 - x and inner (north) face u = 17 + x across the cape (south u
// runs toward -x, north toward +x), and the 1px top/bottom strips are the sample's turned
// by 180° (u and v both flipped). Side strips: see the east/west note below.
// Each cell reaches OVERLAP px past its interior edges into its neighbours, with the UVs
// extended by the same amount, so the overlap shows the neighbour's own texels (invisible
// when flat) and covers the cracks a bend or an imperfect parallelogram fit opens.
// The cape's outer border is never extended. Pivots and the fit stay on the rest cell.
export const OVERLAP = envNum("OVERLAP", 0.75);  // sweep: 0.5 left 3.4% cracked frames (leg swing), 0.6 none; 0.75 for margin
export function geometry() {
  const list = [{ name: "root", pivot: [0, 0, 0] }, { name: "waist", parent: "root", pivot: [0, 12, 0] },
    { name: "body", parent: "waist", pivot: [0, 24, 0] }];
  each((r, c) => {
    const n = boneNames(r, c), x0 = restX(c), y1 = restY(r), v0 = 1 + r * H;
    const L = c > 0 ? OVERLAP : 0, Rt = c < COLS - 1 ? OVERLAP : 0, T = r > 0 ? OVERLAP : 0, B = r < ROWS - 1 ? OVERLAP : 0;
    const w = W + L + Rt, h = H + T + B, vt = round(v0 - T);
    const pivot = [round(x0 + W / 2), round(y1 - H / 2), ZMID];
    const uv = {
      north: { uv: [round(17 + x0 - L), vt], uv_size: [round(w), round(h)] },
      south: { uv: [round(6 - x0 - W - Rt), vt], uv_size: [round(w), round(h)] },
    };
    // Bedrock names faces in mirrored x: "east" is the -x side, "west" the +x side (in game,
    // a "west" face on the leftmost column was hidden inside the cape). _sample's turned cape
    // puts its u 0 strip on our +x edge and the u 11 strip on our -x edge.
    if (c === 0) uv.east = { uv: [11, vt], uv_size: [1, round(h)] };
    if (c === COLS - 1) uv.west = { uv: [0, vt], uv_size: [1, round(h)] };
    if (r === 0) uv.up = { uv: [round(6 - x0 + L), 0], uv_size: [round(-w), 1] };
    uv.down = { uv: [round(16 - x0 + L), 0], uv_size: [round(-w), 1] };  // every row: a burnt hem shows a closed edge
    list.push({ name: n.outer, parent: "body", pivot }, { name: n.mid, parent: n.outer, pivot },
      { name: n.mesh, parent: n.mid, pivot, cubes: [{ origin: [round(x0 - L), round(y1 - H - B), 2], size: [round(w), round(h), 1], uv }] });
  });
  return { format_version: "1.12.0", "minecraft:geometry": [{
    description: { identifier: "geometry.cape", texture_width: 64, texture_height: 32,
      visible_bounds_width: 3, visible_bounds_height: 3.5, visible_bounds_offset: [0, 1.25, 0] },
    bones: list }] };
}

// Row r of the cloth is gone once the hem has burnt past it (variable.cwbn rows, unset = 0).
export const burnShows = r => `(variable.cwbn ?? 0) < ${ROWS - r}`;

// Same visibility rule as _sample, applied to every cube bone.
export function renderController() {
  const show = "query.armor_texture_slot(1) != 5 && (!variable.is_first_person || variable.is_paperdoll) && !variable.map_face_icon && !query.is_spectator";
  return { format_version: "1.8.0", render_controllers: { "controller.render.player.cape": {
    rebuild_animation_matrices: true, geometry: "Geometry.cape", materials: [{ "*": "Material.cape" }], textures: ["Texture.cape"],
    part_visibility: [Object.fromEntries(each((r, c) => [boneNames(r, c).mesh, r < ROWS - BURN_ROWS ? show : `${show} && ${burnShows(r)}`]))],
    is_hurt_color: { r: 0, g: 0, b: 0, a: 0 } } } };
}
export const sections = () => ({ origin: origin(), frame: frame(), reset: reset(), step: step(), cell: cell(1, 1) });
