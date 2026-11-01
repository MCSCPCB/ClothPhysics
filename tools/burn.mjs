// Burn only exposed tiles. The intact cloth keeps its original particle solver.
// A tile's m/h/i affine frame is adjusted BEFORE the existing SVD bone fit, so
// shortening and regrowth can keep its top edge fixed even on a bent cape.
import { set, when, flat, num } from './molang.mjs';
import { COLS, ROWS, tileId } from './grid.mjs';

const AX = ['x', 'y', 'z'];
export const BURN_ROWS = ROWS - 1;
export const RESTORE_TILE_TIME = 0.16;
export const BURN_END = 4.3; // 1.55 s embers, up to 2.4 s unfold, plus frame-time slack
export const burnVar = (r, c, field) => `v.cb${tileId(r, c)}_${field}`;
export const burning = `v.cwbt>0&&(v.cwbf||v.cwbr<${BURN_END})`;

// All timing is visible simulation time, not world time: UI passes cannot advance
// the animation, and returning from a hidden cape cannot jump across a phase.
export function burnClock() {
  return [
    set('t.bdt', 'math.clamp(q.delta_time,0,0.05)'),
    when('q.is_on_fire', [
      when('!v.cwbf', [set('v.cwbe', 'v.cwbe+1'),
        // Interrupted burning continues the same silhouette. Pick a new one once
        // fully restored, so repeated ignition cannot eventually burn every column flat.
        when(`v.cwbr>=${BURN_END}||v.cwbt==0`, [set('v.cwbs', 'math.mod(math.abs(q.life_time*137+q.position(0)*17+q.position(2)*31),997)'), set('v.cwfirst', ROWS - 1), set('v.cwrd', 1)]),
        set('v.cwbt', 0)]),
      set('v.cwbt', 'math.min(v.cwbt+t.bdt,30)'), set('v.cwbr', 0),
    ], set('v.cwbr', `math.min(v.cwbr+t.bdt,${BURN_END})`)),
    set('v.cwbf', 'q.is_on_fire'),
  ];
}

// Hand-designed bites, then mirrored. Every column remains attached to the
// shoulder. The three profiles remove successively deeper connected portions.
const light = [[1, 1, 2, 1, 1], [1, 2, 2, 1, 1], [1, 1, 1, 2, 1], [1, 2, 1, 2, 1]];
export const burnProfiles = [...light, ...light.map(p => [...p].reverse())].map(p => [
  p, p.map(d => d === 2 ? 3 : 2), p.map(d => d === 2 ? 4 : 3),
]);
export const burnDepths = burnProfiles.map(p => p[2]);
export const burnOrders = burnProfiles.map((stages, profile) => {
  const used = new Set(), out = [], columns = profile % 2 ? [3, 2, 4, 1, 0] : [1, 2, 0, 3, 4];
  stages.forEach((depths, stage) => {
    let count = 0;
    // Bottom-up rounds keep two vertically adjacent tiles far enough apart for
    // the lower ash to detach. Higher stages advance more slowly.
    for (let d = 1; d <= ROWS - 1; d++) for (const c of columns) {
      const r = ROWS - d, id = tileId(r, c);
      if (d <= depths[c] && !used.has(id)) {
        used.add(id);
        out.push({ r, c, stage, due: [0.35, 3.5, 13][stage] + count++ * [0.28, 0.42, 1.1][stage] });
      }
    }
  });
  return out;
});
const choose = (values, offset = 0) => {
  if (values.length === 1) return String(values[0]);
  const h = values.length >> 1;
  return `(t.order<${offset + h}?${choose(values.slice(0, h), offset)}:${choose(values.slice(h), offset + h)})`;
};
export const restoreDelay = (r, c) => `1.55+(${r}-v.cwfirst)*(v.cwrd-0.28)/math.max(${ROWS - 1}-v.cwfirst,1)+${num([3, 1, 0, 2, 4][c] * 0.03)}`;
const smooth = x => `(${x}*${x}*(3-2*${x}))`;

// Shorten/uncurl about the top edge. h is unchanged, so BOTH top corners stay
// attached, not just the centre. Rodrigues rotates i around the horizontal edge.
function edgeShape(H) {
  return [
    set('t.hl', 'math.max(math.sqrt(t.hx*t.hx+t.hy*t.hy+t.hz*t.hz),0.0001)'),
    AX.map(a => set('t.a' + a, `t.h${a}/t.hl`)),
    set('t.ip', 't.ax*t.ix+t.ay*t.iy+t.az*t.iz'),
    set('t.cs', 'math.cos(t.curl)'), set('t.sn', 'math.sin(t.curl)'),
    AX.map((a, k) => {
      const b = AX[(k + 1) % 3], c = AX[(k + 2) % 3];
      return set('t.j' + a, `(t.i${a}*t.cs+t.a${a}*t.ip*(1-t.cs)-(t.a${b}*t.i${c}-t.a${c}*t.i${b})*t.sn)*t.size`);
    }),
    AX.map(a => [set('t.m' + a, `t.m${a}+(t.i${a}-t.j${a})*${num(H / 2)}`), set('t.i' + a, 't.j' + a)]),
  ];
}

function capture(f) {
  return [
    // Snapshot in the simulation's rebased WORLD frame. Vectors include the
    // player's current body pose and yaw, and are no longer attached to it.
    AX.map((a, k) => [set(f('b' + a), 'v.cwb' + a), set(f('d' + a), `v.cwg${k}2`),
      set(f('m' + a), `v.cwk${a}+v.cwg${k}0*t.mx+v.cwg${k}1*(t.my-24)+v.cwg${k}2*t.mz`),
      ...['h', 'i'].map(n => set(f(n + a), `v.cwg${k}0*t.${n}x+v.cwg${k}1*t.${n}y+v.cwg${k}2*t.${n}z`))]),
    set(f('s'), 2), set(f('p'), 0),
  ];
}

