// Execute the final compacted Molang, not just the generator's statement tree.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const cloth = await import(process.env.CLOTH_PROFILE ? `./cloth.mjs?profile=${process.env.CLOTH_PROFILE}` : './cloth.mjs');
const { program, channels, bones, renderController, wetUpdate, wetTint, profile } = cloth;
import { compileJs, jsReturn, MATH, strict, toMolang, compactNames, set, when, loop, checkMolang } from './molang.mjs';
import { playerFixture } from './test-world.mjs';
import { parseExpression } from './export/parse.mjs';
import { expressionCompactor } from './export/syntax.mjs';
import reserved from './export/reserved.mjs';
function readScript(text) {
 let at=0;
 const until=stop=>{const start=at;let depth=0,quote=false;for(;at<text.length;at++){const c=text[at];if(c==="'")quote=!quote;if(quote)continue;if(!depth&&stop(c,text[at+1]))return text.slice(start,at);if(c==='(')depth++;if(c===')')depth--;}throw Error('Unterminated script at '+start)};
 const expect=s=>{assert.equal(text.slice(at,at+s.length),s);at+=s.length;};
 const sequence=()=>{const nodes=[];while(at<text.length&&text[at]!=='}'){
  if(text.startsWith('loop(',at)){at+=5;const count=until(c=>c===',');expect(',{');const body=sequence();expect('});');nodes.push(loop(count,body));continue;}
  if(text.startsWith('return ',at)){at+=7;const value=until(c=>c===';');expect(';');nodes.push(set('v.export_result',value));continue;}
  const expr=until((c,n)=>c===';'||c==='?'&&n==='{');
  if(text[at]==='?'){expect('?{');const yes=sequence();expect('}');let no=[];if(text.startsWith(':{',at)){at+=2;no=sequence();expect('}');}expect(';');nodes.push(when(expr,yes,no));}
  else {expect(';');const m=/^([vt]\.\w+)=(?!=)([\s\S]+)$/.exec(expr);assert.ok(m,expr.slice(0,80));nodes.push(set(m[1],m[2]));}
 }return nodes;};
 const nodes=sequence();assert.equal(at,text.length);return nodes;
}
const raw=toMolang(program())+'return math.min(q.anim_time+q.delta_time,.5);',rawBones=bones(),render=renderController();
const packed=compactNames([raw,JSON.stringify(rawBones),JSON.stringify(render)],profile);
// Molang allows a--b as subtraction of a negative value. JavaScript reads -- as
// a decrement token, so translate the parsed tree with explicit parentheses.
const jsSafe=n=>n.kind==='value'?typeof n.value==='string'?"'"+n.value+"'":String(n.value):n.kind==='read'?n.path.join('.'):
 n.kind==='call'?n.path.join('.')+'('+n.args.map(jsSafe).join(',')+')':n.kind==='unary'?'('+n.op+jsSafe(n.value)+')':
 n.kind==='binary'?'('+jsSafe(n.left)+n.op+jsSafe(n.right)+')':'('+jsSafe(n.test)+'?'+jsSafe(n.yes)+':'+jsSafe(n.no)+')';
const normalize=nodes=>nodes.map(n=>n.kind==='set'?{...n,expr:jsSafe(parseExpression(n.expr))}:n.kind==='if'?{...n,cond:jsSafe(parseExpression(n.cond)),yes:normalize(n.yes),no:normalize(n.no)}:{...n,count:jsSafe(parseExpression(n.count)),body:normalize(n.body)});
const buildExpr=s=>{const source=packed.expression(s);checkMolang(source,'export');assert.ok(source.length<=61500);return compileJs(normalize(readScript(source)));};
const update=compileJs(program()),compactUpdate=buildExpr(raw);
const chans=channels().map(c=>({...c,run:compileJs(c.nodes,jsReturn(c.value)),exported:buildExpr(rawBones[c.bone][c.channel][c.axis])}));
const tint=compileJs([wetUpdate()],jsReturn(wetTint)),compactTint=buildExpr(render.render_controllers['controller.render.player.cape'].overlay_color.a);
const compactor=expressionCompactor();let expressions=0;
function validate(nodes){for(const n of nodes){for(const expr of n.kind==='set'?[n.expr]:n.kind==='if'?[n.cond]:[n.count]){assert.deepEqual(parseExpression(expr),parseExpression(compactor(expr)));expressions++;}if(n.kind==='if'){validate(n.yes);validate(n.no);}else if(n.kind==='loop')validate(n.body);}}
validate(program());chans.forEach(c=>validate(c.nodes));
assert.equal(new Set(packed.map.values()).size,packed.map.size);
for(const [a,b]of packed.map)if(a!==b&&b.startsWith('v.'))assert.ok(!reserved.includes(b));
const prefix = profile.folder === 'default' ? '' : `subpacks/${profile.folder}/`;
const generated=JSON.parse(fs.readFileSync(new URL(`../src/${prefix}animations/cloth_cape.animation.json`,import.meta.url)));
assert.equal(generated.animations[profile.animation].anim_time_update,packed.expression(raw),'built main matches tested export');
for(const id of profile.additionalAnimations ?? [])assert.deepEqual(generated.animations[id],generated.animations[profile.animation],'alias '+id);
for(const ch of chans)assert.equal(generated.animations[profile.animation].bones[ch.bone][ch.channel][ch.axis],packed.expression(rawBones[ch.bone][ch.channel][ch.axis]));
const generatedRender=JSON.parse(fs.readFileSync(new URL(`../src/${prefix}render_controllers/cloth_cape.render_controllers.json`,import.meta.url)));
const encodeValues=x=>Array.isArray(x)?x.map(encodeValues):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).map(([k,v])=>[k,encodeValues(v)])):typeof x==='string'?packed.expression(x):x;
assert.deepEqual(generatedRender,encodeValues(render),'built renderer uses the same variable map');
for(const name of profile.externalNames)assert.ok(!packed.map.has(name)||packed.map.get(name)===name,'external name '+name);
for(const fps of [30,60,144]){
 const f=playerFixture(fps),v=strict({}),short=strict({});f.q.is_on_fire=()=>+(f.s.time>102&&f.s.time<104);f.q.body_y_rotation=()=>f.s.time*17;
 for(let frame=0;frame<fps*7;frame++){
  f.s.time+=f.s.dt;f.s.rain=frame>fps&&frame<fps*2;f.s.water=frame>=fps*4&&frame<fps*5;f.s.roof=false;
  v.is_first_person=short.is_first_person=+(frame<fps/2);
  // Render can precede animation. Its wetness timestamp must survive initialization.
  const color=tint(v,f.q,MATH);compactTint(short,f.q,MATH);assert.equal(short.export_result,color);
  update(v,f.q,MATH);compactUpdate(short,f.q,MATH);
  const order=frame%2?[...chans].reverse():chans;
  for(const ch of order){const value=ch.run(v,f.q,MATH);ch.exported(short,f.q,MATH);assert.equal(short.export_result,value,`${fps}fps ${frame} ${ch.bone}.${ch.channel}`);}
  for(const[k,x]of Object.entries(v))assert.deepEqual(short[(packed.map.get('v.'+k)||'v.'+k).slice(2)],x,'exported state '+k);
 }
 console.log('actual compacted export matches source, shuffled channels and render-first: '+fps+' fps');
}
console.log({profile:profile.animation,validatedExpressions:expressions,mainChars:packed.expression(raw).length});
