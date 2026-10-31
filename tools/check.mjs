// Runs the generated Molang (printed as JS) against a scripted player and reports
// seams, parallelogram fit, stretch, lift and UI isolation. It verifies our own math
// and logic only; Bedrock's real transform conventions still need the in-game test.
import { program, channels, initDefaults, pid, restX, restY, COLS, ROWS, W, H, ZMID, OVERLAP } from "./cloth.mjs";
import { toMolang, compileJs, jsReturn, MATH, strict } from "./molang.mjs";

const D = Math.PI / 180, key = i => i.toString(36);
const prog = compileJs(program(), "return 0;");
const chans = channels().map(ch => ({ ...ch, fn: compileJs(ch.nodes, jsReturn(ch.value)) }));

// Independent copy of the Bedrock euler convention: Rz(-rz)*Ry(ry)*Rx(-rx), degrees.
function euler(rx, ry, rz) {
  const a = -rx * D, b = ry * D, c = -rz * D, [ca, sa, cb, sb, cc, sc] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b), Math.cos(c), Math.sin(c)];
  return [[cc * cb, cc * sb * sa - sc * ca, cc * sb * ca + sc * sa], [sc * cb, sc * sb * sa + cc * ca, sc * sb * ca - cc * sa], [-sb, cb * sa, cb * ca]];
}
const mul = (M, p) => M.map(row => row[0] * p[0] + row[1] * p[1] + row[2] * p[2]);
const sub = (a, b) => a.map((x, k) => x - b[k]), len = a => Math.hypot(...a);

// Assumed Bedrock bone chain: inner rotation, then middle scale, then outer rotation + position, shared pivot.
function place(cell, r, c, p) {
  const pv = [restX(c) + W / 2, restY(r) - H / 2, ZMID];
  let d = mul(euler(0, 0, cell.iz), sub(p, pv));
  d = [d[0] * cell.sx, d[1] * cell.sy, d[2]];
  d = mul(euler(cell.rx, cell.ry, cell.rz), d);
  return [pv[0] + cell.px + d[0], pv[1] + cell.py + d[1], pv[2] + cell.pz + d[2]];
}
const corner = (r, c) => [restX(c), restY(r), ZMID];
const particle = (v, r, c, az) => r === 0 ? [restX(c), 24, ZMID + az] : ["x", "y", "z"].map(a => v[`cu${key(pid(r, c))}${a}`]);

function query(s) {
  return {
    life_time: () => s.time, delta_time: () => s.dt, frame_alpha: () => s.alpha, position: k => s.pos[k],
    body_y_rotation: () => s.yaw, bone_orientation_trs: name => s.bones[name], get_root_locator_offset: () => s.armorZ,
    has_cape: () => 1, is_in_ui: () => s.ui, is_spectator: () => 0, is_item_name_any: () => 0,
  };
}

