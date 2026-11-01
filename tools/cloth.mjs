// Cloth cape: a pinned PBD particle grid simulated inside animation.player.cape.
// Frames, all in model pixels:
//   body-local = geometry coordinates of the rest body (pivot 0,24,0)
//   sim        = world axes, origin at the rebased block position v.cwb
// G = Y*R maps body-local offsets into sim. R is the animated body rotation from
// q.bone_orientation_trs; Y is the yaw and z flip used by Simple Ragdoll's boneOutput.
import { set, when, loop, flat, num, toMolang, cacheConstants } from "./molang.mjs";
import { BURN_END, burnOrders, burnClock, burnCell, burnVar, burning } from "./burn.mjs";

import { COLS, ROWS, W, H, depth, pid, restX, restY, tiles } from "./grid.mjs";
export { COLS, ROWS, W, H, pid, restX, restY } from "./grid.mjs";
export const ZMID = 2.5;                 // cape mid-plane at rest (cube z 2..3)
const PX = 16 / 0.9375;                  // model pixels per block at the vanilla player scale
const MARGIN = 0.5, HIP_Y = 12;          // half thickness; legs only push rows below the hip
const CHEST_CLEARANCE = 0.5;            // extra room for the fitted cloth over chest armour
const CHEST_HEM_GUARD = 1;             // collision allowance, independent of visual overlap
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
// A&S player terrain candidates include shears as well as the four tool groups.
// These tags identify materials, not collision shapes; support is resolved below.
const SOLID = "'minecraft:is_axe_item_destructible','minecraft:is_hoe_item_destructible','minecraft:is_pickaxe_item_destructible','minecraft:is_shovel_item_destructible','minecraft:is_shears_item_destructible','not_feature_replaceable'";
// Cloth stops this many px short of a block face. VIEWER: radius and height (blocks) of
// another player's body as seen from their camera, for pushing this cape.
const WALL_GAP = 0.5, VIEWER_R = 0.35, VIEWER_H = 1.8;
export const CLAMP_ROW = envNum("CLAMP_ROW", 2); // rows from here down collide with terrain (row 1 sits on the back)
// Wind, blocks per second. Base speed drifts over minutes; gusts come every few seconds and
// grow in rain and cold biomes; WIND_CALM is the dead zone for sheltered cloth.
// Halved after the first in-game test: everyday wind should only just lift a cape facing
// into it, and rain at 1.0 blew it flat.
const WIND = envNum("WIND", 0.5), WIND_RAIN = 2.5, WIND_CALM = 0.15, AIR_MAX = 6;
// Fluids: velocity kept per 60 Hz step and the share of gravity left after buoyancy.
// Fire: the heat (0..1) takes HEAT_LIFT of the weight off the cape and makes it billow (sweep:
// lift above 1 flips the cape over the head, flutter 4 opens 2 px seams; 1 and 2 lift the hem
// about 6 px with 0.8 px seams). Burning tiles are animated in burn.mjs; hidden
// rows are removed from collision and load-bearing constraints.
const HEAT_LIFT = envNum("HEAT_LIFT", 1), HEAT_FLUTTER = envNum("HEAT_FLUTTER", 2);
const WATER_DRAG = envNum("WATER_DRAG", 0.8), WATER_G = envNum("WATER_G", -0.05), LAVA_DRAG = 0.6, LAVA_G = 0.05;

