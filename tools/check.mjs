import { upperBone } from './test-player.mjs';
// Runs the generated Molang (printed as JS) against a scripted player and reports
// seams, parallelogram fit, stretch, lift and UI isolation. It verifies our own math
// and logic only; Bedrock's real transform conventions still need the in-game test.
import assert from "node:assert/strict";
import { program, sections, channels, initDefaults, pid, restX, restY, COLS, ROWS, W, H, ZMID, OVERLAP, TOP_OVERLAP, MESH_LIMIT, bones, renderController, CLAMP_ROW } from "./cloth.mjs";
import { toMolang, compileJs, jsReturn, MATH, strict, checkMolang, compactNames } from "./molang.mjs";
import { burnVar } from './burn.mjs';

const D = Math.PI / 180, key = i => i.toString(36), PX = 16 / 0.9375;
checkMolang(toMolang(program()), "anim_time_update");
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
  const pv = [restX(c) + W / 2, restY(r) - H(r) / 2, ZMID];
  let d = mul(euler(0, 0, cell.iz), sub(p, pv));
  d = [d[0] * cell.sx, d[1] * cell.sy, d[2]];
  d = mul(euler(cell.rx, cell.ry, cell.rz), d);
  return [pv[0] + cell.px + d[0], pv[1] + cell.py + d[1], pv[2] + cell.pz + d[2]];
}
// Measure the actual baked cuboids along each shared edge, including thickness.
// A raw corner mismatch can be covered by the overlap and is not itself a crack.
function seamBox(cl,r,c,v) {
  const pivot=[restX(c)+W/2,restY(r)-H(r)/2,ZMID],outer=euler(cl.rx,cl.ry,cl.rz),inner=euler(0,0,cl.iz);
  const transform=p=>{
    const d=sub(p,pivot.map((x,k)=>x+[cl.px,cl.py,cl.pz][k]));
    const local=[0,1,2].map(j=>outer[0][j]*d[0]+outer[1][j]*d[1]+outer[2][j]*d[2]);
    local[0]/=cl.sx;local[1]/=cl.sy;
    return [0,1,2].map(j=>inner[0][j]*local[0]+inner[1][j]*local[1]+inner[2][j]*local[2]+pivot[j]);
  };
  const mask=v.__opt('cc'+key(r*COLS+c)+'variant')??((c>0?1:0)+(c<COLS-1?2:0)+(r<ROWS-1?8:0));
  const lo=[restX(c)-(mask&1?OVERLAP:0),restY(r+1)-(mask&8?TOP_OVERLAP:0),2],hi=[restX(c+1)+(mask&2?OVERLAP:0),restY(r)+(r?TOP_OVERLAP:0),3];
  const interval = (p,q)=>{
    const a=transform(p),b=transform(q);let enter=0,exit=1;
    for(let k=0;k<3;k++) {
      const d=b[k]-a[k];
      if(Math.abs(d)<1e-8){if(a[k]<lo[k]-1e-4||a[k]>hi[k]+1e-4)return [1,0];}
      else {let t0=(lo[k]-a[k]-1e-4)/d,t1=(hi[k]-a[k]+1e-4)/d;if(t0>t1)[t0,t1]=[t1,t0];enter=Math.max(enter,t0);exit=Math.min(exit,t1);}
    }
    return [enter,exit];
  };
  return Object.assign(interval,{lo,hi});
}
const corner = (r, c) => [restX(c), restY(r), ZMID];
// The collar includes the armour clearance; the query's raw locator offset
// alone is no longer its rendered position.
// Measure actual solver points separately from the shared faired display mesh.
const particle = (v, r, c, az) => {
  if(r===0)return [restX(c),24,ZMID+v.cwaz];
  const d=['x','y','z'].map(a=>v[`cp${key(pid(r,c))}${a}`]-v['cwk'+a]);
  return [0,1,2].map(k=>v['cwg0'+k]*d[0]+v['cwg1'+k]*d[1]+v['cwg2'+k]*d[2]+(k===1?24:0));
};
const displayPoint = (v,r,c) => r===0?[restX(c),24,ZMID+v.cwaz]:['x','y','z'].map(a=>v[`cu${key(pid(r,c))}${a}`]);

// Mock worlds: solid(x,y,z) on integer block cells, an optional water surface height, rain.
// "room" (floor at y 63, roof from y 66) keeps the original cases indoors and windless.
const ROOM = { solid: (x, y) => y <= 63 || y >= 66 };
const OPEN = { solid: (x, y) => y <= 63 };
const PICKAXE = "minecraft:is_pickaxe_item_destructible", AXE = "minecraft:is_axe_item_destructible";
const SHOVEL = "minecraft:is_shovel_item_destructible", SHEARS = "minecraft:is_shears_item_destructible";
function query(s) {
  const w = s.world ?? ROOM, P = s.pos ?? [0, 64, 0];
  const wet = (x, y, z) => w.water !== undefined && y < w.water;
  const roofed = [1, 2, 3, 4, 5, 6].some(d => w.solid(Math.floor(P[0]), Math.floor(P[1]) + d, Math.floor(P[2])));
  const tagsAt = (x, y, z) => w.tags?.(x, y, z) ?? (wet(x, y, z) ? ["water"] :
    w.snow?.(x, y, z) ? ["snow", SHOVEL] : w.solid(x, y, z) ? [PICKAXE] : []);
  const blockTags = (all, x, y, z, tags) => {
    s.queries = (s.queries ?? 0) + 1;
    const present = tagsAt(Math.floor(x), Math.floor(y), Math.floor(z));
    return +(all ? tags.every(tag => present.includes(tag)) : tags.some(tag => present.includes(tag)));
  };
  return {
    // q.position(1) is the player's eye, 1.62 above the feet, as in game.
    anim_time: () => s.animTime ?? Math.min(s.time,.5), life_time: () => s.time, delta_time: () => s.dt, frame_alpha: () => s.alpha, position: k => s.pos[k] + (k === 1 ? 1.62 : 0),
    body_y_rotation: () => s.yaw, is_riding: () => 0, bone_orientation_trs: name => s.bones[name] ?? upperBone(name), get_root_locator_offset: () => s.armorZ,
    has_armor_slot: slot => {
      assert.ok(!s.ui && !s.noEntity, 'query.has_armor_slot requires entity context');
      return +(slot === 1 && (s.chestplate ?? s.armorZ > 0));
    },
    has_cape: () => 1, is_in_ui: () => s.ui, is_spectator: () => 0, is_item_name_any: () => 0, is_on_ground: () => +(s.grounded ?? true),
    time_stamp: () => s.stamp ?? 0, is_in_water: () => +wet(...P), is_in_contact_with_water: () => +wet(P[0], P[1] - 0.1, P[2]),
    is_in_lava: () => 0, is_in_water_or_rain: () => +(wet(...P) || (!!w.rain && !roofed)),
    entity_biome_has_any_tags: (...tags) => +tags.some(t => (w.biome ?? []).includes(t)),
    time_of_day: () => w.time ?? 0.25, cape_flap_amount: () => s.flap ?? 0, is_on_fire: () => +!!s.fire,
    is_local_player: () => +!s.viewer, distance_from_camera: () => s.viewer?.dist ?? 50,
    rotation_to_camera: k => s.viewer?.rot[k] ?? 0,
    // Absolute block cells only (the relative query is eye-based for players and not mocked).
    block_has_any_tag: (x, y, z, ...tags) => blockTags(false, x, y, z, tags),
    block_has_all_tags: (x, y, z, ...tags) => blockTags(true, x, y, z, tags),
  };
}