// Evaluate every channel in a random order; returns {"r,c": cell fields}.
function evalChannels(v, q) {
  const order = chans.map(ch => [Math.random(), ch]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
  const cells = {};
  for (const ch of order) (cells[`${ch.r},${ch.c}`] ??= {})[ch.field] = ch.fn(v, q, MATH);
  return cells;
}
// Exact case: particles on an affine image of the rest grid must give zero fit error.
function affineTest() {
  const M = [[1.1, 0.35, 0.2], [-0.15, 0.85, 0.3], [0.25, -0.2, 0.95]], pv = [0, 24, ZMID];
  const v = strict({ ...initDefaults(), cwin: 1, cwon: 1, cwlt: 1, cwaz: 0 }), q = query({ ui: 0 });
  for (let r = 1; r <= ROWS; r++) for (let c = 0; c <= COLS; c++) {
    const p = mul(M, sub(corner(r, c), pv)).map((x, k) => x + pv[k]);
    ["x", "y", "z"].forEach((a, k) => v[`cu${key(pid(r, c))}${a}`] = p[k]);
    v[`cu${key(pid(r, c))}t`] = 1;
  }
  const cells = evalChannels(v, q);
  let err = 0;
  for (let r = 1; r < ROWS; r++) for (let c = 0; c < COLS; c++)
    for (const [dr, dc] of [[0, 0], [0, 1], [1, 0], [1, 1]])
      err = Math.max(err, len(sub(place(cells[`${r},${c}`], r, c, corner(r + dr, c + dc)), particle(v, r + dr, c + dc, 0))));
  return err;
}

// Scripted player: stand, walk, sprint, sharp turn, stop, sneak, jump, teleport.
function motion(t) {
  return {
    speed: t < 2 ? 0 : t < 4 ? 4.3 : t < 8 ? 5.6 : 0,
    yaw: t < 6 ? 30 : t < 6.4 ? 30 + (t - 6) / 0.4 * 180 : 210,
    sneak: t >= 9 && t < 10.5, jump: t >= 11 && t < 11.6 ? 4.8 * (t - 11) - 8 * (t - 11) ** 2 : 0,
    teleport: t >= 12.5 ? 100 : 0,
  };
}

function run(opt) {
  const { fps, seconds = 14, armorZ = 0, scenario = motion } = opt;
  const dt = 1 / fps, v = strict({}), s = { ui: 0, armorZ };
  let path = [0, 64, 0], phase = 0, tickPrev = null, tickCur = null, tick = -1, lagged = null;
  const m = { nan: 0, uiLeak: 0, seam: 0, fit: 0, stretch: 0, restDrift: 0, lift: [], jumpPx: 0, prevU: null, series: {}, kick: 0, legClip: 0 };
  for (let f = 0; f * dt < seconds; f++) {
    const t = f * dt, mo = scenario(t);
    const fwd = [-Math.sin(mo.yaw * D), 0, Math.cos(mo.yaw * D)];
    const legSpeed = mo.swing ?? mo.speed;
    path = path.map((x, k) => x + fwd[k] * mo.speed * dt); phase += legSpeed * dt;
    const target = [path[0] + mo.teleport, path[1] + mo.jump, path[2]];
    const nowTick = Math.floor(t * 20 + 0.001);
    if (nowTick !== tick) { tickPrev = tickCur ?? target; tickCur = target; tick = nowTick; }
    // Vanilla move.legs: tcos0*1.4 with tcos0 = cos(...)*modified_move_speed*57.3, i.e. up to ±80°.
    const swing = Math.sin(phase * 140) * Math.min(1, legSpeed * 0.2) * 80;
    const bones = {
      body: { t: { x: 0, y: 24, z: 0 }, r: { x: mo.sneak ? 28.65 : 0, y: 0, z: 0 } },
      rightleg: { t: { x: -1.9, y: 12, z: mo.sneak ? 4 : 0 }, r: { x: swing, y: 0, z: 0 } },
      leftleg: { t: { x: 1.9, y: 12, z: mo.sneak ? 4 : 0 }, r: { x: -swing, y: 0, z: 0 } },
    };
    Object.assign(s, { time: t, dt, alpha: t * 20 - nowTick, pos: tickCur, yaw: mo.yaw, bones: lagged ?? bones, ui: 0 });
    prog(v, query(s), MATH);
    const cells = evalChannels(v, query(s));
    lagged = bones;
    // UI pass in the same frame must not change any world state.
    const before = JSON.stringify(Object.entries(v).filter(([k]) => !["cwon", "cwaz"].includes(k)));
    s.ui = 1; prog(v, query(s), MATH); evalChannels(v, query(s)); s.ui = 0;
    if (JSON.stringify(Object.entries(v).filter(([k]) => !["cwon", "cwaz"].includes(k))) !== before) m.uiLeak++;

    if (Object.values(cells).some(cl => Object.values(cl).some(x => !Number.isFinite(x)))) m.nan++;
    if (!v.cwok) { m.prevU = null; continue; }  // warm-up: the cape is drawn at rest, nothing simulated yet
    const pt = (r, c) => particle(v, r, c, armorZ);
    const total = { seam: m.seam, fit: m.fit, stretch: m.stretch };
    m.seam = m.fit = m.stretch = 0;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const cl = cells[`${r},${c}`];
      for (const [dr, dc] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
        const p = place(cl, r, c, corner(r + dr, c + dc));
        m.fit = Math.max(m.fit, len(sub(p, pt(r + dr, c + dc))));
        // Same corner as rendered by the neighbouring cells.
        for (const [nr, nc] of [[r + dr - 1, c + dc - 1], [r + dr - 1, c + dc], [r + dr, c + dc - 1], [r + dr, c + dc]])
          if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS && (nr !== r || nc !== c))
            m.seam = Math.max(m.seam, len(sub(p, place(cells[`${nr},${nc}`], nr, nc, corner(r + dr, c + dc)))));
      }
    }
    for (let r = 0; r <= ROWS; r++) for (let c = 0; c <= COLS; c++) {
      if (c < COLS && r > 0) m.stretch = Math.max(m.stretch, len(sub(pt(r, c + 1), pt(r, c))) / W);
      if (r < ROWS) m.stretch = Math.max(m.stretch, len(sub(pt(r + 1, c), pt(r, c))) / H);
    }
    for (const k of ["seam", "fit", "stretch"]) { (m.series[k] ??= []).push(m[k]); m[k] = Math.max(total[k], m[k]); }
    if (t > 1.5 && t < 2) for (let r = 1; r <= ROWS; r++) for (let c = 0; c <= COLS; c++)
      m.restDrift = Math.max(m.restDrift, len(sub(pt(r, c), [restX(c), restY(r), ZMID + armorZ])));
    // While walking: how far the legs kick the hem back, and how deep a leg pokes through the cape.
    const [k0, k1] = opt.kickWindow ?? [2.5, 4];
    if (t > k0 && t < k1) {
      const B = euler(bones.body.r.x, bones.body.r.y, bones.body.r.z), bt = [bones.body.t.x, bones.body.t.y, bones.body.t.z];
      for (const leg of [bones.rightleg, bones.leftleg]) {
        const L = euler(leg.r.x, leg.r.y, leg.r.z), lt = [leg.t.x, leg.t.y, leg.t.z];
        for (let r = 4; r <= ROWS; r++) for (let c = 0; c <= COLS; c++) {
          const d = sub(mul(B, sub(pt(r, c), [0, 24, 0])).map((x, k) => x + bt[k]), lt);
          const loc = [0, 1, 2].map(j => L[0][j] * d[0] + L[1][j] * d[1] + L[2][j] * d[2]);
          if (Math.abs(loc[0]) < 2 && loc[1] < 0 && loc[1] > -12 && loc[2] > -2) m.legClip = Math.max(m.legClip, 2 - (loc[2] - 0.5));
        }
      }
      m.kick = Math.max(m.kick, ...[...Array(COLS + 1).keys()].map(c => pt(ROWS, c)[2] - ZMID - armorZ));
    }
    // Running: lift angle of the hem, sideways sway of the hem centre, hem width (crumpling).
    const [s0, s1] = opt.runWindow ?? [5, 6];
    if (t > s0 && t < s1) {
      const hem = [...Array(COLS + 1).keys()].map(c => pt(ROWS, c));
      const mid = [0, 1, 2].map(k => hem.reduce((n, p) => n + p[k], 0) / hem.length);
      m.lift.push(Math.atan2(mid[2] - ZMID - armorZ, 24 - mid[1]) / D);
      // Ripple: how far mid-cape row 3 moves in and out over the run (0 = a rigid board).
      const row = [...Array(COLS + 1).keys()].map(c => pt(3, c)[2]), z3 = row.reduce((a, b) => a + b) / row.length;
      m.rippleMin = Math.min(m.rippleMin ?? z3, z3); m.rippleMax = Math.max(m.rippleMax ?? z3, z3);
      m.sway = Math.max(m.sway ?? 0, Math.abs(mid[0]));
      m.width = Math.min(m.width ?? 1, len(sub(hem[COLS], hem[0])) / 10);
    }
    // Largest per-frame jump of any particle while nothing resets (rebase must be invisible).
    const u = [...Array((ROWS + 1) * (COLS + 1)).keys()].map(i => pt(Math.floor(i / (COLS + 1)), i % (COLS + 1)));
    // Steady running only: the cape legitimately swings up fast when a sprint starts.
    if (m.prevU && t > (opt.runWindow?.[0] ?? 1) && !(t > 12.45 && t < 12.6)) m.jumpPx = Math.max(m.jumpPx, ...u.map((p, i) => len(sub(p, m.prevU[i]))));
    m.prevU = u;
  }
  return m;
}