const canBurn = (r,c) => burnOrders.some(order => order.some(tile => tile.r===r && tile.c===c));
const NP = (ROWS + 1) * (COLS + 1);
if (NP > 36 || ROWS * COLS > 36) throw new Error("grid too large for one-character keys");
const key = i => i.toString(36);
const AX = ["x", "y", "z"];
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
  if (r < ROWS) links.push([pid(r, c), pid(r + 1, c), H(r)]);
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
const TORSO = ["t.g02", "t.g12", "t.g22"], RLEG = ["t.rnx", "t.rny", "t.rnz"], LLEG = ["t.lnx", "t.lny", "t.lnz"];
// Local cuboids follow the same native bone TRS -> simulation transform as the legs.
// The arm includes the hand; the centre is offset from the shoulder pivot.
const UPPER = [
  { bone: 'rightarm', centre: [-1,-4,0], half: [2,6,2] },
  { bone: 'leftarm', centre: [1,-4,0], half: [2,6,2] },
];
function upperFrames() {
  return [UPPER.map(({bone,centre,half},i) => [
    set('t.limb', `q.bone_orientation_trs('${bone}')`), euler('t.limb'),
    [0,1,2].map(j => yawMap(`(${R[0][j]})`, `(${R[1][j]})`, `(${R[2][j]})`)
      .map((e,k) => set(`t.u${i}${k}${j}`,e))),
    [0,1,2].map(j=>set('t.side'+j,TORSO.map((n,k)=>`t.u${i}${k}${j}*${n}`).join('+'))),
    set(`t.u${i}face`,'math.abs(t.side0)>math.abs(t.side1)?(math.abs(t.side0)>math.abs(t.side2)?0:2):(math.abs(t.side1)>math.abs(t.side2)?1:2)'),
    set(`t.u${i}sign`,`(t.u${i}face==0?t.side0:t.u${i}face==1?t.side1:t.side2)<0?-1:1`),
    simPoint('t.up','t.limb'),
    AX.map((a,k) => set(`t.u${i}${a}`, `t.up${a}`+centre.map((x,j)=>x?`+t.u${i}${k}${j}*${num(x)}`:'').join(''))),
    // A cheap world AABB rejects most points before doing the oriented test.
    AX.map((a,k)=>[set('t.extent',half.map((h,j)=>`math.abs(t.u${i}${k}${j})*${num(h+0.4)}`).join('+')),
      set(`t.u${i}lo${a}`,`t.u${i}${a}-t.extent`),set(`t.u${i}hi${a}`,`t.u${i}${a}+t.extent`)]),
  ]), AX.map(a=>['lo','hi'].map((bound,k)=>set('t.upper'+bound+a,
    `math.${k?'max':'min'}(t.u0${bound}${a},t.u1${bound}${a})`)))];
}
// Interpolate the tick-stepped actor position, as Simple Ragdoll's anchorPrograms(). A
// player's q.position(1) is the eye, 1.62 above the feet (VanillaRagdoll's player rig
// subtracts it too); everything here works from the feet.
export const EYE = 1.62;
const feetY = `(q.position(1)-${EYE})`;
// A&S samples actual displacement over >0.1 s and smooths riding speed with
// 1-exp(-6*dt). Its cape stops receiving movement after 0.1 s without a sample.
// Preserve the full world-space velocity: A&S projects it onto the mount's
// heading for pitch/roll; our body frame already converts all three axes.
// Our particles need translation, rather than A&S's cape pitch: move the sim
// base by raw displacement minus that smooth motion. This carries sampling
// jumps with the rider without feeding them into cloth inertia. Terrain and
// fluid caches follow the same base change, retaining their real world positions.
function ridingOrigin(e) {
  return [
    when('t.sr', [set('v.cwride_clock', 'q.life_time'), set('v.cwride_age', 0),
      AX.map((a,k) => [set('v.cwp'+a, e(k)), set('v.cwl'+a, 0)]), set('v.cwvy', 0)]),
    set('v.cwride_age', 't.j>0?0:v.cwride_age+q.delta_time'),
    set('t.rs', 'q.life_time-v.cwride_clock'),
    when('t.rs>0.1&&t.j>0', [
      AX.map((a,k) => [set('v.cwl'+a, `(${e(k)}-v.cwp${a})/t.rs`), set('v.cwp'+a,e(k))]),
      set('v.cwride_clock', 'q.life_time')]),
    set('t.rf', '1-math.exp(-6*q.delta_time)'),
    set('t.rm', 'v.cwride_age<0.1'),
    AX.map((a,k) => [
      set('v.cwv'+a, `math.lerp(v.cwv${a},v.cwl${a}*t.rm,t.rf)`),
      when('!t.sr', [set('t.rc', `t.r${a}-v.cwc${a}-v.cwv${a}*q.delta_time`),
        set('v.cwb'+a, `v.cwb${a}+t.rc`),
        set('t.rc', `t.rc*${num(PX)}`), set('v.cwo'+a, `v.cwo${a}-t.rc`),
        a==='y' ? [set('v.cwfl', 'v.cwfl-t.rc'), set('v.cwfh', 'v.cwfh-t.rc')] : []]),
      set('v.cwc'+a,e(k))]),
  ];
}
function origin() {
  const e = k => 't.r'+AX[k];
  return [
    AX.map((a,k) => set('t.r'+a,k===1?feetY:`q.position(${k})`)),
    set("t.now", "math.floor(q.life_time*20+0.001)"),
    set("t.j", `math.abs(${e(0)}-v.cwcx)+math.abs(${e(1)}-v.cwcy)+math.abs(${e(2)}-v.cwcz)`),
    // Also reset far from the base so sim coordinates stay small (float precision).
    set("t.sr", `!v.cwok||q.is_riding!=v.cwride||q.delta_time>0.25||t.j>8||math.abs(${e(0)}-v.cwbx)+math.abs(${e(2)}-v.cwbz)>${REBASE}`),
    set('v.cwride', 'q.is_riding'),
    set("t.tk", "t.sr||t.now!=v.cwtk"),  // a new game tick: per-tick sampling below
    when('v.cwride', ridingOrigin(e), [
      when("t.sr||t.now<v.cwtk||t.now-v.cwtk>1", AX.map((a,k) => set('v.cwp'+a,e(k))),
        when("t.now!=v.cwtk", AX.map(a => set("v.cwp" + a, "v.cwc" + a)))),
      AX.map((a, k) => [set("v.cwc" + a, e(k)), set("t.r" + a, `math.lerp(v.cwp${a},v.cwc${a},math.clamp(q.frame_alpha,0,1))`)]),
    ]),
    set('v.cwtk', 't.now'),
    when("t.sr", [AX.map(a => [set("v.cwb" + a, "t.r" + a), set("v.cwl" + a, `v.cwride?0:t.r${a}`)]), set("v.cwvx", 0), set("v.cwvz", 0), set("v.cwh", 0)]),
    AX.map(a => set("t.o" + a, `(t.r${a}-v.cwb${a})*${num(PX)}`)),
    // Smoothed body velocity (blocks/s); flutter follows horizontal speed relative to the wind.
    when('!v.cwride', [
      AX.map(a => set("v.cwv" + a, `math.lerp(v.cwv${a},math.clamp((t.r${a}-v.cwl${a})/math.max(q.delta_time,0.001),-8,8),math.clamp(q.delta_time*8,0,1))`)),
      AX.map(a => set("v.cwl" + a, "t.r" + a)),
    ]),
  ];
}

