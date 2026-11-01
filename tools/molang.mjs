// Minimal statement tree for generated Molang. The same tree prints as Molang
// for the pack and as JavaScript for the Node check, so both run identical logic.

export const set = (name, expr) => ({ kind: "set", name, expr: String(expr) });
export const when = (cond, yes, no = []) => ({ kind: "if", cond: String(cond), yes: [yes].flat(Infinity), no: [no].flat(Infinity) });
export const loop = (count, body) => ({ kind: "loop", count: String(count), body: [body].flat(Infinity) });
export const flat = (...nodes) => nodes.flat(Infinity).filter(Boolean);

// Short fixed-point numbers; Molang has no exponent guarantee, so never emit "e".
export function num(n) {
  if (!Number.isFinite(n)) throw new Error("non-finite constant " + n);
  let s = (Math.abs(n) < 1e-9 ? 0 : n).toFixed(5).replace(/0+$/, "").replace(/\.$/, "");
  if (s === "-0") s = "0";
  s = s.replace(/^(-?)0\./, "$1.");
  return n < 0 ? `(${s})` : s;
}

export function toMolang(nodes) {
  const out = [];
  for (const n of flat(nodes)) {
    if (n.kind === "set") out.push(`${n.name}=${n.expr};`);
    else if (n.kind === "if") out.push(`${n.cond.includes("?") ? "("+n.cond+")" : n.cond}?{${toMolang(n.yes)}}${n.no.length ? `:{${toMolang(n.no)}}` : ""};`);
    else if (n.kind === "loop") out.push(`loop(${n.count},{${toMolang(n.body)}});`);
  }
  return out.join("").replace(/(?<![a-z0-9_])0\.(\d)/g,".$1");
}

// The readable generator uses descriptive persistent state names. Allocate short,
// pack-local names at export only; every animation and visibility expression shares
// one map. Vanilla player variables and query/struct member names stay untouched.
export function compactNames(texts) {
  const counts = new Map();
  const pattern = /(?<![a-z0-9_.])(?:v\.c[a-z0-9_]+|t\.[a-z][a-z0-9_]*)\b/g;
  // The first expression is the shared physics step and has the tightest budget.
  for (const [index, text] of texts.entries()) for (const [name] of text.matchAll(pattern)) counts.set(name, (counts.get(name) ?? 0) + (index === 0 ? 200 : 1));
  const names = [...counts.keys()].sort((a,b) => counts.get(b)-counts.get(a) || a.localeCompare(b));
  let persistent = 0, temporary = 0;
  const map = new Map(names.map(name => {
    const i = temporary;
    return [name, name.startsWith('v.') ? `v.c${(persistent++).toString(36)}` :
      (temporary++, `t.${String.fromCharCode(97+i%26)}${i<26?'':Math.floor(i/26).toString(36)}`)];
  }));
  const encode = text => String(text).replace(pattern, name => map.get(name) ?? name);
  return { map, encode };
}

