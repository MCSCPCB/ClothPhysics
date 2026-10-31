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
// Interpolate the tick-stepped actor position, as Simple Ragdoll's anchorPrograms().
function origin() {
  const e = k => `q.position(${k})`;
  return [
    set("t.now", "math.floor(q.life_time*20+0.001)"),
    set("t.j", `math.abs(${e(0)}-v.cwcx)+math.abs(${e(1)}-v.cwcy)+math.abs(${e(2)}-v.cwcz)`),
    // Also reset far from the base so sim coordinates stay small (float precision).
    set("t.sr", `!v.cwok||q.delta_time>0.25||t.j>4||math.abs(${e(0)}-v.cwbx)+math.abs(${e(2)}-v.cwbz)>${REBASE}`),
    when("t.sr||t.now<v.cwtk||t.now-v.cwtk>1", [AX.map((a, k) => [set("v.cwp" + a, e(k)), set("v.cwc" + a, e(k))]), set("v.cwtk", "t.now")]),
    when("t.now!=v.cwtk", [AX.map(a => set("v.cwp" + a, "v.cwc" + a)), set("v.cwtk", "t.now")]),
    AX.map((a, k) => [set("v.cwc" + a, e(k)), set("t.r" + a, `math.lerp(v.cwp${a},v.cwc${a},math.clamp(q.frame_alpha,0,1))`)]),
    when("t.sr", [AX.map(a => [set("v.cwb" + a, "t.r" + a), set("v.cwl" + a, "t.r" + a)]), set("v.cwsp", 0), set("v.cwh", 0)]),
    AX.map(a => set("t.o" + a, `(t.r${a}-v.cwb${a})*${num(PX)}`)),
    set("t.vh", "math.sqrt(math.pow(t.rx-v.cwlx,2)+math.pow(t.rz-v.cwlz,2))/math.max(q.delta_time,0.001)"),
    set("v.cwsp", "math.lerp(v.cwsp,math.min(t.vh,8),math.clamp(q.delta_time*8,0,1))"),
    AX.map(a => set("v.cwl" + a, "t.r" + a)),
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
    leg("t.rl", "rightleg", "r"), leg("t.ll", "leftleg", "l"),
    AX.map((a, k) => set("t.a" + a, `t.b${a}+t.g${k}2*(${num(ZMID)}+v.cwaz)`)),
    // Target anchors; step() moves the persistent top row toward them across substeps.
    Array.from({ length: COLS + 1 }, (_, c) => AX.map((a, k) => set(AN(c, a), `t.a${a}+t.g${k}0*${num(restX(c))}`))),
  ];
}
const AN = (c, a) => `t.an${key(c)}${a}`;
const pinnedIds = Array.from({ length: COLS + 1 }, (_, c) => c);

const reset = () => [pinnedIds.map(c => AX.map(a => set(P(c, a), AN(c, a)))),
  free.map(({ i, r, c }) => AX.map((a, k) => [set(P(i, a), `${P(c, a)}-t.g${k}1*${num(r * H)}`), set(Q(i, a), P(i, a))]))];

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
    set("t.e", `(math.sqrt(t.dx*t.dx+t.dy*t.dy+t.dz*t.dz)-${num(len)})`),
    set("t.e", `t.e/math.max(t.e+${num(len)},0.0001)*${num(w)}`),
    AX.map(x => [pin ? [] : set(P(a, x), `${P(a, x)}+t.d${x}*t.e`), set(P(b, x), `${P(b, x)}-t.d${x}*t.e`)])];
}