// Evaluate every channel in a random order; returns {"r,c": cell fields}.
const prepareWeights = compileJs(sections().weights);
function evalChannels(v, q) {
  if (v.__opt('cwon') && !v.__opt('cwok')) prepareWeights(v,q,MATH);
  const order = chans.map(ch => [Math.random(), ch]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
  const cells = {};
  for (const ch of order) (cells[`${ch.r},${ch.c}`] ??= {})[ch.field] = ch.fn(v, q, MATH);
  return cells;
}
// Exact case: particles on an affine image of the rest grid must give zero fit error.
function affineTest() {
  const M = [[1.1, 0.35, 0.2], [-0.15, 0.85, 0.3], [0.25, -0.2, 0.95]], pv = [0, 24, ZMID];
  const v = strict({ ...initDefaults(), cwin: 1, cwon: 1, cwlt: 1, cwst: 1, cwaz: 0 }), q = query({ ui: 0 });
  for (let r=1;r<ROWS;r++) for(let c=0;c<COLS;c++) v['ct'+key(r*COLS+c)]=1;
  for (let r = 1; r <= ROWS; r++) for (let c = 0; c <= COLS; c++) {
    const p = mul(M, sub(corner(r, c), pv)).map((x, k) => x + pv[k]);
    ["x", "y", "z"].forEach((a, k) => v[`cu${key(pid(r, c))}${a}`] = p[k]);
    v[`cu${key(pid(r, c))}t`] = 1;
  }
  const cells = evalChannels(v, q);
  let err = 0;
  for (let r = 1; r < ROWS; r++) for (let c = 0; c < COLS; c++)
    for (const [dr, dc] of [[0, 0], [0, 1], [1, 0], [1, 1]])
        err = Math.max(err, len(sub(place(cells[`${r},${c}`], r, c, corner(r + dr, c + dc)), ['x','y','z'].map(a=>v[`cu${key(pid(r+dr,c+dc))}${a}`]))));
  return err;
}

// Exercise the display conversion itself: flat/affine cloth must stay exact,
// including the unequal shoulder row, and missing fabric must not pull its edge.
function displayMeshTest() {
  const make = () => {
    const v = strict({ ...initDefaults(), cwin: 1, cwon: 1, cwlt: 1, cwst: 1, cwaz: 0 });
    for (const a of ['x', 'y', 'z']) v['cwk' + a] = 0;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) v['cwg' + r + c] = +(r === c);
    for (let r = 1; r < ROWS; r++) for (let c = 0; c < COLS; c++) v['ct' + key(r * COLS + c)] = 1;
    for (let r = 0; r <= ROWS; r++) for (let c = 0; c <= COLS; c++) {
      // An affine plane that keeps the collar fixed.
      const dy = restY(r) - 24, p = [restX(c) + 0.35 * dy, 0.85 * dy, ZMID - 0.2 * dy];
      ['x', 'y', 'z'].forEach((a, k) => v['cp' + key(pid(r, c)) + a] = p[k]);
    }
    return v;
  };
  const q = query({ ui: 0 }), v = make();
  evalChannels(v, q);
  for (let r = 1; r <= ROWS; r++) for (let c = 0; c <= COLS; c++)
    assert.ok(len(sub(displayPoint(v, r, c), particle(v, r, c))) < 1e-8, 'display fairing preserves an affine surface');
  const cut = make(), changed = make();
  for (const state of [cut, changed])
    for (let r = 2; r < ROWS; r++) for (let c = 0; c < COLS; c++) state['ct' + key(r * COLS + c)] = 0;
  // The next row belongs entirely to burnt fabric. Moving it cannot pull on
  // the surviving edge at row 2, even while its hidden particles still exist.
  for (let c = 0; c <= COLS; c++) changed['cp' + key(pid(3, c)) + 'z'] += 20;
  evalChannels(cut, q); evalChannels(changed, q);
  for (let c = 0; c <= COLS; c++)
    assert.deepEqual(displayPoint(cut, 2, c), displayPoint(changed, 2, c), 'burnt neighbours cannot affect the surviving edge');
  return 'ok';
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
  const { fps, seconds = 14, armorZ = 0, scenario = motion, world = ROOM, stamp = 0 } = opt;
  const v = strict({}), s = { ui: 0, armorZ, world, chestplate: opt.chestplate };
  let t = 0, dt = 1 / fps;
  let path = [0, 64 + (opt.floorOffset ?? 0), 0], phase = 0, tickPrev = null, tickCur = null, tick = -1, lagged = null;
  const m = { nan: 0, uiLeak: 0, seam: 0, fit: 0, stretch: 0, extension: 0, crack:0, ridge:0, meshOffset:0, physicsFit:0, restDrift: 0, lift: [], jumpPx: 0, prevU: null, series: {}, kick: 0, legClip: 0 };
  for (let f = 0; t < seconds; f++, t += dt) {
    dt = (1 + (opt.jitter ?? 0) * Math.sin(f * 2.39996)) / fps;
    const mo = scenario(t);
    const fwd = [-Math.sin(mo.yaw * D), 0, Math.cos(mo.yaw * D)];
    const legSpeed = mo.swing ?? mo.speed;
    path = path.map((x, k) => x + fwd[k] * mo.speed * dt); phase += legSpeed * dt;
    const target = [path[0] + mo.teleport + (opt.start?.[0] ?? 0), path[1] + mo.jump + (mo.rise ?? 0) * t, path[2] + (opt.start?.[1] ?? 0)];
    const nowTick = Math.floor(t * 20 + 0.001);
    if (nowTick !== tick) { tickPrev = tickCur ?? target; tickCur = target; tick = nowTick; }
    // Vanilla move.legs: tcos0*1.4 with tcos0 = cos(...)*modified_move_speed*57.3, i.e. up to ±80°.
    const swing = Math.sin(phase * 140) * Math.min(1, legSpeed * 0.2) * 80;
    const bones = {
      body: { t: { x: 0, y: 24, z: 0 }, r: { x: mo.sneak ? 28.65 : 0, y: 0, z: 0 } },
      rightleg: { t: { x: -1.9, y: 12, z: mo.sneak ? 4 : 0 }, r: { x: swing, y: 0, z: 0 } },
      leftleg: { t: { x: 1.9, y: 12, z: mo.sneak ? 4 : 0 }, r: { x: -swing, y: 0, z: 0 } },
    };
    Object.assign(s, { time: t, dt, alpha: t * 20 - nowTick, pos: tickCur, yaw: mo.yaw, bones: lagged ?? bones, ui: 0, stamp: stamp + nowTick,
      viewer: opt.viewer?.(t, tickCur), fire: opt.fire?.(t), grounded: mo.grounded ?? (mo.jump === 0 && !mo.rise) });
    prog(v, query(s), MATH);
    opt.inspect?.(v, s);
    const cells = evalChannels(v, query(s));
    lagged = bones;
    // UI pass in the same frame must not change any world state.
    const before = JSON.stringify(Object.entries(v).filter(([k]) => !["cwon", "cwaz"].includes(k)));
    s.ui = 1; prog(v, query(s), MATH); evalChannels(v, query(s)); s.ui = 0;
    if (JSON.stringify(Object.entries(v).filter(([k]) => !["cwon", "cwaz"].includes(k))) !== before) m.uiLeak++;
    // Restore this pass's model offset and output gate before measuring world geometry.
    prog(v, query(s), MATH);

    if (Object.values(cells).some(cl => Object.values(cl).some(x => !Number.isFinite(x)))) m.nan++;
    if (!v.cwok) { m.prevU = null; continue; }  // warm-up: the cape is drawn at rest, nothing simulated yet
    // Sleep while standing (t 1..2), whether walking wakes it, and simulated steps per second.
    if (t > 1 && t < 2) { m.standFrames = (m.standFrames ?? 0) + 1; if (v.cwqt >= 30) m.asleep = (m.asleep ?? 0) + 1; }
    if (t > 2.1 && t < 4 && v.cwqt >= 30) m.sleptWalking = (m.sleptWalking ?? 0) + 1;
    if (v.cwst !== m.lastStamp) { m.stamps = (m.stamps ?? 0) + 1; m.lastStamp = v.cwst; }
    // Environment cases: hem offset from rest (body-local), wind, sleep, and how deep any
    // particle sits inside a solid block (clamped rows separately from the upper rows).
    const [e0, e1] = opt.envWindow ?? [3, 8];
    if (opt.env && t > e0 && t < e1) {
      // World heights from the harness truth: remove the code's own feet-height error.
      const bias = v.cwcy - s.pos[1];
      const hem = [...Array(COLS + 1).keys()].map(c => sub(particle(v, ROWS, c, armorZ), [restX(c), restY(ROWS), ZMID + v.cwaz]));
      m.envN = (m.envN ?? 0) + 1;
      m.deflect = (m.deflect ?? 0) + hem.reduce((n, d) => n + len(d), 0) / hem.length;
      m.hemUp = (m.hemUp ?? 0) + hem.reduce((n, d) => n + d[1], 0) / hem.length;
      m.wind = (m.wind ?? 0) + Math.hypot(v.cwnx, v.cwnz);
      const burnt = Array.from({ length: (ROWS-1)*COLS }, (_, i) => v.__opt(burnVar(1 + Math.floor(i/COLS), i % COLS, 's').slice(2)) ?? 0).filter(s => s === 2 || s === 3).length / COLS;
      m.burnMax = Math.max(m.burnMax ?? 0, burnt); m.burnEnd = burnt;
      if (m.lastBase && Math.abs(v.cwby - m.lastBase) > 1e-9) m.resets = (m.resets ?? 0) + 1;
      m.lastBase = v.cwby;
      const hc = particle(v, ROWS, COLS >> 1, armorZ);
      if (m.hp1 && m.hp2) m.jerk = Math.max(m.jerk ?? 0, len(hc.map((x, k) => x - 2 * m.hp1[k] + m.hp2[k])));
      m.hp2 = m.hp1; m.hp1 = hc;
      if (s.viewer) for (let r = 1; r <= ROWS; r++) for (let c = 0; c <= COLS; c++) {
        const w = ["x", "y", "z"].map(a => v[`cwb${a}`] + v[`cp${key(pid(r, c))}${a}`] / PX - (a === "y" ? bias : 0)), f = s.viewer.feet;
        const d = Math.hypot(w[0] - f[0], w[2] - f[2]);
        if (r >= CLAMP_ROW && w[1] > f[1] && w[1] < f[1] + 1.8 && d < 0.35) m.inViewer = Math.max(m.inViewer ?? 0, (0.35 - d) * PX);
      }
      // Share of free particles below the detected fluid surface.
      let wetN = 0;
      for (let i = COLS + 1; i < (ROWS + 1) * (COLS + 1); i++) if (v[`cp${key(i)}y`] < v.cwfh) wetN++;
      m.wet = (m.wet ?? 0) + wetN / (ROWS * (COLS + 1));
      if (v.cwqt >= 30) m.envSleep = (m.envSleep ?? 0) + 1;
      // Detected fluid surface against the real one (a still water block is 0.9 high here).
      if (opt.surface && v.cwwe) m.surfErr = Math.max(m.surfErr ?? 0, Math.abs(v.cwfh / PX + v.cwby - bias - (opt.surface - 0.1)));
      for (let r = 1; r <= ROWS; r++) for (let c = 0; c <= COLS; c++) {
        const w = ["x", "y", "z"].map((a, k) => v[`cwb${a}`] + v[`cp${key(pid(r, c))}${a}`] / PX - (a === "y" ? bias : 0)), cellOf = w.map(Math.floor);
        if (v.__opt('cm'+key(pid(r,c)))<0.001 || !s.world.solid(...cellOf)) continue;
        // The tag query sees a snow cell; the test world's actual collision top can
        // be lower. Air above a thin snow layer is not penetration.
        const top = cellOf[1] + (s.world.height?.(...cellOf) ?? (s.world.snow?.(...cellOf) ? s.world.snowHeight : 1));
        if (w[1] >= top) continue;
        const depth = Math.min(top - w[1], ...w.map((x, k) => Math.min(x - cellOf[k], cellOf[k] + 1 - x))) * PX;
        if (r >= CLAMP_ROW) m.pen = Math.max(m.pen ?? 0, depth); else m.penTop = Math.max(m.penTop ?? 0, depth);
      }
    }
    const pt = (r, c) => particle(v, r, c, armorZ);
    const total = { seam: m.seam, fit: m.fit, stretch: m.stretch, extension:m.extension,crack:m.crack,ridge:m.ridge };
    m.seam = m.fit = m.stretch = m.extension = m.crack = m.ridge = 0;
    for(let r=1;r<=ROWS;r++)for(let c=0;c<=COLS;c++) {
      const drawn=['x','y','z'].map(a=>v[`cu${key(pid(r,c))}${a}`]);
      m.meshOffset=Math.max(m.meshOffset,len(sub(drawn,pt(r,c))));
    }
    // An ash or an unfolding tile intentionally leaves its original four corners.
    // Measure intact cloth here; check-burn.mjs checks the animated edge/ash frame.
    const intact = (r, c) => !(v.__opt(burnVar(r, c, 's').slice(2)) ?? 0);
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      if (!intact(r, c)) continue;
      const cl = cells[`${r},${c}`];
      for (const [dr, dc] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
        const p = place(cl, r, c, corner(r + dr, c + dc));
        // Fit accuracy refers to the shared display mesh. Record physical
        // deviation separately so smoothing cannot hide solver deformation.
        m.fit = Math.max(m.fit, len(sub(p, displayPoint(v,r+dr,c+dc))));
        m.physicsFit = Math.max(m.physicsFit,len(sub(p,pt(r+dr,c+dc))));
        // Same corner as rendered by the neighbouring cells.
        for (const [nr, nc] of [[r + dr - 1, c + dc - 1], [r + dr - 1, c + dc], [r + dr, c + dc - 1], [r + dr, c + dc]])
          if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS && (Math.abs(nr-r)+Math.abs(nc-c)===1) && intact(nr, nc))
            m.seam = Math.max(m.seam, len(sub(p, place(cells[`${nr},${nc}`], nr, nc, corner(r + dr, c + dc)))));
      }
    }
    const boxes={};
    for(let r=0;r<ROWS;r++)for(let c=0;c<COLS;c++)if(intact(r,c))boxes[r+','+c]=seamBox(cells[r+','+c],r,c,v);
    for(let r=0;r<ROWS;r++)for(let c=0;c<COLS;c++)if(intact(r,c)) {
      for(const [nr,nc] of [[r+1,c],[r,c+1]])if(nr<ROWS&&nc<COLS&&intact(nr,nc)) {
        for(const u of [.1,.25,.5,.75,.9]) {
          const rest=nr>r?[restX(c)+u*W,restY(r+1),ZMID]:[restX(c+1),restY(r)-u*H(r),ZMID];
          const a=place(cells[r+','+c],r,c,rest),b=place(cells[nr+','+nc],nr,nc,rest);
          const ia=boxes[r+','+c](a,b),ib=boxes[nr+','+nc](a,b);
          const gap=Math.max(0,ib[0]-ia[1])*len(sub(a,b));
          if(ia[0]>1e-3||ib[1]<0.999)throw new Error('seam interval endpoint mismatch');
          m.crack=Math.max(m.crack,gap);
          // Protrusion of an extended edge beyond its neighbour's surface,
          // on both faces. A watertight overlap can still look like a raised plate.
          const ca=cells[r+','+c],cb=cells[nr+','+nc],ba=boxes[r+','+c],bb=boxes[nr+','+nc];
          const pa=p=>place(ca,r,c,p),pb=p=>place(cb,nr,nc,p);
          const na=sub(pa([...rest.slice(0,2),3]),pa([...rest.slice(0,2),2]));
          const nb=sub(pb([...rest.slice(0,2),3]),pb([...rest.slice(0,2),2]));
          const dot=(a,b)=>a.reduce((n,x,k)=>n+x*b[k],0);
          for(const sign of [-1,1]) {
            const face=[...rest];face[2]+=sign*.5;
            const ea=[...face],eb=[...face],axis=nc>c?0:1;
            ea[axis]=nc>c?ba.hi[0]:ba.lo[1];eb[axis]=nc>c?bb.lo[0]:bb.hi[1];
            m.ridge=Math.max(m.ridge,sign*dot(nb,sub(pa(ea),pb(face))),sign*dot(na,sub(pb(eb),pa(face))));
          }
        }
      }
    }
    const attachment=(r,c)=>r<0||r>=ROWS||c<0||c>=COLS?0:r===0?1:(v.__opt('ct'+key(r*COLS+c))??1);
    const strain=(distance,rest)=>{m.stretch=Math.max(m.stretch,distance/rest);m.extension=Math.max(m.extension,distance-rest);};
    for (let r=0;r<=ROWS;r++)for(let c=0;c<=COLS;c++) {
      if(c<COLS&&r>0&&Math.max(attachment(r-1,c),attachment(r,c))>0.99)strain(len(sub(pt(r,c+1),pt(r,c))),W);
      if(r<ROWS&&Math.max(attachment(r,c-1),attachment(r,c))>0.99)strain(len(sub(pt(r+1,c),pt(r,c))),H(r));
    }
    for (const k of ["seam", "fit", "stretch", "extension", "crack", "ridge"]) { (m.series[k] ??= []).push(m[k]); m[k] = Math.max(total[k], m[k]); }
    if (t > 1.5 && t < 2) for (let r = 1; r <= ROWS; r++) for (let c = 0; c <= COLS; c++)
      m.restDrift = Math.max(m.restDrift, len(sub(pt(r, c), [restX(c), restY(r), ZMID + v.cwaz])));
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
      m.kick = Math.max(m.kick, ...[...Array(COLS + 1).keys()].map(c => pt(ROWS, c)[2] - ZMID - v.cwaz));
    }
    // Running: lift angle of the hem, sideways sway of the hem centre, hem width (crumpling).
    const [s0, s1] = opt.runWindow ?? [5, 6];
    if (t > s0 && t < s1) {
      const hem = [...Array(COLS + 1).keys()].map(c => pt(ROWS, c));
      const mid = [0, 1, 2].map(k => hem.reduce((n, p) => n + p[k], 0) / hem.length);
      m.lift.push(Math.atan2(mid[2] - ZMID - v.cwaz, 24 - mid[1]) / D);
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
  ["chestplate zero locator", { fps: 60, armorZ: 0, chestplate: true, inspect: v => assert.equal(v.cwaz, 1.5, 'equipment enables armour clearance with a zero locator') }],
  ["legs swing in place", { fps: 60, seconds: 6, scenario: legsOnly, kickWindow: [1, 6] }],
];
// Same wind direction formula as cloth.mjs wind(): find a level time whose wind blows
// toward -z (from the player's face to the back, yaw 0) with a clear base speed.
function windStamp(deg) {
  const s = x => Math.sin(x * D);
  for (let ts = 0; ts < 1e6; ts++) {
    const wa = ts * 0.041 + s(ts * 0.023) * 120, diff = ((wa - deg) % 360 + 540) % 360 - 180;
    if (Math.abs(diff) < 2 && 0.9 + 0.5 * s(ts * 0.07) > 1.1) return ts;
  }
  throw new Error("no wind stamp");
}
const stand = () => ({ speed: 0, yaw: 0, sneak: false, jump: 0, teleport: 0 });
const back = windStamp(270);
const walls = (...cells) => (x, y, z) => y <= 63 || cells.some(([cx, cy, cz]) => cx === x && cy === y && cz === z);
const standCase = (world, extra = {}) => ({ fps: 60, seconds: 8, scenario: stand, env: true, start: [0.5, 0.35], stamp: back, world, ...extra });
const envCases = [
  ["outdoor stand", standCase(OPEN)],
  ["rain stand", standCase({ ...OPEN, rain: true })],
  ["corridor stand", standCase({ solid: walls([-1, 64, 0], [-1, 65, 0], [1, 64, 0], [1, 65, 0]) })],
  ["sheltered stand", standCase({ solid: walls([0, 65, 1]) })],
  ["roofed stand", standCase(ROOM)],
  // A block behind the player at foot level; the wind presses the cape onto it.
  ["step behind stand", standCase({ solid: walls([0, 64, -1]), rain: true }, { start: [0.75, 0.32] })],
  // Back pressed flat against a wall (feet 0.3 from the face, as Bedrock's collision leaves it).
  ["back to wall stand", standCase({ solid: (x, y, z) => y <= 63 || (z === -1 && y <= 65), rain: true }, { start: [0.5, 0.3] })],
  // Sprinting with the left side flush against a long wall.
  ["sprint along wall", standCase({ solid: (x, y) => y <= 63 || (x === -1 && y <= 65) }, {
    start: [0.3, 0.5], scenario: t => ({ speed: t < 1 ? 0 : 5.6, yaw: 0, sneak: false, jump: 0, teleport: 0 }) })],
  ["underwater stand", standCase({ ...OPEN, water: 67 })],
  // Treading water: feet bob through the top water block (surface at y 66, so 65.9 detected).
  ["treading water", standCase({ ...OPEN, water: 66 }, {
    scenario: t => ({ speed: 0, yaw: 0, sneak: false, jump: 1.45 + 0.3 * Math.sin(t * 2.3), teleport: 0 }), surface: 66 })],
  ["outdoor stand 144fps", standCase(OPEN, { fps: 144 })],
  // Running through water two blocks deep in the rain: the whole cape is under the surface
  // and no wind may reach it.
  // A block diagonally behind the player at hip height; the wind lays the cape over its corner.
  ["diagonal block stand", standCase({ solid: walls([1, 64, -1], [1, 65, -1]), rain: true }, { start: [0.75, 0.32] })],
  // Falling near terminal speed (78 b/s) while drifting, and flying up, at uneven frame times.
  ["fast fall 144fps jitter", standCase({ solid: () => false }, { fps: 144, jitter: 0.3, envWindow: [2, 5], seconds: 5,
    scenario: t => ({ speed: t < 1 ? 0 : 4, yaw: 0, sneak: false, jump: 0, teleport: 0, rise: t < 1 ? 0 : -78 }) })],
  ["fly up 59fps jitter", standCase({ solid: () => false }, { fps: 59, jitter: 0.15, envWindow: [2, 5], seconds: 5,
    scenario: t => ({ speed: 0, yaw: 0, sneak: false, jump: 0, teleport: 0, rise: t < 1 ? 0 : 7 }) })],
  // Another player stands just behind and slightly to the side; the wind blows the cape into them.
  ["other player behind", standCase({ ...OPEN, rain: true }, {
    viewer: (t, p) => { const feet = [p[0] + 0.15, p[1], p[2] - 0.75], eye = [feet[0], feet[1] + 1.62, feet[2]];
      const d = eye.map((x, k) => x - [p[0], p[1] + 1.62, p[2]][k]), dist = Math.hypot(...d), h = Math.hypot(d[0], d[2]);
      return { feet, dist, rot: [-Math.atan2(d[1], h) / D, Math.atan2(-d[0], d[2]) / D] }; } })],
  // Indoors (no wind): standing, then 8 s on fire, then 8 s out of it.
  ["fire indoors", standCase(ROOM, { fire: t => t > 3 && t < 11, envWindow: [5, 11], seconds: 19 })],
  ["sprint on fire", standCase(OPEN, { fire: t => t > 1, envWindow: [3, 8], scenario: t => ({ speed: t < 1 ? 0 : 5.6, yaw: 0, sneak: false, jump: 0, teleport: 0 }) })],
  ["after the fire", standCase(ROOM, { fire: t => t > 3 && t < 11, envWindow: [14, 19], seconds: 19 })],
  ["run in water", standCase({ ...OPEN, water: 66, rain: true }, { surface: 66,
    scenario: t => ({ speed: t < 1 ? 0 : 2, yaw: 0, sneak: false, jump: 0, teleport: 0 }) })],
];
cases.push(...envCases);
// Regression: full-cube snow around the excluded player cell used to squeeze a
// 10 px hem to less than 1 px. Keep real stone walls in the same snow-covered ring.
const snowWorld = { solid: (x, y) => y <= 64 || y >= 66, snow: (x, y) => y === 64, snowHeight: 0.125 };
const snowWalk = yaw => t => ({ speed: t < 0.5 ? 0 : 2, yaw, sneak: false, jump: 0, teleport: 0 });
cases.push(
  ["snow walk edge", standCase(snowWorld, { floorOffset: 0.125, start: [0.05, 0.15], seconds: 6, scenario: snowWalk(0), runWindow: [0.6, 6], minHemWidth: 0.8 })],
  ["snow walk centre", standCase(snowWorld, { floorOffset: 0.125, start: [0.5, 0.15], seconds: 6, scenario: snowWalk(0), runWindow: [0.6, 6], minHemWidth: 0.8 })],
  ["snow walk diagonal", standCase(snowWorld, { floorOffset: 0.125, start: [0.05, 0.15], seconds: 6, scenario: snowWalk(45), runWindow: [0.6, 6], minHemWidth: 0.8 })],
  ["snow beside stone wall", standCase({ ...snowWorld, solid: (x, y) => y <= 64 || y >= 66 || (x === -1 && y <= 65), snow: (x, y) => x !== -1 && y === 64 },
    { floorOffset: 0.125, start: [0.3, 0.15], seconds: 6, scenario: snowWalk(0), runWindow: [0.6, 6] })],
);
// Non-full supporting blocks use real heights independently of the query mock.
// In particular, slab and full stone share the same tags: the player's footprint
// must establish support without deleting a full wall beside it.
const partialWorld = (height, tags) => ({ ...ROOM, solid: (x, y) => y <= 64 || y >= 67,
  height: (x, y) => y === 64 ? height : 1,
  tags: (x, y) => y === 64 ? tags : y <= 63 || y >= 67 ? [PICKAXE] : [] });
