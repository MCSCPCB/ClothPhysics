// Quick syntax verification for burn animation logic
import { ROWS, COLS, boneNames } from './cloth.mjs';

console.log("Verifying burn animation syntax...");

// Test row 3, col 0 (should have burn effects)
const r = 3, c = 0;
const n = boneNames(r, c);

// Simulate the expressions
const curl = r >= 3 && r <= 5 ? `+45*math.clamp(((v.cwb${r}??0)-0.8)/0.2,0,1)` : "";
const vr = "(6+126*q.cape_flap_amount)";
const vrCurl = curl ? `(${vr}${curl})` : vr;
const bounce = r >= 3 && r <= 5 ? `2*math.pow(math.max(0,1-(v.cwr${r}??0)),3)` : "0";

console.log(`\nRow ${r}, Col ${c}:`);
console.log(`  curl: ${curl}`);
console.log(`  vrCurl: ${vrCurl}`);
console.log(`  bounce: ${bounce}`);

// Check parentheses balance
const checkBalance = (str, name) => {
  const open = (str.match(/\(/g) || []).length;
  const close = (str.match(/\)/g) || []).length;
  if (open === close) {
    console.log(`  ✓ ${name} balanced: ${open} pairs`);
  } else {
    console.log(`  ✗ ${name} UNBALANCED: ${open} open, ${close} close`);
    return false;
  }
  return true;
};

let ok = true;
ok = checkBalance(curl, "curl") && ok;
ok = checkBalance(vrCurl, "vrCurl") && ok;
ok = checkBalance(bounce, "bounce") && ok;

// Test rotation expression
const rotX = `${vr}${curl}`;
ok = checkBalance(rotX, "rotation X") && ok;

// Test position Y expression (most complex)
const dy = -1.333333;
const posY = `${dy}*(math.cos(${vrCurl})-1)`;
ok = checkBalance(posY, "position Y") && ok;

console.log(`\n${ok ? "✓ All syntax checks passed" : "✗ Syntax errors found"}`);
process.exit(ok ? 0 : 1);
