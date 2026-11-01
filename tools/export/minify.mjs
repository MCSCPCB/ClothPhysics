// Reused from Simple Ragdoll: the validated expression parser / exporter.
const publicNames=new Map([
  ['v.active','v.ragdoll_active'],['v.variant','v.ragdoll_variant'],
]);
const short=index=>{
  const first='abcdefghijklmnopqrstuvwxyz',rest=first+'0123456789';
  let name=first[index%26];index=Math.floor(index/26);
  while(index){index--;name+=rest[index%36];index=Math.floor(index/36);}
  return name;
};
const ranked=counts=>[...counts].sort((a,b)=>b[1]-a[1]).map(([name])=>name);
const occurrences=(text,scope)=>{
  const counts=new Map(),pattern=new RegExp("'[^']*'|(?<![\\w.])"+scope+'\\.\\w+','g');
  for(const [name] of text.matchAll(pattern))if(!name.startsWith("'"))counts.set(name,(counts.get(name)??0)+1);
  return ranked(counts);
};

export function minifier({frequencyText='',reservedNames=[],externalNames=[]}={}){
  const roots=new Map(),reserved=new Set([...reservedNames,...externalNames]),external=new Set(externalNames);
  let count=0;
  const variable=name=>{
    if(roots.has(name))return roots.get(name);
    let output=external.has(name)||name.startsWith('v.ragdoll_')?name:publicNames.get(name);
    if(!output)do{output='v.'+short(count++);}while(reserved.has(output));
    roots.set(name,output);return output;
  };
  for(const name of occurrences(frequencyText,'v'))variable(name);
  const run=text=>{
    const temps=new Map(occurrences(text,'t').map((name,i)=>[name,'t.'+short(i)]));
    let result=text.replace(/'[^']*'|(?<![\w.])[vt]\.\w+/g,name=>name.startsWith("'")?name:name.startsWith('v.')?variable(name):temps.get(name));
    result=result.replace(/'[^']*'|(?<![\w.])(?:\d+\.\d*|\.\d+|\d+)(?:e[+-]?\d+)?/gi,token=>{
      if(token.startsWith("'"))return token;
      const value=Number(token),options=[token,String(value).replace(/^0\./,'.'),value.toExponential().replace('e+','e')];
      return options.filter(s=>Number(s)===value).sort((a,b)=>a.length-b.length)[0];
    });
    return result.replace(/'[^']*'|(?<![\w.])\(((?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\)/gi,(token,number)=>number??token);
  };
  run.roots=roots;
  return run;
}
