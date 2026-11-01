import assert from 'node:assert/strict';
import { upperBone } from './test-player.mjs';
import { playerFixture } from './test-world.mjs';
import { program, channels, sections, pid, ROWS } from './cloth.mjs';
import { set, compileJs, jsReturn, MATH, strict } from './molang.mjs';
const run=compileJs(program()), output=channels().map(c=>compileJs(c.nodes,jsReturn(c.value)));
const axes=['x','y','z'];
const euler=({x,y,z})=>{const d=Math.PI/180,a=-x*d,b=y*d,c=-z*d,ca=Math.cos(a),sa=Math.sin(a),cb=Math.cos(b),sb=Math.sin(b),cc=Math.cos(c),sc=Math.sin(c);return [[cc*cb,cc*sb*sa-sc*ca,cc*sb*ca+sc*sa],[sc*cb,sc*sb*sa+cc*ca,sc*sb*ca-cc*sa],[-sb,cb*sa,cb*ca]];};
const transform=(m,v)=>m.map(row=>row.reduce((s,x,i)=>s+x*v[i],0));
const limbs=[['rightarm',[-1,-4,0],[2,6,2]],['leftarm',[1,-4,0],[2,6,2]]];
// Real cuboid faces, independently transformed into simulation space. A point
// inside each animated face must leave it, while a distant point stays untouched.
for(const [name,centre,half]of limbs)for(const yaw of [0,67,180])for(const rotation of [{x:0,y:0,z:0},{x:65,y:25,z:-40}]){
 const bones=Object.fromEntries(limbs.map(([n])=>[n,{t:{x:100,y:100,z:100},r:{x:0,y:0,z:0}}]));
 bones[name]={...upperBone(name),r:rotation};
 const R=euler(rotation),rad=yaw*Math.PI/180,Y=[[Math.cos(rad),0,Math.sin(rad)],[0,1,0],[Math.sin(rad),0,-Math.cos(rad)]];
 const G=Y.map(row=>[0,1,2].map(j=>row.reduce((s,x,k)=>s+x*R[k][j],0)));
 const C=transform(Y,transform(R,centre).map((x,k)=>x+bones[name].t[axes[k]]));
 const contact=compileJs([set('t.cy',Math.cos(rad)),set('t.sy',Math.sin(rad)),set('t.g02',Math.sin(rad)),set('t.g12',0),set('t.g22',-Math.cos(rad)),axes.map(a=>set('t.o'+a,0)),sections().upper,
   axes.map(a=>[set('t.p'+a,'v.input_'+a),set('t.q'+a,'v.input_'+a)]),set('t.ci',0),set('t.qloaded',1),set('t.ch',0),set('t.qh',0),sections().upperContacts,
   axes.map(a=>set('v.result_'+a,'t.p'+a))]);
 for(const face of [0,1,2])for(const sign of [-1,1]){
  const local=[.2,.3,.1];local[face]=sign*(half[face]-.1);
  const point=transform(G,local).map((x,k)=>x+C[k]);
  const v=strict(Object.fromEntries(axes.map((a,k)=>['input_'+a,point[k]])));
  contact(v,{bone_orientation_trs:n=>bones[n]},MATH);
  const delta=axes.map((a,k)=>v['result_'+a]-C[k]);
  const actual=[0,1,2].map(j=>G.reduce((sum,row,k)=>sum+row[j]*delta[k],0));
  assert.ok(actual.some((x,k)=>Math.abs(x)>=half[k]+.3999),name+' rotated collision exits box');
 }
 const far=strict({input_x:1000,input_y:1000,input_z:1000});contact(far,{bone_orientation_trs:n=>bones[n]},MATH);
 assert.deepEqual(axes.map(a=>far['result_'+a]),[1000,1000,1000]);
}
console.log('arms/hands: all six faces, rotated bones and yaw passed');
for(const [name]of limbs){
 const f=playerFixture();f.advance(4);assert.ok(f.v.cwqt>=30,'initially asleep');
 const old=f.v.cwst;f.s.bones[name]=structuredClone(upperBone(name));f.s.bones[name].r.x=55;
 f.tick();assert.ok(f.v.cwst>old&&f.v.cwqt<30,name+' wakes resting cloth');
}
console.log('moving either arm wakes sleeping cloth');
for(const fps of [30,60,144]){
 const f=playerFixture(fps);f.advance(1);
 const lifetime=f.s.time;f.s.animTime=0;f.s.missingBones=true;
 for(let i=0;i<Math.ceil(.09*fps);i++){
  f.s.animTime=i/fps;f.tick();
  assert.equal(f.v.cwon,0,'reload with continuous actor lifetime uses safe rest pose');
  for(const fn of output)assert.ok(Number.isFinite(fn(f.v,f.q,MATH)));
  run(f.v,f.q,MATH); // a duplicate world pass must not shorten the wait
 }
 f.s.missingBones=false;f.s.animTime=.5;f.advance(.25);
 assert.ok(f.v.cwon&&f.v.cwok&&f.s.time>lifetime,'new geometry resumes without resetting actor time');
}
console.log('cosmetic reload with continuous life_time: 30/60/144 fps passed');
// Keep identical wind and motion, changing only moisture, to measure the physical effect.
const dry=playerFixture(),wet=playerFixture();
for(const f of [dry,wet]){f.s.roof=false;f.q.time_stamp=()=>5000+Math.floor(f.s.time*20);}
let dryLift=0,wetLift=0;
for(let i=0;i<300;i++){
 for(const[f,moist]of [[dry,0],[wet,1]]){f.v.cwwet=moist;f.tick();}
 if(i>=180){dryLift+=dry.v['cp'+pid(ROWS,2).toString(36)+'y'];wetLift+=wet.v['cp'+pid(ROWS,2).toString(36)+'y'];}
}
console.log({dryHemY:dryLift/120,wetHemY:wetLift/120});
assert.ok(wetLift<dryLift-12,'wet cape has visibly less wind lift');
console.log('wet cape wind response is reduced');

const sprint=[];
for(const moist of [0,1]){
 const f=playerFixture();f.s.roof=false;const start=f.s.time;
 f.q.position=k=>[.5,65.62,.5+(f.s.time-start)*5.6][k];let y=0,z=0;
 for(let i=0;i<360;i++){f.v.cwwet=moist;f.tick();if(i>239){y+=f.v['cp'+pid(ROWS,2).toString(36)+'y'];z+=f.v.cwkz-f.v['cp'+pid(ROWS,2).toString(36)+'z'];}}
 sprint.push({hemY:y/120,hemZ:z/120});
}
assert.ok(sprint[1].hemY<sprint[0].hemY-3,'wet running cloth hangs lower');
assert.ok(sprint[1].hemZ<sprint[0].hemZ*.8,'wet running cloth remains closer to wearer');
console.log({drySprint:sprint[0],wetSprint:sprint[1]});