const sprintOnly = t => ({ speed: t < 1 ? 0 : 5.6, yaw: 0, sneak: false, jump: 0, teleport: 0 });
// Legs swing at walking pace but the player does not move: isolates what the legs do to the cape.
const legsOnly = () => ({ speed: 0, swing: 4.3, yaw: 0, sneak: false, jump: 0, teleport: 0 });
const cases = [
  ["60fps", { fps: 60 }], ["30fps", { fps: 30 }], ["144fps", { fps: 144 }],
  ["60fps chestplate", { fps: 60, armorZ: 1 }], ["sprint 20s", { fps: 60, seconds: 20, scenario: sprintOnly, runWindow: [3, 20] }],
  ["legs swing in place", { fps: 60, seconds: 6, scenario: legsOnly, kickWindow: [1, 6] }],
];
if (process.env.CHECK_CASES) cases.splice(0, cases.length, ...cases.filter(([n]) => process.env.CHECK_CASES.split(",").includes(n)));
const fmt = n => n.toFixed(3);
let ok = true;
const check = (name, value, pass) => { console.log(`  ${pass ? "ok  " : "FAIL"} ${name.padEnd(22)} ${value}`); ok &&= pass; };

// Fresh instances: channels before any anim_time_update, and a UI-only paperdoll instance.
function freshTest() {
  const rest = { ui: 1, time: 0, dt: 1 / 60, alpha: 0, pos: [0, 64, 0], yaw: 0, armorZ: 0,
    bones: { body: { t: { x: 0, y: 24, z: 0 }, r: { x: 0, y: 0, z: 0 } }, rightleg: { t: { x: -1.9, y: 12, z: 0 }, r: { x: 0, y: 0, z: 0 } },
      leftleg: { t: { x: 1.9, y: 12, z: 0 }, r: { x: 0, y: 0, z: 0 } } } };
  try {
    evalChannels(strict({}), query(rest));
    const v = strict({});
    let cells;
    for (let f = 0; f < 5; f++) { rest.time = f / 60; prog(v, query(rest), MATH); cells = evalChannels(v, query(rest)); }
    const off = Object.values(cells).flatMap(cl => [cl.rx, cl.ry, cl.rz, cl.px, cl.py, cl.pz, cl.iz, cl.sx - 1, cl.sy - 1]);
    return Math.max(...off.map(Math.abs)) < 1e-9 ? "ok" : "UI pose not at rest";
  } catch (e) { return e.message; }
}

