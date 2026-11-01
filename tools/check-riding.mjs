import { upperBone } from './test-player.mjs';
// Exercise passenger position timing independently of the animation clock.
// Optional CLOTH_BASELINE points at a pre-change generator for motion comparisons.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
process.env.WIND = '0';
const { program, channels, COLS, ROWS, pid } = await import('./cloth.mjs');
const { compileJs, jsReturn, MATH, strict } = await import('./molang.mjs');
const current = compileJs(program());
const baseline = process.env.CLOTH_BASELINE
  ? compileJs((await import(pathToFileURL(process.env.CLOTH_BASELINE))).program()) : null;
const output = channels().map(c => compileJs(c.nodes, jsReturn(c.value)));
const PX = 16 / .9375, AX = ['x', 'y', 'z'];
const stats = xs => ({ min: Math.min(...xs), max: Math.max(...xs), mean: xs.reduce((a,b) => a+b,0)/xs.length });
// Exported constants are rounded to five decimals, as in the game expressions.
const close = (a,b,label) => assert.ok(Math.abs(a-b)<1e-4,`${label}: ${a} != ${b}`);

function run({ fps=60, speed=5.6, period=.05, phase=0, ride=true, stop=false, switchRide=false,
  turn=false, fluid=false, bob=false, teleport=false, seconds=7, fn=current }={}) {
  const v=strict({}), samples=[], trace=[];
  let lastHem, lastStep=-1, maxJump=0;
  for(let f=0;f<fps*seconds;f++) {
    const time=f/fps, tick=Math.floor(time*20+.001), riding=switchRide?(time>=1&&time<5):ride;
    const sampled=period?Math.max(0,Math.floor((time+phase)/period+1e-6)*period-phase):time;
    const travel=speed*Math.max(0,Math.min(sampled,stop?4:Infinity)-1);
    const angle=turn?Math.max(0,Math.min(sampled-3,1))*90:0, rad=angle*Math.PI/180;
    const radius=speed/(Math.PI/2), corner=turn&&sampled>3;
    const pos=[.5-(corner?radius*(1-Math.cos(rad))+speed*Math.max(sampled-4,0):0),
      64+(bob?.15*Math.sin(sampled*4):0),.5+(corner?speed*2+radius*Math.sin(rad):travel)+(teleport&&time>=4?100:0)];
    const leg=(x,y) => ({t:{x,y:12,z:0},r:{x:riding?-81:0,y:riding?y:0,z:0}});
    const bones={body:{t:{x:0,y:24,z:0},r:{x:0,y:0,z:0}},rightleg:leg(-1.9,18),leftleg:leg(1.9,-18)};
    const q={anim_time:()=>Math.min(time,.5),life_time:()=>time,delta_time:()=>1/fps,frame_alpha:()=>time*20-tick,
      position:k=>pos[k]+(k===1?1.62:0),body_y_rotation:()=>angle,is_riding:()=>+riding,
      bone_orientation_trs:n=>bones[n]??upperBone(n),get_root_locator_offset:()=>0,has_armor_slot:()=>0,has_cape:()=>1,
      is_in_ui:()=>0,is_spectator:()=>0,is_item_name_any:()=>0,is_on_ground:()=>0,
      time_stamp:()=>tick,time_of_day:()=>.25,is_in_water:()=>+fluid,is_in_lava:()=>0,
      is_in_water_or_rain:()=>+fluid,entity_biome_has_any_tags:()=>0,is_on_fire:()=>0,
      is_local_player:()=>1,distance_from_camera:()=>50,cape_flap_amount:()=>0,
      block_has_any_tag:(x,y,z,...tags)=>+(fluid&&y<66?tags.includes('water'):y<64&&tags.includes('minecraft:is_pickaxe_item_destructible')),
      block_has_all_tags:()=>0};
    fn(v,q,MATH);
    if(!v.cwok)continue;
    // Cache positions must continue to describe real terrain after the sim base moves.
    for(const a of AX)close(v['cwo'+a]/PX+v['cwb'+a],v['cwe'+a],'terrain origin '+a);
    if(fluid)close(v.cwfh/PX+v.cwby,65.9,'fluid surface');
    if(!bob&&!fluid)close(v.cwfl/PX+v.cwby,64+.5/PX,'floor');
    const hem=AX.map(a=>v['cp'+pid(ROWS,COLS>>1).toString(36)+a]-v['cwk'+a]);
    const local=AX.map((a,k)=>v['cwg0'+k]*hem[0]+v['cwg1'+k]*hem[1]+v['cwg2'+k]*hem[2]+(k===1?24:0));
    assert.ok(local.every(Number.isFinite),'finite particles');
    if(v.cwst!==lastStep) {
      const jump=lastHem?Math.hypot(...local.map((x,k)=>x-lastHem[k])):0;
      if(time>2&&time<3.9) { samples.push({jump,y:local[1],z:local[2],velocity:Math.hypot(v.cwvx,v.cwvz)});maxJump=Math.max(maxJump,jump); }
      lastHem=local;lastStep=v.cwst;
    }
    trace.push(AX.map(a=>v['cp'+pid(ROWS,COLS>>1).toString(36)+a]));
    if(fn===current&&(f%31===0||time>seconds-1/fps-1e-6))for(const channel of output)assert.ok(Number.isFinite(channel(v,q,MATH)),'finite render channels');
    if(fn===current&&switchRide&&Math.abs(time-5)<1e-6)close(v.cwvz,0,'dismount resets inherited speed');
  }
  return {maxJump,z:stats(samples.map(s=>s.z)),y:stats(samples.map(s=>s.y)),velocity:stats(samples.map(s=>s.velocity)),
    endSpeed:Math.hypot(v.cwvx,v.cwvz),endHem:lastHem,trace};
}

const summary = r => ({jump:+r.maxJump.toFixed(3),hemZ:+r.z.mean.toFixed(3),measuredSpeed:+r.velocity.mean.toFixed(3)});
for(const fps of [30,60,144])for(const speed of [1,5.6])for(const [period,phase]of [[.05,0],[.05,.02],[.1,0],[0,0]]) {
  const opt={fps,speed,period,phase},r=run(opt);
  console.log(JSON.stringify({...opt,...summary(r)}));
  assert.ok(Math.abs(r.velocity.mean-speed)<speed*.08,'sustained rider speed');
  assert.ok(r.z.mean>3,'cape trails behind');
  assert.ok(r.maxJump<(fps===30?1.3:.8),'no repeated sampling kicks');
  if(baseline&&fps===60&&speed===5.6&&period&&phase) {
    const old=run({...opt,fn:baseline});console.log('before',summary(old),'after',summary(r));
    assert.ok(r.maxJump<old.maxJump*.5,'reduces timing-induced kicks');
  }
}
for(const extra of [{stop:true},{switchRide:true},{turn:true},{fluid:true,bob:true},{teleport:true}]) {
  const r=run(extra);console.log('transition',extra,summary(r),'end speed',r.endSpeed);
  if(extra.stop)assert.ok(r.endSpeed<.001,'stationary rider sheds stale speed');
}
if(baseline)for(const fps of [30,60,144]) {
  const opt={fps,ride:false,stop:true},a=run(opt),b=run({...opt,fn:baseline});
  assert.deepEqual(a.trace,b.trace,'non-riding trajectory unchanged');
  console.log('non-riding baseline identical',fps);
}
console.log('riding checks passed');
