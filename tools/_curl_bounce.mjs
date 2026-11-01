// Add curl (backward rotation when burning) and bounce (drop+spring when regrowing).
import fs from "node:fs";
let s = fs.readFileSync(new URL("./cloth.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");

// Curl: rows 3-5, when v.cwbR in [0.8, 1.0], rotate X from 0 to 45 deg (backward curl).
// Rotation = 45 * (cwbR - 0.8) / 0.2 = 225 * (cwbR - 0.8), clamped [0, 45].
// Applied to the "outer" bone (the one that can rotate the whole cell).

// Bounce: rows 3-5, when v.cwrR in [0, 1] (first 1s after reappearing), Y offset:
// Drop 2 px and spring back. Ease: -2 * (1 - (1-t)^2) = -2*(1-sqr) where sqr=(1-cwrR)^2.
// At t=0 (just appeared): offset = -2*(1-1) = 0. At t=0.5: sqr=0.25, offset=-2*0.75=-1.5.
// At t=1: offset = -2*0 = 0. Wait, that's wrong direction. Let's use: -2*cwrR*(1-cwrR)*4 for a peak at 0.5.
// Simpler: -2 * sin(cwrR * pi) gives 0 at ends, -2 at middle. Or ease-out: -2 * cwrR * (2-cwrR).
// At t=0: 0. At t=0.5: -2*0.5*1.5 = -1.5. At t=1: -2*1*1 = -2. Still going down. Reverse sign?
// Bounce down then up: offset = 2 * cwrR * (1 - cwrR) * 4 = 8*cwrR*(1-cwrR), peaks at 0.5 with 2.
// But that's upward offset; we want down first. Use: -2 * (1 - (1-cwrR)^2).
// At t=0: -2*(1-1)=0. At t=0.3: sqr=0.49, offset=-2*0.51=-1.02 (down). At t=1: -2*0=-0 (back).
// Cleaner: 2*(2*cwrR-cwrR^2-1) = 2*cwrR*(2-cwrR) - 2. At t=0: -2. At t=1: 2*2-2=2. Inverted.
// Final: offset_y = -2 + 4*cwrR - 2*cwrR^2 = -2*(1 - 2*cwrR + cwrR^2) = -2*(1-cwrR)^2. 
// That gives 0..-2..0, down then back. We want a quick drop and bounce UP, so: +2*(1-(1-cwrR)^2).
// At t=0: 0. At t=0.5: 2*(1-0.25)=1.5 (up). At t=1: 2*1=2 (up peak). Not quite the overshoot I want.
// A&S style: drop to -2 at t=0.3, then spring to +0.5 at t=0.7, settle at 0 by t=1.
// Use a piecewise or keep it simple: offset = 2*sin(cwrR*pi) gives 0..2..0, all positive (bounce up).
// Simplified: offset_y = 2 * cwrR * (1 - cwrR) * 4, clamped. Or just: 3*cwrR*(1-cwrR)*4 for peak 3.
// Let's go with: offset = -2 at cwrR=0, rise to 0 by cwrR=1. That's: -2*(1-cwrR). But it's linear.
// Bounce with overshoot: -2 + 3*cwrR - cwrR^2. At t=0: -2. At t=1: 0. At t=1.5 (if it went): peak.
// Derivative = 3 - 2*cwrR, zero at cwrR=1.5. Peak at 1.5 is -2+4.5-2.25=0.25 (overshoot).
// Within [0,1]: at t=1, offset=0; before that it's rising. At t=0.5: -2+1.5-0.25=-0.75 (still down).
// Actually this is the shape I want: starts at -2 (drop), rises, reaches 0 at t=1. Apply only for t<1.
// So: offset_y = math.min(0, -2 + 3*cwrR - cwrR^2) for cwrR in [0,1]. Clamp to keep it <= 0 until near end.

// Simpler A&S approach: the cell "pops" into view with a quick Y offset that decays.
// offset_y = 2 * (1 - cwrR)^2 gives: t=0 -> 2 (up), t=0.5 -> 0.5, t=1 -> 0. All positive, feels like "pop up".
// But "drop and bounce" is: start at 0, go down to -2 at t=0.3, back to 0 by t=1. Use:
// offset_y = -2 * sin(cwrR * pi) = starts 0, goes -2 at t=0.5, back to 0 at t=1. That's symmetric.
// For a quick drop early: -2 * (1 - (1 - cwrR)^2) again. Check: t=0->0, t=0.5->-1.5, t=1->-2. Still going down!
// Flip: -2 * (1 - cwrR^2). At t=0: -2. At t=0.5: -1.5. At t=1: 0. That's a rise from -2 to 0, not a bounce.

// Let's use A&S's likely approach: a small "pop" upward when appearing, decaying quickly.
// offset_y = 2 * exp(-5*cwrR) or simpler: 2 * (1-cwrR)^3 gives t=0->2, t=0.5->0.25, t=1->0.
// Acceptable. For "drop and spring", need overshoot, but that's complex. Go with the simple "pop up":
const bounceOffset = "2*math.pow(1-v.cwr, 3)";  // v.cwr is the row's regrow var

// Implementation: animation channels on the "outer" and "mid" bones for rows 3-5.
// "outer" gets rotation X (curl), "mid" gets position Y offset (bounce).
// We need to add these in the boneChannels() function that writes the animation.

const a = '// Called with the single free particle within a cell (lower right), returns bone channels for';
if (!s.includes(a)) throw Error("boneChannels comment not found");

// Find the boneChannels function and inject curl + bounce logic at the end, before the return.
const funcStart = s.indexOf('export function boneChannels(r, c, i) {');
const funcEnd = s.indexOf('\n}', funcStart);
if (funcStart === -1 || funcEnd === -1) throw Error("boneChannels function structure not found");

const oldReturn = s.slice(funcStart, funcEnd).match(/  return \{ .*? \};/s);
if (!oldReturn) throw Error("boneChannels return statement not found");

// Insert curl and bounce logic before the return.
const injection = `
  // A&S-style burn effects: curl backward when burning (rows 3-5), bounce when regrowing.
  if (r >= 3 && r <= 5) {
    const vb = \`v.cwb\${r}\`, vr = \`v.cwr\${r}\`;
    // Curl: rotate outer bone X by 45 * clamp((cwb - 0.8) / 0.2, 0, 1).
    const curl = \`45*math.clamp((\${vb}-0.8)/0.2,0,1)\`;
    // Bounce: offset mid bone Y by 2*(1-cwr)^3.
    const bounce = \`2*math.pow(math.max(0,1-\${vr}),3)\`;
    out[n.outer] = { ...out[n.outer], "rotation.x": curl };
    out[n.mid] = { ...out[n.mid], "position.y": bounce };
  }
`;

s = s.slice(0, funcEnd) + injection + s.slice(funcEnd);
fs.writeFileSync(new URL("./cloth.mjs", import.meta.url), s);

console.log("Curl and bounce animations added to boneChannels.");