// Cached 3x3 terrain ring, absolute feet coordinates (player queries are eye-based).
// A&S player pre_animation uses grounded height and the 0.2001 edge test to find
// supporting cells under the 0.6-block player footprint, including adjacent cells.
// We use that evidence for cape contacts: occupied foot cells cannot be full walls
// above the feet. Keep observed support cells while moving at the same grounded
// height, so crossing a cell boundary does not recreate a wall behind the cape.
// This is a local surface approximation, not a query of slab/stair/door block state.
// Bits 0-17: foot level and one up; 18: ceiling. Sample 19 supplies the floor plane.
const RING = 20, OWN = [4, 13];
function env() {
  const bit = n => `math.mod(math.floor(v.cwtb/${2 ** n}),2)`;
  return [
    AX.map((a, k) => set("t.e" + a, `math.floor(${k === 1 ? feetY : `q.position(${k})`})`)),
    ["x", "z"].map((a, k) => [set("t.f" + a, `q.position(${k * 2})-t.e${a}-0.5`),
      set("t.f" + a, `math.abs(t.f${a})>0.2001?(t.f${a}>0?1:-1):0`)]),
    set("v.cwtt", "v.cwtt+math.clamp(q.delta_time,0,0.1)"),
    when(`t.sr||v.cwtt>1||t.ex!=v.cwex||t.ey!=v.cwey||t.ez!=v.cwez||q.is_on_ground!=v.cp_grounded||(q.is_on_ground&&(((t.fx!=v.cp_fx||t.fz!=v.cp_fz)&&${feetY}>t.ey+0.001)||math.abs(${feetY}-v.cp_fy)>0.001))`, [
      set("t.sm", `!t.sr&&q.is_on_ground&&v.cp_grounded&&math.abs(${feetY}-v.cp_fy)<0.001?v.cp_support:0`),
      set("t.sx", "t.ex-v.cwex"), set("t.sz", "t.ez-v.cwez"), set("v.cp_support", 0),
      set("v.cp_fx", "t.fx"), set("v.cp_fz", "t.fz"), set("v.cp_fy", feetY),
      AX.map(a => set("v.cwe" + a, "t.e" + a)), set("v.cwtt", 0), set("v.cwtb", 0), set("v.cp_platform", 0), set("t.i", 0),
      set("v.cp_grounded", "q.is_on_ground"),
      // The combined snow + shovel test is also used by A&S to distinguish snow
      // from another surface at the same height. Never flatten unrelated stone.
      set("v.cp_on_snow", "v.cp_grounded&&q.block_has_all_tags(t.ex,t.ey,t.ez,'snow','minecraft:is_shovel_item_destructible')"),
      loop(RING, [
        set("t.dx", "t.i<18?math.mod(t.i,3)-1:0"), set("t.dz", "t.i<18?math.mod(math.floor(t.i/3),3)-1:0"),
        set("t.dy", "t.i==19?-1:math.floor(t.i/9)"),
        // A&S also distinguishes rail and one_way_collidable tags. For cloth,
        // rails have no solid face; one-way cells only catch a fall from above.
        set("t.solid", `t.i!=${OWN[1]}&&q.block_has_any_tag(t.ex+t.dx,t.ey+t.dy,t.ez+t.dz,${SOLID})`),
        when("t.solid", set("t.solid", "q.block_has_any_tag(t.ex+t.dx,t.ey+t.dy,t.ez+t.dz,'rail')?0:(q.block_has_any_tag(t.ex+t.dx,t.ey+t.dy,t.ez+t.dz,'one_way_collidable')?2:1)")),
        when("t.i==19", set("v.cwfl", `t.solid?(t.ey-v.cwby)*${num(PX)}+${num(MARGIN)}:-1000000`),
          when("t.solid==2", set("v.cp_platform", "v.cp_platform+math.pow(2,t.i)"), when("t.solid", [
            set("t.support", "t.dy==0&&v.cp_grounded&&((t.dx==0||t.dx==t.fx)&&(t.dz==0||t.dz==t.fz)||(math.abs(t.dx+t.sx)<2&&math.abs(t.dz+t.sz)<2&&math.mod(math.floor(t.sm/math.pow(2,(t.dz+t.sz+1)*3+t.dx+t.sx+1)),2))||(v.cp_on_snow&&q.block_has_all_tags(t.ex+t.dx,t.ey,t.ez+t.dz,'snow','minecraft:is_shovel_item_destructible')))"),
            when("t.support", set("v.cp_support", "v.cp_support+math.pow(2,t.i)"),
              when(`t.i!=${OWN[0]}`, set("v.cwtb", "v.cwtb+math.pow(2,t.i)"))),
          ]))), set("t.i", "t.i+1"),
      ]),
      // Wind exposure one block up: +x, +z, -x, -z neighbours and the ceiling.
      [14, 16, 12, 10].map((n, d) => set("v.cwj" + d, bit(n))), set("v.cwce", bit(18)),
      // Cell origin of the ring in sim pixels, for the per-particle lookup.
      AX.map(a => set("v.cwo" + a, `(t.e${a}-v.cwb${a})*${num(PX)}`)),
    ]),
    // Ground contact gives an observed surface for snow, slabs, stairs, beds,
    // fences, etc. Update within a cell too; airborne queries use the cached floor.
    when("v.cp_grounded", set("v.cwfl", `(${feetY}-v.cwby)*${num(PX)}+${num(MARGIN)}`)),
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
      set("v.cwsg", "v.cwtb+v.cwwe*1048576+(v.cwht>0)*2097152"),
    ]),
  ];
}

