// Reused from Simple Ragdoll: the validated expression parser / exporter.
const fail = (_, args) => { throw new Error('Invalid Molang expression: ' + args.join(', ')); };

const forbidden = new Set(['constructor', 'prototype', '__proto__']);
const aliases = { variable: 'v', temp: 't', query: 'q', context: 'c' };
const precedence = { '??': 1, '||': 2, '&&': 3, '==': 4, '!=': 4, '<': 5, '>': 5, '<=': 5, '>=': 5, '+': 6, '-': 6, '*': 7, '/': 7, '%': 7 };

export function parseExpression(source) {
  if (typeof source === 'number' || typeof source === 'boolean') {
    if (!Number.isFinite(Number(source))) fail('expression', [String(source)]);
    return {kind: 'value', value: Number(source)};
  }
  source = String(source);
  const tokens = []; let offset = 0, index = 0;
  const pattern = /\s*(?:(\d*\.\d+|\d+\.?\d*)([eE][+-]?\d+)?|([a-zA-Z_]\w*)|'([^'\r\n]*)'|(\?\?|\|\||&&|==|!=|<=|>=|[+\-*/%<>()!?:.,]))/y;
  while (offset < source.length) {
    pattern.lastIndex = offset;
    const token = pattern.exec(source);
    if (!token) { if (!source.slice(offset).trim()) break; fail('expression', [source.slice(offset, offset+80)]); }
    offset = pattern.lastIndex;
    tokens.push(token[1] !== undefined ? { type: 'value', value: Number(token[1]+(token[2]??'')) } : token[3] ? {type:'name',value:token[3]} : token[4] !== undefined ? {type:'value',value:token[4]} : {type:'op',value:token[5]});
  }
  const invalid = () => fail('expression', [source.slice(0,80)]);
  const peek = value => tokens[index]?.value === value;
  const take = value => { if (!peek(value)) invalid(); index++; };
  const primary = () => {
    const token = tokens[index++];
    if (!token) invalid();
    if (token.type === 'value') {
      if (typeof token.value === 'number' && !Number.isFinite(token.value)) invalid();
      return {kind:'value',value:token.value};
    }
    if (token.type === 'op' && ['-', '+', '!'].includes(token.value)) return {kind:'unary',op:token.value,value:primary()};
    if (token.value === '(') { const result = parse(0); take(')'); return result; }
    if (token.type !== 'name') invalid();
    if (token.value === 'true' || token.value === 'false') return {kind:'value',value:Number(token.value === 'true')};
    const path = [aliases[token.value] ?? token.value];
    while (peek('.')) { index++; const part=tokens[index++]; if (part?.type!=='name'||forbidden.has(part.value)) invalid(); path.push(part.value); }
    if (!['v','t','q','math','c'].includes(path[0]) || path.length < 2) invalid();
    if (!peek('(')) return {kind:'read',path};
    if (!['math','q'].includes(path[0]) || path.length !== 2) invalid();
    index++; const args=[];
    if (!peek(')')) { do { args.push(parse(0)); if (!peek(',')) break; index++; } while (true); }
    take(')');
    return {kind:'call',path,args};
  };
  const parse = min => {
    let left=primary();
    while (index<tokens.length) {
      const op=tokens[index].value, p=precedence[op];
      if (p===undefined||p<min) break;
      index++; left={kind:'binary',op,left,right:parse(p+1)};
    }
    if (min===0 && peek('?')) { index++; const test=left,yes=parse(0); take(':'); left={kind:'if',test,yes,no:parse(0)}; }
    return left;
  };
  const result=parse(0); if (index!==tokens.length) invalid();
  return result;
}