// Molang expression -> JS expression. Only the subset the generator emits.
// Bare queries (q.life_time) become calls; queries with arguments stay as written.
// "v.x??d" reads through __opt so the strict proxy below allows it, as Bedrock does.
const jsExpr = e => e.replace(/\bmath\./g, "M.").replace(/\bq\.([a-z_][a-z0-9_]*)\b(?!\()/g, "q.$1()")
  .replace(/\b([vt])\.([a-z_][a-z0-9_]*)\?\?/g, '$1.__opt("$2")??');

// Like Bedrock: reading a variable that was never set is an error, except through ??.
export const strict = obj => new Proxy(obj, { get(o, k) {
  if (k === "__opt") return n => o[n];
  if (typeof k !== "string" || k in o) return o[k];
  throw new Error("unknown variable " + k);
} });

export function toJs(nodes) {
  const out = [];
  for (const n of flat(nodes)) {
    if (n.kind === "set") out.push(`${n.name}=${jsExpr(n.expr)};`);
    else if (n.kind === "if") out.push(`if(${jsExpr(n.cond)}){${toJs(n.yes)}}${n.no.length ? `else{${toJs(n.no)}}` : ""}`);
    else if (n.kind === "loop") out.push(`for(let i=0,n=Math.min(1024,Math.max(0,${jsExpr(n.count)}));i<n;i++){${toJs(n.body)}}`);
  }
  return out.join("");
}

export function compileJs(nodes, tail = "") {
  const fn = new Function("v", "q", "M", "S", `const t=S({});${toJs(nodes)}${tail}`);
  return (v, q, M) => fn(v, q, M, strict);
}
export const jsReturn = expr => `return (${jsExpr(String(expr))});`;

// Degree-based math matching Molang.
const D = Math.PI / 180;
export const MATH = {
  sin: x => Math.sin(x * D), cos: x => Math.cos(x * D), asin: x => Math.asin(x) / D, acos: x => Math.acos(x) / D,
  atan2: (y, x) => Math.atan2(y, x) / D, sqrt: Math.sqrt, abs: Math.abs, min: (a, b) => Math.min(a, b), max: (a, b) => Math.max(a, b),
  floor: Math.floor, ceil: Math.ceil, round: Math.round, exp: Math.exp, pow: Math.pow,
  clamp: (x, a, b) => Math.min(b, Math.max(a, x)), lerp: (a, b, t) => a + (b - a) * t, mod: (a, b) => a % b,
};

// Bedrock grammar restrictions that JavaScript execution alone cannot validate.
const ARITY = { abs: 1, acos: 1, asin: 1, atan: 1, atan2: 2, ceil: 1, clamp: 3, cos: 1, exp: 1, floor: 1,
  lerp: 3, ln: 1, max: 2, min: 2, mod: 2, pow: 2, round: 1, sin: 1, sqrt: 1, trunc: 1 };
export function checkMolang(text, where) {
  // Ignore quoted query arguments when inspecting operators. Besides rejecting
  // constants such as 1??1, reject compound left operands such as v.x+v.y??0.
  const tokens = text.replace(/'(?:\\.|[^'\\])*'/g, "''")
    .match(/[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*|(?:\d*\.\d+|\d+)|\?\?|&&|\|\||==|!=|<=|>=|[^\s]/gi) ?? [];
  const startsOperand = new Set(['(', ',', '=', ';', '{', '}', '?', ':', '??', 'return']);
  for (let i = 0; i < tokens.length; i++) if (tokens[i] === '??') {
    const left = tokens[i - 1] ?? '', before = tokens[i - 2];
    if (!/^(?:v|variable|t|temp|c|context)\.[a-z_][a-z0-9_]*$/i.test(left) ||
        (before !== undefined && !startsOperand.has(before))) {
      throw new Error(`${where}: ?? requires a direct variable on its left: ${tokens.slice(Math.max(0, i - 3), i + 2).join('')}`);
    }
  }
  // JS silently accepts extra arguments, while Molang rejects the expression.
  const re = /math\.([a-z_]+)\(/g;
  for (let m; (m = re.exec(text));) {
    if (!(m[1] in ARITY)) throw new Error(`${where}: unknown function math.${m[1]}`);
    let depth = 0, args = 1, i = m.index + m[0].length;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (ch === "(") depth++; else if (ch === ")") { if (depth-- === 0) break; } else if (ch === "," && depth === 0) args++;
    }
    if (args !== ARITY[m[1]]) throw new Error(`${where}: math.${m[1]} takes ${ARITY[m[1]]} arguments, got ${args}: ${text.slice(m.index, i + 1).slice(0, 100)}`);
  }
  if (/\d[eE][+-]?\d/.test(text.replace(/[a-z_]+\.[a-z0-9_]+/g, ""))) throw new Error(`${where}: exponent number literal`);
  return text;
}
