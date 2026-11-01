// Match the actual A&S 1.13 entry points and run the optional profile offline.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cloth from './cloth.mjs?profile=actions_and_stuff_1_13';
import { compileJs, jsReturn, MATH, toMolang, compactNames } from './molang.mjs';
import { playerFixture } from './test-world.mjs';
import { exportPack } from './export-pack.mjs';

const sample = new URL('../_sample/[英文]Actions and Stuff 1.13/', import.meta.url);
const read = relative => JSON.parse(fs.readFileSync(new URL(relative,sample),'utf8'));
const player = read('entity/dtr.json')['minecraft:client_entity'].description;
const nativeAnimation = read('animations/f2da1072.json').animations;
const nativeRender = read('render_controllers/f2da1072.json').render_controllers['controller.render.player.cape'];
const nativeController = read('animation_controllers/616f2ff8.json').animation_controllers['controller.animation.oreville_ans.xunqct'];
assert.equal(player.animations.cape,cloth.profile.animation);
assert.ok(nativeAnimation[cloth.profile.animation].bones.cape);
for(const state of ['default','zqihwb'])assert.ok(nativeController.states[state].animations.includes('cape'));
assert.ok(player.scripts.animate.some(x=>typeof x==='object'&&x.cape==='v.is_paperdoll'));
assert.equal(player.materials.cape,'entity_alphatest');
assert.equal(player.geometry.cape,'geometry.cape');
for(const color of ['is_hurt_color','on_fire_color'])assert.deepEqual(cloth.renderController().render_controllers['controller.render.player.cape'][color],nativeRender[color]);
assert.ok(!nativeRender.overlay_color,'A&S has no existing cape overlay to replace');
console.log('A&S 1.13: cape alias, walking/riding/preview entries, materials and color effects match');

const bundle=exportPack(cloth), id=cloth.profile.animation;
assert.deepEqual(bundle.animation.animations['animation.player.cape'],bundle.animation.animations[id], 'native and A&S entries use the same adapted solver');
const manifest=JSON.parse(fs.readFileSync(new URL('../src/manifest.json',import.meta.url),'utf8'));
assert.equal(manifest.subpacks.at(-1).folder_name,'default');
assert.ok(manifest.subpacks.some(s=>s.folder_name===cloth.profile.folder));
const folder=new URL(`../src/subpacks/${cloth.profile.folder}/`,import.meta.url);
for(const[file,expected]of [['animations/cloth_cape.animation.json',bundle.animation],['models/entity/cloth_cape.geo.json',bundle.geometry],['render_controllers/cloth_cape.render_controllers.json',bundle.render]])
  assert.deepEqual(JSON.parse(fs.readFileSync(new URL(file,folder),'utf8')),expected);
const generatedBones=bundle.geometry['minecraft:geometry'][0].bones;
assert.equal(generatedBones.filter(b=>b.cubes?.length).length,25);
assert.equal(cloth.COLS*cloth.ROWS,25);
assert.equal((cloth.COLS+1)*(cloth.ROWS+1),36);
assert.ok(!bundle.animation.animations[id].anim_time_update.includes("bone_orientation_trs('head')"));
const raw=toMolang(cloth.program()), map=compactNames([raw,JSON.stringify(cloth.bones()),JSON.stringify(cloth.renderController())],cloth.profile);
for(const name of cloth.profile.externalNames)assert.ok(!map.map.has(name)||map.map.get(name)===name);
// Detect even a future short-name collision with an A&S script or animation.
const nativeNames=new Set();
function scan(dir){for(const file of fs.readdirSync(dir,{withFileTypes:true})){
  const full=path.join(dir,file.name);if(file.isDirectory()){scan(full);continue;}if(!file.name.endsWith('.json'))continue;
  const text=JSON.stringify(JSON.parse(fs.readFileSync(full,'utf8')));
  for(const match of text.matchAll(/\b(?:v|variable)\.(\w+)/gi))nativeNames.add('v.'+match[1].toLowerCase());
}}
for(const sub of ['entity','animations','animation_controllers','render_controllers'])scan(fileURLToPath(new URL(sub,sample)));
for(const[from,to]of map.map)if(from!==to&&to.startsWith('v.'))assert.ok(!nativeNames.has(to),'A&S variable collision '+to);
console.log(`subpack files match, 25 complete tiles / 36 particles, ${nativeNames.size} A&S variable names checked`);

const run=compileJs(cloth.program()), channels=cloth.channels().map(c=>compileJs(c.nodes,jsReturn(c.value)));
const render=cloth.renderController().render_controllers['controller.render.player.cape'];
const visibility=Object.values(render.part_visibility[0]).map(expr=>compileJs([],jsReturn(expr.replaceAll('query.','q.').replaceAll('variable.','v.'))));
const tint=compileJs([cloth.wetUpdate()],jsReturn(cloth.wetTint));
for(const fps of [30,60,144]){
  const f=playerFixture(fps);for(const k of Object.keys(f.v))delete f.v[k];
  f.v.is_first_person=f.v.is_paperdoll=f.v.map_face_icon=0;
  f.q.armor_texture_slot=()=>0;
  f.q.is_on_fire=()=>+(f.s.time<104);
  f.q.is_item_name_any=(slot,...items)=>+(slot==='slot.armor.chest'&&items.includes('')&&!f.s.armour);
  for(let frame=0;frame<fps*6;frame++){
    f.s.time=100+frame/fps;f.s.water=frame>=fps*2&&frame<fps*3;
    run(f.v,f.q,MATH);
    for(const ch of frame%2?channels:[...channels].reverse())assert.ok(Number.isFinite(ch(f.v,f.q,MATH)));
    const once={...f.v};
    run(f.v,f.q,MATH);
    for(const ch of channels)assert.ok(Number.isFinite(ch(f.v,f.q,MATH)));
    assert.deepEqual({...f.v},once,'duplicate same-frame calls never advance solver or wetness twice');
    assert.equal(visibility.filter(fn=>fn(f.v,f.q,MATH)).length,25,'fire/wetness never removes tiles');
    assert.equal(f.v.cwht,0,'A&S fire effect replaces cloth heat animation');
    const alpha=tint(f.v,f.q,MATH);assert.ok(alpha>=0&&alpha<=.45);
    if(frame===fps*3-1)assert.equal(alpha,.45,'wet tint retained');
  }
  // A&S's own chestplate visibility settings control physical clearance too.
  for(const hidden of [0,1]){f.s.armour=true;f.v.oreville_chestplate_armor_layer_hidden=hidden;f.s.time+=1/fps;run(f.v,f.q,MATH);assert.equal(f.v.cwaz,hidden?0:1.5);}
  // Its small-player mode scales world distances and resets the solver.
  f.v.tnlxsa=1;f.s.time+=1/fps;run(f.v,f.q,MATH);assert.equal(f.v.cwunits,16/.6);
  f.v.tnlxsa=0;f.s.time+=1/fps;run(f.v,f.q,MATH);assert.equal(f.v.cwunits,16/.9375);
  // UI entry never asks an actor-only query, even on the A&S alias.
  f.s.noEntity=true;f.s.ui=true;run(f.v,f.q,MATH);for(const ch of channels)assert.ok(Number.isFinite(ch(f.v,f.q,MATH)));
  console.log(`A&S profile: fire, wetness, armour, scale and actorless UI passed at ${fps} fps`);
}