console.log(`anim_time_update ${toMolang(program()).length} chars (limit 61500)`);
check("fresh instance / UI only", freshTest(), freshTest() === "ok");
check("affine fit error px", affineTest().toExponential(2), affineTest() < 1e-4);
for (const [name, opt] of cases) {
  const m = run(opt), lift = m.lift.length ? m.lift.reduce((a, b) => a + b) / m.lift.length : 0;
  console.log(name);
  check("NaN frames", m.nan, m.nan === 0);
  check("UI pass changed state", m.uiLeak, m.uiLeak === 0);
  check("rest drift px", fmt(m.restDrift), opt.scenario || m.restDrift < 0.6);
  // Judged on the 99th percentile frame; the single worst frame is printed alongside.
  const p99 = k => [...m.series[k]].sort((a, b) => a - b)[Math.floor(m.series[k].length * 0.99)];
  check("link stretch p99/max", `${fmt(p99("stretch"))} / ${fmt(m.stretch)}`, p99("stretch") < 1.15);
  check("seam gap px p99/max", `${fmt(p99("seam"))} / ${fmt(m.seam)}`, p99("seam") < 1);
  const open = m.series.seam.filter(x => x > 2 * OVERLAP).length / m.series.seam.length;
  console.log(`  info frames with a crack wider than the ${2 * OVERLAP}px overlap: ${(open * 100).toFixed(2)}%`);
  check("corner fit px p99/max", `${fmt(p99("fit"))} / ${fmt(m.fit)}`, p99("fit") < 1);
  if (!opt.scenario) check("sprint lift deg", lift.toFixed(1), lift > 10 && lift < 85);
  if (!opt.scenario || opt.kickWindow) console.log(`  info hem kick px ${fmt(m.kick)}, leg clip px ${fmt(m.legClip)}`);
  if (opt.runWindow) console.log(`  info run: lift ${lift.toFixed(1)} deg, hem sway px ${fmt(m.sway)}, min hem width ${fmt(m.width)}, ripple px ${fmt(m.rippleMax - m.rippleMin)}`);
  // Pose snaps (sneak toggle) legitimately move the cloth; only the rebase must be invisible.
  if (opt.scenario) check("max per-frame jump px", fmt(m.jumpPx), m.jumpPx < 3);
}
process.exit(ok ? 0 : 1);