const partialWalk = (world, height, extra = {}) => standCase(world, {
  floorOffset: height, start: [0.05, 0.15], seconds: 6, scenario: snowWalk(0), runWindow: [0.6, 6], minHemWidth: 0.8, ...extra });
cases.push(
  ["stone slab walk edge", partialWalk(partialWorld(0.5, [PICKAXE]), 0.5)],
  ["stone slab walk centre", partialWalk(partialWorld(0.5, [PICKAXE]), 0.5, { start: [0.5, 0.15] })],
  ["stone slab walk diagonal", partialWalk(partialWorld(0.5, [PICKAXE]), 0.5, { scenario: snowWalk(45) })],
  ["wood slab walk", partialWalk(partialWorld(0.5, [AXE]), 0.5)],
  ["bed walk", partialWalk(partialWorld(0.625, [AXE]), 0.625)],
  ["farmland walk", partialWalk(partialWorld(0.9375, [SHOVEL]), 0.9375)],
  ["trapdoor walk", partialWalk(partialWorld(0.1875, [AXE, "trapdoors"]), 0.1875)],
  ["rail walk", partialWalk({ ...ROOM, tags: (x, y) => y === 64 ? [PICKAXE, "rail"] : y <= 63 || y >= 66 ? [PICKAXE] : [] }, 0)],
  ["one-way side walk", partialWalk({ ...ROOM, tags: (x, y) => y === 65 ? [AXE, "one_way_collidable"] : y <= 63 || y >= 66 ? [PICKAXE] : [] }, 0)],
  ["slab beside stone wall", standCase({
    solid: (x, y, z) => y <= 64 || (z === -1 && y <= 65), rain: true,
    height: (x, y, z) => y === 64 && z !== -1 ? 0.5 : 1,
  }, { floorOffset: 0.5, start: [0.5, 0.3] })],
  ["shears-only wall", standCase({
    solid: (x, y, z) => y <= 63 || (z === -1 && y <= 65), rain: true,
    tags: (x, y, z) => z === -1 && y >= 64 && y <= 65 ? [SHEARS] : y <= 63 ? [PICKAXE] : [],
  }, { start: [0.5, 0.3] })],
);
const env = {};
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
    let err = 0;
    for (const flap of [0, 0.4, 1]) {
      rest.flap = flap; cells = evalChannels(v, query(rest));
      const R = euler(6 + 126 * flap, 0, 0), pv = [0, 24, ZMID];
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) for (const [dr, dc] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
        const want = mul(R, sub(corner(r + dr, c + dc), pv)).map((x, k) => x + pv[k]);
        err = Math.max(err, len(sub(place(cells[`${r},${c}`], r, c, corner(r + dr, c + dc)), want)));
      }
    }
    return err < 1e-4 ? "ok" : "UI pose is not the vanilla cape: " + err;
  } catch (e) { return e.message; }
}

