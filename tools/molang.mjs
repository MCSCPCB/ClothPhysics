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
    else if (n.kind === "if") out.push(`(${n.cond})?{${toMolang(n.yes)}}${n.no.length ? `:{${toMolang(n.no)}}` : ""};`);
    else if (n.kind === "loop") out.push(`loop(${n.count},{${toMolang(n.body)}});`);
  }
  return out.join("");
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
  atan2: (y, x) => Math.atan2(y, x) / D, sqrt: Math.sqrt, abs: Math.abs, min: Math.min, max: Math.max,
  floor: Math.floor, ceil: Math.ceil, round: Math.round, exp: Math.exp, pow: Math.pow,
  clamp: (x, a, b) => Math.min(b, Math.max(a, x)), lerp: (a, b, t) => a + (b - a) * t, mod: (a, b) => a % b,
};