function ash(f, zScale) {
  return [
    set('t.u', `math.clamp(${f('p')}/0.4,0,1)`),
    set('t.fade', '1-t.u*t.u'), set(zScale, 't.fade'),
    set('t.cs', `math.cos(t.u*${f('spin')})`), set('t.sn', `math.sin(t.u*${f('spin')})`),
    set('t.hl', `math.max(math.sqrt(${AX.map(a => `${f('h' + a)}*${f('h' + a)}`).join('+')}),0.0001)`),
    AX.map(a => set('t.a' + a, `${f('h' + a)}/t.hl`)),
    set('t.ip', AX.map(a => `t.a${a}*${f('i' + a)}`).join('+')),
    AX.map((a, k) => {
      const b = AX[(k + 1) % 3], c = AX[(k + 2) % 3];
      return [
        set('t.j' + a, `(${f('i' + a)}*t.cs+t.a${a}*t.ip*(1-t.cs)-(t.a${b}*${f('i' + c)}-t.a${c}*${f('i' + b)})*t.sn)*t.fade`),
        set('t.o' + a, `${f('m' + a)}+(${f('b' + a)}-v.cwb${a})*17.06667+${f('d' + a)}*3.5*t.u${a === 'y' ? '+3.5*t.u' : ''}-v.cwk${a}`),
      ];
    }),
    AX.map((a, k) => [
      set('t.m' + a, `v.cwg0${k}*t.ox+v.cwg1${k}*t.oy+v.cwg2${k}*t.oz${a === 'y' ? '+24' : ''}`),
      set('t.h' + a, `(v.cwg0${k}*${f('hx')}+v.cwg1${k}*${f('hy')}+v.cwg2${k}*${f('hz')})*t.fade`),
      set('t.i' + a, `v.cwg0${k}*t.jx+v.cwg1${k}*t.jy+v.cwg2${k}*t.jz`),
    ]),
  ];
}

export function burnCell(r, c, H, zScale) {
  const f = field => burnVar(r, c, field);
  const due = burnOrders.map(order => order.find(tile => tile.r === r && tile.c === c)?.due ?? 99);
  return flat(
    when(`(${f('s')}??-1)<0`, [set(f('s'), 0), set(f('p'), 0)]),
    when(`(${f('epoch')}??-1)!=v.cwbe`, [
      set(f('epoch'), 'v.cwbe'), set('t.order', 'math.mod(math.floor(v.cwbs),8)'),
      set(f('due'), choose(due)),
    ]),
    set(f('p'), `${f('p')}+math.clamp(q.delta_time,0,0.05)`),
    when(`${f('s')}==0&&v.cwbf&&v.cwbt>=${f('due')}`, [set(f('s'), 1), set(f('p'), 0),
      set(f('spin'), `80+20*math.sin(v.cwbs+${r * 31 + c * 57})`),
      set('v.cwfirst', `math.min(v.cwfirst,${r})`),
      set('v.cwrd', `math.max(v.cwrd,${r === 1 ? 2.4 : 1})`)]),
    // A re-ignition does not restart an ash or pop a half-grown tile back to full
    // size: an in-flight ash finishes and a growing tile finishes its short unfold.
    when(`${f('s')}==2&&(${f('p')}>=0.4||math.abs(${f('bx')}-v.cwbx)+math.abs(${f('by')}-v.cwby)+math.abs(${f('bz')}-v.cwbz)>4)`, set(f('s'), 3)),
    when(`${f('s')}==3&&!v.cwbf&&v.cwbr>=${restoreDelay(r, c)}`, [set(f('s'), 4), set(f('p'), 0)]),
    when(`${f('s')}==4&&${f('p')}>=${num(RESTORE_TILE_TIME)}`, [set(f('s'), 0), set(f('p'), 0)]),
    set('t.size', 1), set('t.curl', 0),
    when(`${f('s')}==1`, [set('t.u', `math.clamp(${f('p')}/0.15,0,1)`), set('t.e', smooth('t.u')),
      set('t.size', '1-0.35*t.e'), set('t.curl', '18*t.e')]),
    when(`${f('s')}==4`, [
      set('t.u', `${f('p')}/${num(RESTORE_TILE_TIME)}`),
      set('t.e', 'math.clamp(t.u<0.55?t.u/0.55:t.u<0.8?(t.u-0.55)/0.25:(t.u-0.8)/0.2,0,1)'),
      set('t.e', smooth('t.e')),
      set('t.size', 't.u<0.55?1.15*t.e:t.u<0.8?1.15-0.2*t.e:0.95+0.05*t.e'),
      set('t.curl', '12*(1-math.clamp(t.u/0.55,0,1))'),
    ]),
    when(`${f('s')}==1||${f('s')}==4`, edgeShape(H)),
    when(`${f('s')}==1&&${f('p')}>=0.15`, capture(f)),
    when(`${f('s')}==2`, ash(f, zScale)),
    set(f('show'), `${f('s')}!=3&&(${f('s')}!=4||t.size>0.001)`),
    set('t.oldattach', '('+f('attach')+'??1)'),
    set(f('attach'), `${f('s')}==0||${f('s')}==1?1:${f('s')}==4?math.clamp(t.size,0,1):0`),
    when('t.oldattach!='+f('attach'),set('v.cwdirty',1)),
    // Fully hidden tiles keep a non-degenerate frame for the SVD. Visibility, not
    // zero-length axes, removes them; it is independent of animation channel order.
  );
}