// Dressing-room previews have geometry but no actor. A positive locator does
// not grant access to equipment/world queries. Also cover HUD paperdolls that
// are excluded by their variable rather than query.is_in_ui.
function uiContextTest() {
  try {
    for (const armorZ of [0, 1]) {
      const s = { ui: 0, noEntity: false, time: 0, dt: 1 / 60, alpha: 0, pos: [0, 64, 0], yaw: 0, armorZ, chestplate: true,
        bones: { body: { t: { x: 0, y: 24, z: 0 }, r: { x: 0, y: 0, z: 0 } },
          rightleg: { t: { x: -1.9, y: 12, z: 0 }, r: { x: 0, y: 0, z: 0 } },
          leftleg: { t: { x: 1.9, y: 12, z: 0 }, r: { x: 0, y: 0, z: 0 } } } };
      const safe = new Set(['is_in_ui', 'get_root_locator_offset', 'cape_flap_amount']);
      const q = new Proxy(query(s), { get(target, name) {
        if (s.noEntity && !safe.has(name)) return () => { throw new Error(`UI queried ${name} without entity context`); };
        return target[name];
      } });
      const preview = (v, paperdoll) => {
        s.ui = +!paperdoll; s.noEntity = true; v.is_paperdoll = +paperdoll;
        prog(v, q, MATH);
        const cells = evalChannels(v, q);
        assert.equal(v.cwon, 0);
        assert.equal(v.cwaz, armorZ, 'preview keeps its own model locator offset');
        assert.ok(Object.values(cells).every(cell => Object.values(cell).every(Number.isFinite)));
        s.ui = 0; s.noEntity = false; v.is_paperdoll = 0;
      };
      for (const paperdoll of [false, true]) preview(strict({}), paperdoll);
      const v = strict({ is_paperdoll: 0 });
      for (let f = 0; f < 20; f++) { s.time = f / 60; prog(v, q, MATH); evalChannels(v, q); }
      assert.equal(v.cwon, 1);
      assert.equal(v.cwaz, 1.5, 'world chestplate clearance is retained');
      for (const paperdoll of [false, true]) {
        const before = { ...v }, worldTime = s.time;
        s.time = 0; preview(v, paperdoll);
        assert.deepEqual({ ...v, cwaz: before.cwaz, cwon: before.cwon }, before, 'preview preserves running simulation');
        s.time = worldTime; prog(v, q, MATH); evalChannels(v, q);
        assert.deepEqual({ ...v }, before, 'same-frame world pass restores its armour offset and output');
      }
      s.armorZ = 0; s.chestplate = false; s.time += 1 / 60;
      prog(v, q, MATH);
      assert.equal(v.cwaz, 0, 'removing chestplate clears the world offset');
    }
    return 'ok';
  } catch (e) { return e.message; }
}