// World wind from the level clock, so every client sees the same direction. Per tick:
// Cold biomes always use the rain strength, without relying on snow counting as rain.
// Other biomes use the rain query. Both share the same gradual strength transition;
// then the blocks around the player shape it: a wall upwind shelters, walls on both sides
// of a gap channel it along the gap, a roof keeps only a corridor's draft, height adds.
function wind() {
  const cos = x => `math.cos(${x})`, sin = x => `math.sin(${x})`;
  return [
    when("t.tk", [
      set("t.ts", "math.mod(q.time_stamp,1000000)"),
      set("t.wa", `t.ts*0.041+${sin("t.ts*0.023")}*120`),
      set("v.cwrn", `math.clamp(v.cwrn+(((q.entity_biome_has_any_tags('cold','frozen')||q.is_in_water_or_rain)&&!q.is_in_water)?0.05:-0.003),0,1)`),
      set("t.ws", `${num(WIND)}*(0.9+0.5*${sin("t.ts*0.07")}+math.max(${sin("t.ts*1.9")}*${sin("t.ts*0.67")},0)*(0.8+1.6*v.cwrn))` +
        `*(1+${num(WIND_RAIN - 1)}*v.cwrn)`),
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
    leg("t.rl", "rightleg", "r"), leg("t.ll", "leftleg", "l"), upperFrames(),
    AX.map((a, k) => set("t.a" + a, `t.b${a}+t.g${k}2*(${num(ZMID)}+v.cwaz)`)),
    // Target anchors; step() moves the persistent top row toward them across substeps.
    Array.from({ length: COLS + 1 }, (_, c) => AX.map((a, k) => set(AN(c, a), `t.a${a}+t.g${k}0*${num(restX(c))}`))),
  ];
}
const AN = (c, a) => `t.an${key(c)}${a}`;
const pinnedIds = Array.from({ length: COLS + 1 }, (_, c) => c);

const reset = () => [pinnedIds.map(c => AX.map(a => set(P(c, a), AN(c, a)))),
  // Previous positions are not reset: v.cwh = 0 makes the next step use zero velocity.
  free.map(({ i, r, c }) => AX.map((a, k) => set(P(i, a), `${P(c, a)}-t.g${k}1*${num(depth(r))}`)))];

// Snapshot tile attachment before solving, independent of bone channel order.
const attached = (r, c) => r < 0 || r >= ROWS || c < 0 || c >= COLS ? '0' : r === 0 ? '1' : `v.ct${key(r * COLS + c)}`;
// Fixed shoulders and out-of-grid neighbours are constants. Molang only allows
// a variable on the left of ??, so fold those visibility bits at generation time.
const attachmentBit = (r, c, bit) => {
  const value = attached(r, c);
  return value === '0' ? '0' : value === '1' ? String(bit) : `(${value}??1)>0.99?${bit}:0`;
};
const mass = i => `v.cm${key(i)}`;
function material() {
  return [set('v.cwchange', 0), when('t.sr||v.cwdirty', [
    set('v.cwdirty',0), tiles.filter(({ r }) => r > 0).map(({ r, c }) => set(attached(r, c), `(${burnVar(r,c,'attach')}??1)`)),
    free.map(({ i, r, c }) => {
      const cells = [[r-1,c-1],[r-1,c],[r,c-1],[r,c]].filter(([rr,cc]) => rr >= 0 && rr < ROWS && cc >= 0 && cc < COLS);
      return [set('t.mass', cells.map(([rr,cc]) => `${attached(rr,cc)}*${num(W*H(rr)/4)}`).join('+')),
        set('v.cwchange', `v.cwchange+math.abs((${mass(i)}??0)-t.mass)`),
        set(`v.cn${key(i)}`, `(${mass(i)}??0)<0.001&&t.mass>=0.001`), set(mass(i), 't.mass')];
    }), smoothWeights(), links.map(([a,b],i)=>[linkStrength(a,b)==='1'?[]:set('v.cl'+key(i),linkStrength(a,b)),isPinned(a)?[]:set('v.cd'+key(i),mass(a)+'+'+mass(b))]), when('v.cwchange>0.001',set('v.cwqt',0)),
  ])];
}
function linkStrength(a,b) {
  const ar=Math.floor(a/(COLS+1)), ac=a%(COLS+1), br=Math.floor(b/(COLS+1));
  const pair=ar===br?[attached(ar-1,ac),attached(ar,ac)]:[attached(ar,ac-1),attached(ar,ac)];
  return pair.includes('1')?'1':pair[0]==='0'?pair[1]:pair[1]==='0'?pair[0]:`math.max(${pair[0]},${pair[1]})`;
}
function constraint([a,b,len,stiffness=1],index) {
  const pinned=isPinned(a),fixed=linkStrength(a,b)==='1',strength='v.cl'+key(index);
  const solve=[
    AX.map(x=>set('t.d'+x,P(b,x)+'-'+P(a,x))),
    set('t.e','(1-'+num(len)+'/math.max(math.sqrt(t.dx*t.dx+t.dy*t.dy+t.dz*t.dz),0.0001))'+(fixed?'':'*'+strength)+(stiffness===1?'':'*'+num(stiffness))),
    pinned?[]:[set('t.ea','t.e*'+mass(b)+'/v.cd'+key(index)),set('t.e','t.e-t.ea')],
    AX.map(x=>[pinned?[]:set(P(a,x),P(a,x)+'+t.d'+x+'*t.ea'),
      set(P(b,x),P(b,x)+'-t.d'+x+'*t.e')])
  ];
  return fixed?solve:when(strength+'>0.001',solve);
}
// A reappearing point starts below its attached neighbour with zero old velocity.
// Hidden points only follow this frame, without gravity, collisions or constraints.
function seedDetached() {
  return free.map(({i,r,c}) => when(`v.cn${key(i)}||${mass(i)}<0.001`, [
    AX.map((a,k) => [set(P(i,a), `${P(pid(r-1,c),a)}-t.g${k}1*${num(H(r-1))}`),set(Q(i,a),P(i,a))]),
    set(`v.cn${key(i)}`,0)]));
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
const upperPose = UPPER.flatMap((_,i)=>[...AX,...[0,1,2].flatMap(k=>[0,1,2].map(j=>`${k}${j}`))].map(k=>`u${i}${k}`));
// Drift of the persistent top row from its anchors, plus leg movement since the last step.
// Blocks, fluids and wind are compared with their values at the last step.
const wake = () => [...pinnedIds.flatMap(c => AX.map(a => `math.abs(${P(c, a)}-${AN(c, a)})`)),
  ...upperPose.map(k=>`math.abs(t.${k}-v.cw${k})`),
  `math.abs(${legSig[0]}-v.cwrs)`, `math.abs(${legSig[1]}-v.cwls)`, "math.abs(v.cwsg-v.cwss)",
  // Moisture changes the air forces, but drying in still air need not wake the grid.
  "math.abs(v.cwwet-v.cwwets)*v.cwsp*(1-v.cwwe)",
  "math.abs(v.cwnx-v.cwsx)", "math.abs(v.cwnz-v.cwsz)"].join("+") + `>${num(WAKE_EPS)}||v.cp_platform!=v.cq_platform||t.vn||v.cwht>0||v.cwchange>0.001||(v.cwbt>1&&v.cwbr>1.25&&v.cwbr<1.55)`;

function step() {
  return [
    // Velocity rescale for a changed step length; 0 right after a reset (v.cwh = 0).
    set("t.k", "v.cwh>0?math.clamp(t.h/v.cwh,0.5,2):0"), set("v.cwh", "t.h"),
    hemProbe.map(i => AX.map(a => set("t.w" + key(i) + a, P(i, a)))),
    // Wet fabric catches less air and settles faster. Fluid drag/buoyancy retain
    // their existing response; only the cape outside water/lava gets this damping.
    set("t.moistResponse", "1-.9*v.cwwet*(1-v.cwwe)"),
    set("t.moistAir", `${num(AIR)}*t.moistResponse`),
    set("t.dm", `math.exp(-${num(DRAG)}*t.moistResponse*t.h)`), set("t.gh", `${num(GRAVITY)}*t.h*t.h`),
    // Internal wet damping is relative to the wearer. Damping absolute world
    // velocity would act as extra air drag and lift the wet cape MORE when running.
    set('t.moistDamp','math.exp(-8*v.cwwet*(1-v.cwwe)*t.h)'),
    AX.map(a=>set('t.moistCarry'+a,`(1-t.moistDamp)*v.cwv${a}*${num(PX)}*t.h`)),
    // One gentle outward pulse for shedding embers, applied to the shared grid.
    set("t.puff", "v.cwbt>1?math.sin(math.clamp((v.cwbr-1.25)/0.3,0,1)*180):0"),
    // A water current pushes the width together; out-of-phase column forces
    // buckle the tall upper cells while buoyancy compresses them from below.
    set("t.colphase", `v.cwwe?0:${num(32/COLS)}`),
    set("t.fh", `(v.cwsp*${num(FLUTTER)}*t.moistResponse+100*t.puff)*t.h*t.h`), set("t.tp", "math.mod(q.life_time,40)*900"),
    // Wind as a per-step displacement; fluid drag and the buoyancy-reduced gravity.
    set("t.wx", `v.cwnx*${num(PX)}*t.h*t.moistResponse`), set("t.wz", `v.cwnz*${num(PX)}*t.h*t.moistResponse`),
    set("t.fd", "math.pow(v.cwfd,t.h*60)"), set("t.gw", "v.cwfg*t.gh"),
    set("t.gh", `t.gh*(1-${num(HEAT_LIFT)}*v.cwht)`),  // hot air rising takes weight off the cape
    // A wave running from the shoulders to the hem, nearly in phase across a row.
    // Magnitude is constant over the substeps; reuse it for all three axes.
    free.map(({ i, r, c }) => set("t.fq" + key(i), `t.fh*((math.sin(t.tp-${num(depth(r)*18.75)}-t.colphase*${c})+t.puff)*${num(depth(r)/16)})`)),
    set("t.j", 0),
    loop("t.n", [
      pinnedIds.map(c => AX.map(a => set(P(c, a), `${P(c, a)}+(${AN(c, a)}-${P(c, a)})/(t.n-t.j)`))), set("t.j", "t.j+1"),
      // Verlet step. Sim axes are world axes, so P-Q minus the wind step is the speed through
      // the air; the quadratic term 1/(1+AIR*|step|) is an implicit, always-stable air drag.
      // Below the fluid surface the drag and buoyancy replace it.
      // Reuse contacts' scalar loop/dispatch. Integration and the anchor limit
      // are independent per particle until the following link pass.
      set('t.pi',0),loop(free.length,[
        dispatch('t.pi',free,({i,r,c})=>[
          set('t.pm',mass(i)),when('t.pm>0.001',[
            AX.map(a=>[set('t.p'+a,P(i,a)),set('t.q'+a,Q(i,a)),set('t.a'+a,P(c,a))]),
            set('t.pf','t.fq'+key(i)),set('t.pl',num(depth(r)*STRETCH)),
          ]),
        ]),
        when('t.pm>0.001',[
          set('t.wt','t.py<v.cwfh'),
          AX.map(a=>set('t.v'+a,`(t.p${a}-t.q${a})*t.k${a==='y'?'':'-t.w'+a}`)),
          set('t.s','t.wt?t.fd:t.dm/(1+t.moistAir*math.sqrt(t.vx*t.vx+t.vy*t.vy+t.vz*t.vz))'),
          AX.map((a,k)=>[set('t.q'+a,'t.p'+a),set('t.p'+a,`t.p${a}+t.v${a}*t.s*t.moistDamp+t.pf*t.g${k}2${a==='y'?'-(t.wt?t.gw:t.gh)':'+t.w'+a+'*t.moistDamp'}+t.moistCarry${a}`)]),
          AX.map(a=>set('t.d'+a,`t.p${a}-t.a${a}`)),
          set('t.e','math.sqrt(t.dx*t.dx+t.dy*t.dy+t.dz*t.dz)'),
          when('t.e>t.pl',AX.map(a=>set('t.p'+a,`t.a${a}+t.d${a}*t.pl/t.e`))),
          dispatch('t.pi',free,({i})=>AX.map(a=>[set(P(i,a),'t.p'+a),set(Q(i,a),'t.q'+a)])),
        ]),set('t.pi','t.pi+1'),
      ]),set('t.k',1),
      // Collision inside the iteration loop so the links spread each push over the cloth.
      // Rows hanging beside the torso collide with the torso; rows below the hip only with
      // the legs (a tilted torso plane would sweep through them when sneaking). Each leg only
      // catches columns inside its shrunken width, so edge and centre columns hang free.
      // Lower rows pick by their current body-local height: once the hem has lifted above
      // the hip (running), legs swinging up to ±80° no longer kick it, only the torso holds it.
      // A hand can make a much larger local push than the torso plane.
      // Spread that correction through the links before output, only on contact.
      set('t.upperContact',0),set('t.iter',0),
      loop(ITER+4,[when(`t.iter<${ITER}||t.upperContact`,[links.map(constraint),contacts()]),set('t.iter','t.iter+1')]),
    ]),
    // Sleep bookkeeping: hem motion per step this frame, and the leg pose it was taken in.
    set("t.mv", `(${hemProbe.map(i => AX.map(a => `math.abs(${P(i, a)}-t.w${key(i)}${a})`).join("+")).join("+")})/t.n`),
    set("v.cwqt", `t.mv<${num(SLEEP_EPS)}?v.cwqt+1:0`),
    set("v.cwrs", legSig[0]), set("v.cwls", legSig[1]),
    upperPose.map(k=>set('v.cw'+k,'t.'+k)),
    set("v.cwss", "v.cwsg"), set("v.cwwets", "v.cwwet"),
    set("v.cq_platform", "v.cp_platform"), set("v.cwsx", "v.cwnx"), set("v.cwsz", "v.cwnz"),
  ];
}
// Rows CLAMP_ROW.. collide in one shared loop (the per-particle code would not fit): load the
// particle, test its cell against the cached ring, leave a solid cell through the face it
// crossed since the last step (toward the player's own foot cell, never solid, if it was
// already inside: pushing up climbed stacked blocks and stretched the cape), clamp to the floor
// plane, push out of another player's body, and write back only if something moved it.
const colliders = free.map(({ i }) => i);
const dispatch = (idx, vals, fn, s = 0) => { if(vals.length===1)return fn(vals[0]);const h=vals.length>>1;
  return when(`${idx}<${s+h}`,dispatch(idx,vals.slice(0,h),fn,s),dispatch(idx,vals.slice(h),fn,s+h)); };
function localPlane(normal,d,carry=false) {
  return [set('t.pd', `${d}-(${normal.map((n,k)=>n+'*t.p'+AX[k]).join('+')})`),
    when('t.pd>0',[AX.map((a,k)=>[set('t.p'+a,`t.p${a}+${normal[k]}*t.pd`),
      carry ? set('t.q'+a,`t.q${a}+${normal[k]}*t.pd*${num(1-LEG_CARRY)}`) : []]),set('t.ch',1),carry?set('t.qh',1):[]])];
}
function upperContacts() {
  // Reject points outside the union's bounding box before dispatching the limbs.
  return when(AX.map(a=>`t.p${a}>t.upperlo${a}&&t.p${a}<t.upperhi${a}`).join('&&'),[set('t.ui',0),loop(UPPER.length,[
    dispatch('t.ui',UPPER.map((_,i)=>i),i=>[
      set('t.unear',AX.map(a=>`t.p${a}>t.u${i}lo${a}&&t.p${a}<t.u${i}hi${a}`).join('&&')),
      when('t.unear',[
        AX.map(a=>set('t.ud'+a,`t.p${a}-t.u${i}${a}`)),
        [0,1,2].map(j=>set('t.ul'+j,AX.map((a,k)=>`t.u${i}${k}${j}*t.ud${a}`).join('+'))),
        [0,1,2].map(j=>set('t.uh'+j,num(UPPER[i].half[j]+0.4))),
      ]),
    ]),
    when('t.unear&&math.abs(t.ul0)<t.uh0&&math.abs(t.ul1)<t.uh1&&math.abs(t.ul2)<t.uh2',[
      when('!t.qloaded',[dispatch('t.ci',colliders,i=>AX.map(a=>set('t.q'+a,Q(i,a)))),set('t.qloaded',1)]),
      // The cape is attached behind the torso: eject it through the limb face
      // facing that side, so a hand cannot squeeze it inward through the body.
      dispatch('t.ui',UPPER.map((_,i)=>i),i=>[set('t.ua',`t.u${i}face`),set('t.usign',`t.u${i}sign`)]),
      dispatch('t.ua',[0,1,2],j=>[
        set('t.ud',`t.usign*t.uh${j}-t.ul${j}`),
        dispatch('t.ui',UPPER.map((_,i)=>i),i=>AX.map((a,k)=>[
          set('t.p'+a,`t.p${a}+t.u${i}${k}${j}*t.ud`),set('t.q'+a,`t.q${a}+t.u${i}${k}${j}*t.ud*${num(1-LEG_CARRY)}`),
        ])),
      ]),set('t.ch',1),set('t.qh',1),set('t.upperContact',1),
    ]),set('t.ui','t.ui+1'),
  ])]);
}
function contacts() {
  const px=num(PX),gap=num(WALL_GAP);
  return [set('t.ci',0),loop(colliders.length,[
    set('t.qloaded','t.ci>=18||v.cwtb>0||v.cp_platform>0'),
    dispatch('t.ci',colliders,i=>[set('t.active',mass(i)),when('t.active>0.001',[AX.map(a=>set('t.p'+a,P(i,a))),when('t.ci>=18||v.cwtb>0||v.cp_platform>0',AX.map(a=>set('t.q'+a,Q(i,a))))])]),
    when('t.active>0.001',[
      set('t.ch',0),set('t.qh',0),
      when('t.ci>=18',set('t.ly','t.g01*(t.px-t.bx)+t.g11*(t.py-t.by)+t.g21*(t.pz-t.bz)')),
      // Preserve the armoured waist's collision guard independently of visual
      // overlap so reducing the overlap cannot expose the chestplate hem.
      when(`t.ci<${3*(COLS+1)}||t.ly>${HIP_Y-24}-v.cwaz-(v.cwaz>0?${num(CHEST_HEM_GUARD)}:0)`,localPlane(TORSO,'t.td'),[
        set('t.lx',`-5+math.mod(t.ci,${COLS+1})*${W}`),
        when(`math.abs(t.lx+1.9)<${LEG_HALF}`,localPlane(RLEG,'t.rd',true)),
        when(`math.abs(t.lx-1.9)<${LEG_HALF}`,localPlane(LLEG,'t.ld',true))]),
      upperContacts(),
      when(`t.ci>=${(CLAMP_ROW-1)*(COLS+1)}`,[
        when('v.cwtb>0||v.cp_platform>0',[
          AX.map(a=>set('t.za'+a,`math.floor((t.p${a}-v.cwo${a})/${px})`)),
          when('math.abs(t.zax)<2&&math.abs(t.zaz)<2&&t.zay>=0&&t.zay<2',[
            set('t.bit','math.pow(2,(t.zay*3+t.zaz+1)*3+t.zax+1)'),
            when(`v.cp_platform&&math.mod(math.floor(v.cp_platform/t.bit),2)&&t.qy>=v.cwoy+(t.zay+1)*${px}`,
              [set('t.py',`v.cwoy+(t.zay+1)*${px}+${gap}`),set('t.ch',1)]),
            when('math.mod(math.floor(v.cwtb/t.bit),2)',[
              AX.map(a=>set('t.zb'+a,`math.floor((t.q${a}-v.cwo${a})/${px})`)),
              set('t.zf','t.zbx==t.zax&&t.zby==t.zay&&t.zbz==t.zaz'),
              AX.map(a=>set('t.zb'+a,`t.zf?0:t.zb${a}`)),
              AX.map(a=>[set('t.zc'+a,`t.zb${a}>t.za${a}?v.cwo${a}+(t.za${a}+1)*${px}+${gap}:t.zb${a}<t.za${a}?v.cwo${a}+t.za${a}*${px}-${gap}:t.p${a}`),
                set('t.zd'+a,`t.zb${a}==t.za${a}?1000000:math.abs(t.zc${a}-t.p${a})`)]),
              set('t.zm','math.min(t.zdx,math.min(t.zdy,t.zdz))'),
              AX.map(a=>when(`t.zd${a}==t.zm`,set('t.p'+a,'t.zc'+a))),set('t.ch',1)])])]),
        when('t.py<v.cwfl',[set('t.py','v.cwfl'),set('t.ch',1)]),
        when('t.vn',[set('t.yx','t.px-t.vcx'),set('t.yz','t.pz-t.vcz'),set('t.yd','math.sqrt(t.yx*t.yx+t.yz*t.yz)'),
          when(`t.yd<${num(VIEWER_R*PX)}&&t.yd>0.001&&t.py>t.vcy&&t.py<t.vcy+${num(VIEWER_H*PX)}`,[
            set('t.px',`t.vcx+t.yx*${num(VIEWER_R*PX)}/t.yd`),set('t.pz',`t.vcz+t.yz*${num(VIEWER_R*PX)}/t.yd`),set('t.ch',1)])])]),
      when('t.ch',dispatch('t.ci',colliders,i=>AX.map(a=>set(P(i,a),'t.p'+a)))),
      when('t.qh',dispatch('t.ci',colliders,i=>AX.map(a=>set(Q(i,a),'t.q'+a))))
    ]),set('t.ci','t.ci+1')])];
}

// All incident tiles share this display vertex. A small spatial fairing removes
// sharp per-cell kinks before fitting cuboids; it never changes solver particles.
// Limit displacement to half a texture pixel. Missing/burning links contribute
// no cross-gap smoothing, and unequal row heights retain affine/rest positions.
export const MESH_FAIR = envNum('MESH_FAIR', 0.4), MESH_LIMIT = 0.5;
function smoothWeights() {
  return free.map(({i,r,c}) => {
    const strength=(a,b,c) => 'math.min('+linkStrength(a,b)+','+linkStrength(b,c)+')*'+num(MESH_FAIR);
    return [set('v.cf'+key(i)+'x',c>0&&c<COLS?strength(i-1,i,i+1):0),set('v.cf'+key(i)+'z',r<ROWS?strength(i-COLS-1,i,i+COLS+1):0)];
  });
}
function toLocal(i) {
  const r=Math.floor(i/(COLS+1)), c=i%(COLS+1), left=i-1, right=i+1, up=i-COLS-1, down=i+COLS+1;
  const horizontal=c>0&&c<COLS, vertical=r<ROWS;
  return when(`(v.cu${key(i)}t??-1)!=v.cwst`, [
    set('t.wx','v.cf'+key(i)+'x'), set('t.wz','v.cf'+key(i)+'z'),
    AX.map(a => set('t.s'+a,
      (horizontal?`((${P(left,a)}+${P(right,a)})*.5-${P(i,a)})*t.wx`:'0')+
      (vertical?`+((${P(up,a)}*${num(H(r))}+${P(down,a)}*${num(H(r-1))})/${num(H(r)+H(r-1))}-${P(i,a)})*t.wz`:''))),
    set('t.e',`math.min(1,${num(MESH_LIMIT)}/math.max(math.sqrt(t.sx*t.sx+t.sy*t.sy+t.sz*t.sz),0.0001))`),
    AX.map(a => set('t.d'+a,`${P(i,a)}+t.s${a}*t.e-v.cwk${a}`)),
    AX.map((a,k) => set(U(i,a),`v.cwg0${k}*t.dx+v.cwg1${k}*t.dy+v.cwg2${k}*t.dz${a==='y'?'+24':''}`)),
    set(`v.cu${key(i)}t`,'v.cwst')]);
}

// Each cell is a parallelogram fitted to its four corners: outer bone = rotation U and
// offset, middle bone = in-plane scale, inner bone = in-plane rotation (closed-form 2x2 SVD).
function cell(r, c) {
  const A = pid(r, c), B = pid(r, c + 1), C = pid(r + 1, c), D = pid(r + 1, c + 1);
  const cv = (i, a) => !isPinned(i) ? U(i, a) : a === "x" ? num(restX(i)) : a === "y" ? "24" : `(${num(ZMID)}+v.cwaz)`;
  const pivot = [restX(c) + W / 2, restY(r) - H(r) / 2, ZMID];
  return [
    [A, B, C, D].filter(i => !isPinned(i)).map(toLocal),
    AX.map(a => set("t.m" + a, `(${cv(A, a)}+${cv(B, a)}+${cv(C, a)}+${cv(D, a)})*.25`)),
    AX.map(a => set("t.h" + a, `(${cv(B, a)}-${cv(A, a)}+${cv(D, a)}-${cv(C, a)})*${num(1 / (2 * W))}`)),
    AX.map(a => set("t.i" + a, `(${cv(A, a)}-${cv(C, a)}+${cv(B, a)}-${cv(D, a)})*${num(1 / (2 * H(r)))}`)),
    canBurn(r,c) ? [set(CV(r, c, "sz"), 1), when(burning, burnCell(r, c, H(r), CV(r, c, "sz")))] : [],
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
    set(CV(r,c,'variant'), `(${burnVar(r,c,'s')}??0)==2?4:(${attachmentBit(r,c-1,1)})+(${attachmentBit(r,c+1,2)})+(${attachmentBit(r+1,c,8)})`),
  ];
}
const VISIBLE = "q.has_cape&&!(v.is_first_person??0)&&!(v.map_face_icon??0)&&!q.is_spectator&&!q.is_item_name_any('slot.armor.chest',0,'minecraft:elytra')";

// Bedrock errors on uninitialised reads. Shared frame state gets defaults once;
// particle positions are written by reset/seedDetached before their first use.
// Cell caches and attachment snapshots have their own guarded initialisation.
export function initDefaults() {
  const text = toMolang(body()) + channels().map(ch => toMolang(ch.nodes) + ch.value).join("");
  // Cell outputs (v.cc) and body-local particles (v.cu) are only read behind ?? or after
  // being written in the same expression, so they need no defaults.
  const names = [...new Set([...text.matchAll(/\bv\.(c[wpq][a-z0-9_]*)/g)].map(m => m[1]))].filter(n => n !== "cwin" && !/^c[pq][0-9a-z][xyz]$/.test(n));
  return Object.fromEntries(names.sort().map(n => [n, n === "cwlt" ? -1 : n === "cwbr" ? BURN_END : 0]));
}

export const program = () => cacheConstants(flat(
  when("!(v.cwin??0)", [Object.entries(initDefaults()).map(([n, x]) => set("v." + n, n.startsWith('cwwet') ? `(v.${n}??${x})` : x)), set("v.cwin", 1)]),
  body()), ["0.001", "17.06667", "0.0001"]);

// Actual water/rain exposure, independent of the cold-biome wind multiplier.
// Run once per world frame (also while asleep): ~10 s to dry, ~3.3 s in heat.
export const wetClock = () => set("v.cwwet", "math.clamp((v.cwwet??0)+(q.is_in_water?4:q.is_in_water_or_rain?.7:-(q.entity_biome_has_any_tags('desert','nether')?.3:.1))*math.clamp(q.delta_time,0,.1),0,1)");
// The native root controller omits the cape animation in first person. Its cape
// render controller can still update this scalar clock, without reading bones.
// Both entries use the same stamp; render order and duplicate passes do not matter.
export const wetUpdate = () => when("!q.is_in_ui&&!(v.is_paperdoll??0)",
  when("q.life_time!=(v.cwwet_time??-1)", [wetClock(),set('v.cwwet_time','q.life_time')]));
export const wetTint = "!q.is_in_ui&&!(v.is_paperdoll??0)?(v.cwwet??0)*.45:0";

// UI and paperdoll use their geometry's locator offset and the rest pose.
// Equipment queries require an actor and must stay inside the world-only branch.
function body() {
  return flat(
    set("v.cwaz", "q.get_root_locator_offset('armor_offset.default_neck',1)"),
    set("v.cwon", 0),
    when("!q.is_in_ui&&!(v.is_paperdoll??0)", [
      // Moisture follows the actor even while first-person or an elytra hides the cape.
      wetUpdate(),
      // A&S guards queries with the animation clock. Skin/cape reloads can restart
      // this clock without restarting the player lifetime or clearing variables.
      when("q.anim_time<(v.cwclock??0)", [set("v.cwwu", 0), set("v.cwok", 0), set("v.cwlt", -1)]),
      set("v.cwclock", "q.anim_time"),
      // A&S reaches chest slot 1 through its equipment controller. Our cape
      // animation also runs in actorless previews, so guard the call here.
      // The locator alone can stay zero while wearing armour; keep guaranteed
      // chestplate room shared by the collar and collision in world passes.
      set("v.cwaz", `math.max(v.cwaz+(v.cwaz>0?${num(CHEST_CLEARANCE)}:0),q.has_armor_slot(1)?${num(1+CHEST_CLEARANCE)}:0)`),
      // A&S also guards bone queries against a clock rollback. A cosmetic reload
      // can retain our variables while rebuilding geometry: rearm the existing
      // 0.1 s warmup before querying it again. UI passes never touch this clock.
      when(VISIBLE, when("q.life_time!=v.cwlt", [
        when("q.life_time<v.cwlt", [set("v.cwwu", 0), set("v.cwok", 0)]),
        set("v.cwlt", "q.life_time"),
        // Count warmup once per world frame too, even with multiple render passes.
        // v.cwst counts simulated frames for the bone-channel output cache.
        when("v.cwwu<0.1", [set("v.cwwu", "v.cwwu+math.clamp(q.delta_time,0,0.05)"), set("v.cwok", 0)], [
          origin(), env(), burnClock(), material(), wind(),
          when("t.sr", set("v.cwac", 0)), schedule(),
          when("t.sr||t.n>0", [frame(), when("t.sr",reset()), seedDetached(),
            // Asleep: skip the step (the cells stay cached) until an anchor or a leg moves.
            when("t.sr", [set("v.cwqt", 0), set("v.cwst", "v.cwst+1")], when(`v.cwqt<${SLEEP_FRAMES}||${wake()}`, [
              when(`v.cwqt>=${SLEEP_FRAMES}`, set("v.cwqt", 0)), step(), set("v.cwst", "v.cwst+1")]))]),
          set("v.cwok", 1),
        ]),
      ]), [set("v.cwok", 0), set("v.cwwu", 0)]),
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
    const burnable = canBurn(r,c);
    const refresh = burnable ? `||(${burning})&&(${f("ft")}??-1)!=q.life_time` : "";
    const nodes = flat(when(`(v.cwon??0)&&((${f("lt")}??-1)!=(v.cwst??-2)${refresh})`,
      [cell(r, c), set(f("lt"), "v.cwst"), burnable ? set(f("ft"), "q.life_time") : []]));
    const add = (bone, channel, axis, field, off) => list.push({ bone, channel, axis, r, c, field, nodes,
      value: `(v.cwon??0)?(${f(field)}??${off}):${off}` });
    const dy = num(restY(r) - H(r) / 2 - 24), vr = "(6+126*q.cape_flap_amount)";
    ["rx", "ry", "rz"].forEach((k, axis) => add(n.outer, "rotation", axis, k, axis === 0 ? vr : 0));
    ["px", "py", "pz"].forEach((k, axis) => add(n.outer, "position", axis, k,
      [0, `${dy}*(math.cos(${vr})-1)`, `((v.cwaz??0)-${dy}*math.sin(${vr}))`][axis]));
    add(n.mid, "scale", 0, "sx", 1); add(n.mid, "scale", 1, "sy", 1);
    if (burnable) add(n.mid, "scale", 2, "sz", 1);
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
// Each cell reaches past its interior edges into its neighbours, with the UVs
// extended by the same amount, so the overlap shows the neighbour's own texels (invisible
// when flat) and covers the cracks a bend or an imperfect parallelogram fit opens.
// The cape's outer border is never extended. Pivots and the fit stay on the rest cell.
// With shared, faired display vertices the long overlapping plates are no longer
// needed. Rows mostly bend along the cape, so their overlap is smaller than the
// side allowance needed for sideways shear. Keep the original one-pixel thickness.
export const OVERLAP = envNum("OVERLAP", 0.75);
// Only ONE variant per tile is rendered. Variants bake the optional side overlap
// into both the cube and UV rectangle; switching cannot squash/stretch texels.
// Vertical overlap closes both sides while attached; the upper tile retracts
// its bottom overlap as soon as the lower tile is gone, leaving an integer burn edge.
export const TOP_OVERLAP = envNum('ROW_OVERLAP', 0.4);
export function meshVariants(r,c) {
  const masks = [0,1,2,3].filter(m => (c>0||!(m&1))&&(c<COLS-1||!(m&2))&&(c===0||canBurn(r,c-1)||!!(m&1))&&(c===COLS-1||canBurn(r,c+1)||!!(m&2)));
  const list = masks.flatMap(code=>(r<ROWS-1?(canBurn(r+1,c)?[0,8]:[8]):[0]).map(bottom=>({code:code+bottom,L:code&1?OVERLAP:0,R:code&2?OVERLAP:0,T:r>0?TOP_OVERLAP:0,B:bottom?TOP_OVERLAP:0})));
  if(canBurn(r,c)) list.push({code:4,L:0,R:0,T:0,B:0});
  return list;
}
export function geometry() {
  const list = [{name:'root',pivot:[0,0,0]},{name:'waist',parent:'root',pivot:[0,12,0]}, {name:'body',parent:'waist',pivot:[0,24,0]}];
  each((r,c)=>{
    const n=boneNames(r,c),x0=restX(c),y1=restY(r),v0=1+depth(r);
    const pivot=[x0+W/2,y1-H(r)/2,ZMID];
    list.push({name:n.outer,parent:'body',pivot},{name:n.mid,parent:n.outer,pivot},{name:n.mesh,parent:n.mid,pivot});
    for(const {code,L,R,T,B} of meshVariants(r,c)) {
      const w=W+L+R,h=H(r)+T+B,vt=round(v0-T);
      const uv={
        north:{uv:[round(17+x0-L),vt],uv_size:[round(w),round(h)]},
        south:{uv:[round(6-x0-W-R),vt],uv_size:[round(w),round(h)]},
        east:{uv:[11,vt],uv_size:[1,round(h)]},west:{uv:[0,vt],uv_size:[1,round(h)]},
        up:{uv:[round(6-x0+L),0],uv_size:[round(-w),1]},
        down:{uv:[round(16-x0+L),0],uv_size:[round(-w),1]}
      };
      list.push({name:n.mesh+'_'+code,parent:n.mesh,pivot,cubes:[{origin:[round(x0-L),round(y1-H(r)-B),2],size:[round(w),round(h),1],uv}]});
    }
  });
  return {format_version:'1.12.0','minecraft:geometry':[{description:{identifier:'geometry.cape',texture_width:64,texture_height:32,
    visible_bounds_width:3,visible_bounds_height:3.5,visible_bounds_offset:[0,1.25,0]},bones:list}]};
}
export function renderController() {
  const show="query.armor_texture_slot(1) != 5 && (!variable.is_first_person || variable.is_paperdoll) && !variable.map_face_icon && !query.is_spectator";
  const visibility={};
  each((r,c)=>{
    const full=(c>0?1:0)+(c<COLS-1?2:0)+(r<ROWS-1?8:0),mode=`((v.cwon??0)?(${CV(r,c,'variant')}??${full}):${full})`;
    for(const {code} of meshVariants(r,c)) visibility[boneNames(r,c).mesh+'_'+code]=`${show}&&${mode}==${code}&&(!(v.cwon??0)||(${burnVar(r,c,'show')}??1))`;
  });
  return {format_version:'1.8.0',render_controllers:{'controller.render.player.cape':{
    rebuild_animation_matrices:true,geometry:'Geometry.cape',materials:[{'*':'Material.cape'}],textures:['Texture.cape'],
    part_visibility:[visibility],is_hurt_color:{r:0,g:0,b:0,a:0},
    overlay_color:{r:0,g:0,b:0,a:toMolang([wetUpdate()])+`return ${wetTint};`}
  }}};
}
export const sections = () => ({ upper: upperFrames(), upperContacts: upperContacts(), weights: smoothWeights(), origin: origin(), frame: frame(), reset: reset(), step: step(), cell: cell(1, 1) });
