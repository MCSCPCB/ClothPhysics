// Reused from Simple Ragdoll: the validated expression parser / exporter.
import {parseExpression} from './parse.mjs';

const precedence={'??':1,'||':2,'&&':3,'==':4,'!=':4,'<':5,'>':5,'<=':5,'>=':5,'+':6,'-':6,'*':7,'/':7,'%':7};
const rank=n=>n.kind==='if'?0:n.kind==='binary'?precedence[n.op]:n.kind==='unary'?8:9;

export function printExpression(n,min=-1){
  const print=printExpression;
  let text;
  if(n.kind==='value')text=typeof n.value==='string'?"'"+n.value+"'":String(n.value);
  else if(n.kind==='read')text=n.path.join('.');
  else if(n.kind==='call')text=n.path.join('.')+'('+n.args.map(a=>print(a)).join(',')+')';
  else if(n.kind==='unary')text=n.op+print(n.value,8);
  // Keep right-hand grouping even for + and *: reassociation changes floating
  // point results. This only removes parentheses that the grammar can infer.
  else if(n.kind==='binary')text=print(n.left,rank(n))+n.op+print(n.right,rank(n)+1);
  else text=print(n.test,1)+'?'+print(n.yes)+':'+print(n.no);
  return rank(n)<min?'('+text+')':text;
}

export function expressionCompactor(){
  // Chunk sizing repeatedly emits the same expressions. Bound the cache and
  // keep it local to a compilation, rather than retaining imported packs.
  const cache=new Map();
  return source=>{
    if(typeof source!=='string')return String(Number(source));
    if(cache.has(source))return cache.get(source);
    const result=printExpression(parseExpression(source));
    if(cache.size>=16384)cache.clear();
    cache.set(source,result);return result;
  };
}