// A cosmetic reload may retain entity variables while restarting its clock and
// rebuilding queryable geometry. The mock deliberately has no bones for 0.09 s.
// This checks that scenario, not whether every Bedrock reload resets life_time.
function reloadTest() {
  try {
    for (const fps of [30, 60, 144]) {
      const s = { ui: 0, time: 100, dt: 1 / fps, alpha: 0, pos: [0, 64, 0], yaw: 0, armorZ: 0,
        bones: { body: { t: { x: 0, y: 24, z: 0 }, r: { x: 0, y: 0, z: 0 } },
          rightleg: { t: { x: -1.9, y: 12, z: 0 }, r: { x: 0, y: 0, z: 0 } },
          leftleg: { t: { x: 1.9, y: 12, z: 0 }, r: { x: 0, y: 0, z: 0 } } } };
      const v = strict({}), q = query(s);
      let ready = true, reads = 0;
      q.bone_orientation_trs = name => {
        assert.ok(ready, `queried ${name} before reloaded geometry was ready (${fps} fps)`);
        reads++; return s.bones[name] ?? upperBone(name);
      };
      for (let f = 0; f < fps / 2; f++) { s.time = 100 + f / fps; prog(v, q, MATH); }
      assert.ok(v.cwok && reads > 0, 'physics running before reload');
      for (const restart of [2, 0]) {
        const before = reads, oldStamp = v.cwst;
        for (let f = 0; f < fps / 3; f++) {
          s.time = restart + f / fps; ready = f / fps >= 0.09;
          prog(v, q, MATH);
          assert.ok(Object.values(evalChannels(v, q)).every(cell => Object.values(cell).every(Number.isFinite)));
          if (!ready) assert.equal(v.cwon, 0, 'warmup uses the safe rest pose');
          const once = { ...v };
          for (let duplicate = 0; duplicate < 4; duplicate++) prog(v, q, MATH);
          assert.deepEqual({ ...v }, once, 'duplicate world passes cannot shorten warmup');
          // UI and paperdoll may use a different clock in the same rendered frame.
          const worldTime = s.time;
          for (const ui of [true, false]) {
            s.ui = +ui; v.is_paperdoll = +!ui; s.time = 0;
            const worldState = { ...v };
            prog(v, q, MATH);
            assert.deepEqual({ ...v, cwon: worldState.cwon }, worldState, 'UI cannot restart world warmup');
            s.ui = 0; v.is_paperdoll = 0; s.time = worldTime;
            prog(v, q, MATH);
            assert.equal(v.cwon, once.cwon, 'world pass restores its visibility');
          }
        }
        assert.ok(v.cwok && reads > before && v.cwst > oldStamp, 'physics resumes after geometry reload');
      }
    }
    return 'ok';
  } catch (e) { return e.message; }
}