function step() {
  return [
    set("t.dt", "math.clamp(q.delta_time,0,0.1)"),
    set("t.n", `math.clamp(math.ceil(t.dt/${num(SUB_DT)}-0.001),1,${MAX_SUB})`),
    set("t.h", "t.dt/t.n"), set("t.k", "v.cwh>0?math.clamp(t.h/v.cwh,0.5,2):1"), set("v.cwh", "t.h"),
    set("t.dm", `math.exp(-${num(DRAG)}*t.h)`), set("t.gh", `${num(GRAVITY)}*t.h*t.h`),
    set("t.fh", `v.cwsp*${num(FLUTTER)}*t.h*t.h`), set("t.tp", "math.mod(q.life_time,40)*900"),
    // A wave running from the shoulders to the hem, nearly in phase across a row.
    free.map(({ i, r, c }) => set("t.fq" + key(i), `math.sin(t.tp-${r * 50 + c * 8})*${num(r / ROWS)}`)),
    set("t.j", 0),
    loop("t.n", [
      pinnedIds.map(c => AX.map(a => set(P(c, a), `${P(c, a)}+(${AN(c, a)}-${P(c, a)})/(t.n-t.j)`))), set("t.j", "t.j+1"),
      // Verlet step. Sim axes are world axes, so P-Q is the speed through still air; the
      // quadratic term 1/(1+AIR*|step|) is an implicit, always-stable air drag.
      free.map(({ i }) => [AX.map(a => set("t.v" + a, `(${P(i, a)}-${Q(i, a)})*t.k`)),
        set("t.s", AIR > 0 ? `t.dm/(1+${num(AIR)}*math.sqrt(t.vx*t.vx+t.vy*t.vy+t.vz*t.vz))` : "t.dm"),
        AX.map((a, k) => [set(Q(i, a), P(i, a)),
          set(P(i, a), `${P(i, a)}+t.v${a}*t.s+t.fh*t.fq${key(i)}*t.g${k}2${a === "y" ? "-t.gh" : ""}`)])]),
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
      })]),
    ]),
  ];
}
// A free particle back into body-local coordinates (G is orthonormal, so G^-1 = G^T).
// Runs inside bone channels, once per particle per frame behind its own stamp.
const toLocal = i => when(`v.cu${key(i)}t!=v.cwlt`, [AX.map(a => set("t.d" + a, `${P(i, a)}-v.cwk${a}`)),
  AX.map((a, k) => set(U(i, a), `v.cwg0${k}*t.dx+v.cwg1${k}*t.dy+v.cwg2${k}*t.dz${a === "y" ? "+24" : ""}`)), set(`v.cu${key(i)}t`, "v.cwlt")]);

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
  const names = [...new Set([...text.matchAll(/\bv\.(c[wpquc][a-z0-9]*)/g)].map(m => m[1]))].filter(n => n !== "cwin");
  const stamp = n => n === "cwlt" || /^cc.lt$/.test(n) || /^cu.t$/.test(n);
  return Object.fromEntries(names.sort().map(n => [n, stamp(n) ? -1 : 0]));
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
        when("q.life_time!=v.cwlt", [
          set("v.cwlt", "q.life_time"), origin(), frame(),
          when("t.sr", reset(), when("q.delta_time>0", step())),
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
    const nodes = flat(when(`(v.cwon??0)&&(${f("lt")}??-1)!=(v.cwlt??-2)`, [cell(r, c), set(f("lt"), "v.cwlt")]));
    const add = (bone, channel, axis, field, off) => list.push({ bone, channel, axis, r, c, field, nodes,
      value: `(v.cwon??0)?(${f(field)}??${off}):${off}` });
    ["rx", "ry", "rz"].forEach((k, axis) => add(n.outer, "rotation", axis, k, 0));
    ["px", "py", "pz"].forEach((k, axis) => add(n.outer, "position", axis, k, axis === 2 ? "(v.cwaz??0)" : 0));
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
// runs toward -x, north toward +x), sample's local east strip (u 0) lands on our -x edge,
// and the 1px top/bottom strips are the sample's turned by 180° (u and v both flipped).
export function geometry() {
  const list = [{ name: "root", pivot: [0, 0, 0] }, { name: "waist", parent: "root", pivot: [0, 12, 0] },
    { name: "body", parent: "waist", pivot: [0, 24, 0] }];
  each((r, c) => {
    const n = boneNames(r, c), x0 = restX(c), y1 = restY(r), v0 = round(1 + r * H);
    const pivot = [round(x0 + W / 2), round(y1 - H / 2), ZMID];
    const uv = {
      north: { uv: [round(17 + x0), v0], uv_size: [round(W), round(H)] },
      south: { uv: [round(6 - x0 - W), v0], uv_size: [round(W), round(H)] },
    };
    if (c === 0) uv.west = { uv: [0, v0], uv_size: [1, round(H)] };
    if (c === COLS - 1) uv.east = { uv: [11, v0], uv_size: [1, round(H)] };
    if (r === 0) uv.up = { uv: [round(6 - x0), 0], uv_size: [round(-W), 1] };
    if (r === ROWS - 1) uv.down = { uv: [round(16 - x0), 0], uv_size: [round(-W), 1] };
    list.push({ name: n.outer, parent: "body", pivot }, { name: n.mid, parent: n.outer, pivot },
      { name: n.mesh, parent: n.mid, pivot, cubes: [{ origin: [round(x0), round(y1 - H), 2], size: [round(W), round(H), 1], uv }] });
  });
  return { format_version: "1.12.0", "minecraft:geometry": [{
    description: { identifier: "geometry.cape", texture_width: 64, texture_height: 32,
      visible_bounds_width: 3, visible_bounds_height: 3.5, visible_bounds_offset: [0, 1.25, 0] },
    bones: list }] };
}

// Same visibility rule as _sample, applied to every cube bone.
export function renderController() {
  const show = "query.armor_texture_slot(1) != 5 && (!variable.is_first_person || variable.is_paperdoll) && !variable.map_face_icon && !query.is_spectator";
  return { format_version: "1.8.0", render_controllers: { "controller.render.player.cape": {
    rebuild_animation_matrices: true, geometry: "Geometry.cape", materials: [{ "*": "Material.cape" }], textures: ["Texture.cape"],
    part_visibility: [Object.fromEntries(each((r, c) => [boneNames(r, c).mesh, show]))],
    is_hurt_color: { r: 0, g: 0, b: 0, a: 0 } } } };
}
export const sections = () => ({ origin: origin(), frame: frame(), reset: reset(), step: step(), cell: cell(1, 1) });