const rawUpdate=toMolang(program())+'return 0;', exportedUpdate=compactNames([rawUpdate,JSON.stringify(bones()),JSON.stringify(renderController())]).expression(rawUpdate);
console.log(`anim_time_update ${exportedUpdate.length} chars (limit 61500)`);
check('expression fits limit',exportedUpdate.length,exportedUpdate.length<=61500);
check("fresh instance / UI only", freshTest(), freshTest() === "ok");
const uiContext = uiContextTest();
check('UI without entity context', uiContext, uiContext === 'ok');
const reloaded = reloadTest();
check("geometry reload warmup", reloaded, reloaded === "ok");
check("affine fit error px", affineTest().toExponential(2), affineTest() < 1e-4);
check('shared display mesh / burnt edge', displayMeshTest(), true);
for (const [name, opt] of cases) {
  const m = run(opt), lift = m.lift.length ? m.lift.reduce((a, b) => a + b) / m.lift.length : 0;
  console.log(name);
  check("NaN frames", m.nan, m.nan === 0);
  check("UI pass changed state", m.uiLeak, m.uiLeak === 0);
  check("rest drift px", fmt(m.restDrift), opt.scenario || m.restDrift < 0.6);
  // Judged on the 99th percentile frame; the single worst frame is printed alongside.
  const p99 = k => [...m.series[k]].sort((a, b) => a - b)[Math.floor(m.series[k].length * 0.99)];
  console.log(`  info link stretch p99/max ${fmt(p99("stretch"))} / ${fmt(m.stretch)}, excess px ${fmt(p99("extension"))} / ${fmt(m.extension)}`);
  console.log(`  info unfitted edge mismatch px ${fmt(p99("seam"))} / ${fmt(m.seam)}`);
  // Keep any sampled opening below one tenth of a texture pixel, including abrupt pose changes.
  check("uncovered seam px p99/max",`${fmt(p99("crack"))} / ${fmt(m.crack)}`,m.crack<0.1);
  console.log(`  info surface step px p99/max ${fmt(p99('ridge'))} / ${fmt(m.ridge)}`);
  check('display vertex offset px',fmt(m.meshOffset),m.meshOffset<=MESH_LIMIT+0.0001);
  console.log(`  info max surface / physics deviation px ${fmt(m.physicsFit)}`);
  check("link extension px p99",fmt(p99("extension")),p99("extension")<0.5);
  const open = m.series.seam.filter(x => x > 2 * OVERLAP).length / m.series.seam.length;
  console.log(`  info frames with a crack wider than the ${2 * OVERLAP}px overlap: ${(open * 100).toFixed(2)}%`);
  check("corner fit px p99/max", `${fmt(p99("fit"))} / ${fmt(m.fit)}`, p99("fit") < 1);
  if (!opt.scenario) check("sprint lift deg", lift.toFixed(1), lift > 10 && lift < 85);
  if (!opt.scenario || opt.kickWindow) console.log(`  info hem kick px ${fmt(m.kick)}, leg clip px ${fmt(m.legClip)}`);
  console.log(`  info cell updates/s ${((m.stamps ?? 0) / (opt.seconds ?? 14)).toFixed(1)}, asleep while standing ${(100 * (m.asleep ?? 0) / (m.standFrames || 1)).toFixed(0)}%`);
  if (!opt.scenario) check("wakes when walking", m.sleptWalking ?? 0, !m.sleptWalking);
  if (opt.runWindow) console.log(`  info run: lift ${lift.toFixed(1)} deg, hem sway px ${fmt(m.sway)}, min hem width ${fmt(m.width)}, ripple px ${fmt(m.rippleMax - m.rippleMin)}`);
  if (opt.minHemWidth) check("hem width / rest width", fmt(m.width), m.width >= opt.minHemWidth);
  // Pose snaps (sneak toggle) legitimately move the cloth; only the rebase must be invisible.
  if (opt.scenario && !opt.env) check("max per-frame jump px", fmt(m.jumpPx), m.jumpPx < 3);
  if (opt.env) {
    const avg = k => (m[k] ?? 0) / (m.envN || 1);
    env[name] = { burnMax: m.burnMax ?? 0, burnEnd: m.burnEnd ?? 0, resets: m.resets ?? 0, jerk: m.jerk ?? 0, inViewer: m.inViewer ?? 0, wet: avg("wet"), deflect: avg("deflect"), hemUp: avg("hemUp"), wind: avg("wind"), sleep: avg("envSleep"), pen: m.pen ?? 0 };
    console.log(`  info hem offset px ${fmt(avg("deflect"))} (up ${fmt(avg("hemUp"))}), wind ${fmt(avg("wind"))} b/s, asleep ${(100 * avg("envSleep")).toFixed(0)}%, ` +
      `in blocks px: rows ${CLAMP_ROW}+ ${fmt(m.pen ?? 0)}, above ${fmt(m.penTop ?? 0)}`);
    console.log(`  info resets ${m.resets ?? 0}, hem jerk px ${fmt(m.jerk ?? 0)}, inside other player px ${fmt(m.inViewer ?? 0)}`);
    check("clamped rows in blocks", fmt(m.pen ?? 0), (m.pen ?? 0) < 0.05);
    if (opt.surface) check("water surface error blocks", fmt(m.surfErr ?? 99), (m.surfErr ?? 99) < 0.05);
  }
}
// Comparisons between environment cases.
if (envCases.every(([name]) => name in env)) {
console.log("environment");
check("outdoor wind > 0.3 b/s", fmt(env["outdoor stand"].wind), env["outdoor stand"].wind > 0.3);
check("outdoor stays awake", fmt(env["outdoor stand"].sleep), env["outdoor stand"].sleep < 0.1);
check("rain wind / calm", fmt(env["rain stand"].wind / env["outdoor stand"].wind), env["rain stand"].wind > 1.5 * env["outdoor stand"].wind);
check("wet cape hangs closer despite stronger rain wind", `${fmt(env["rain stand"].deflect)} < ${fmt(env["outdoor stand"].deflect)}`, env["rain stand"].deflect < env["outdoor stand"].deflect);
check("corridor wind / open", fmt(env["corridor stand"].wind / env["outdoor stand"].wind), env["corridor stand"].wind > 1.4 * env["outdoor stand"].wind);
check("wall upwind shelters", fmt(env["sheltered stand"].wind / env["outdoor stand"].wind), env["sheltered stand"].wind < 0.5 * env["outdoor stand"].wind);
check("roofed room is calm", fmt(env["roofed stand"].wind), env["roofed stand"].wind === 0 && env["roofed stand"].sleep > 0.5);
check("underwater: no wind", fmt(env["underwater stand"].wind), env["underwater stand"].wind === 0);
check("running in rainy water: no wind", fmt(env["run in water"].wind), env["run in water"].wind === 0);
check("running in water: cape submerged", fmt(env["run in water"].wet), env["run in water"].wet > 0.99);
check("fast fall: no resets", env["fast fall 144fps jitter"].resets, env["fast fall 144fps jitter"].resets === 0);
check("fast fall: smooth hem (jerk px)", fmt(env["fast fall 144fps jitter"].jerk), env["fast fall 144fps jitter"].jerk < 0.5);
// Uneven frame times alone give about 1.3 px (the build before the 60 Hz accumulator: 1.36);
// the first accumulator, with a fixed 1/60 s step, gave 3.9 px, the hopping seen in game.
check("fly up: smooth hem (jerk px)", fmt(env["fly up 59fps jitter"].jerk), env["fly up 59fps jitter"].jerk < 1.5);
check("fire: hem lifts and billows", `${fmt(env["fire indoors"].hemUp)} up, ${fmt(env["fire indoors"].deflect)} off`, env["fire indoors"].hemUp > 1 && env["fire indoors"].sleep < 0.05);
check("sprint on fire: hem higher than without", `${fmt(env["sprint on fire"].hemUp)} > ${fmt(env["sprint along wall"].hemUp)}`, env["sprint on fire"].hemUp > env["sprint along wall"].hemUp);
check("fire: uneven burnt hem", fmt(env["fire indoors"].burnMax), env["fire indoors"].burnMax >= 2 && env["fire indoors"].burnMax <= 3);
check("after the fire: cape settles", `${fmt(env["after the fire"].deflect)} px, asleep ${fmt(env["after the fire"].sleep)}`, env["after the fire"].deflect < 1 && env["after the fire"].sleep > 0.5);
check("after the fire: grows back", fmt(env["after the fire"].burnEnd), env["after the fire"].burnEnd === 0);
check("cape kept out of the other player", fmt(env["other player behind"].inViewer), env["other player behind"].inViewer < 0.05);
check("underwater hem floats up", `${fmt(env["underwater stand"].hemUp)} > ${fmt(env["roofed stand"].hemUp)}`, env["underwater stand"].hemUp > env["roofed stand"].hemUp + 1);
}
process.exit(ok ? 0 : 1);
