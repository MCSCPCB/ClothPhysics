// Compare this encoder with real game/pack archives without copying their assets.
// node tools/check-brarchive.mjs <file.brarchive or resource-pack directory> [...]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { encodeBrarchive, decodeBrarchive } from './pack/brarchive.mjs';

if (process.argv.length < 3) throw new Error('Provide an existing .brarchive file or reference-pack directory');
let archives = 0, entries = 0, bytes = 0;
function check(target) {
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    for (const file of fs.readdirSync(target, { withFileTypes: true }))
      if (file.isDirectory() || file.name.endsWith('.brarchive')) check(path.join(target, file.name));
    return;
  }
  if (!target.endsWith('.brarchive')) throw new Error(`Not a brarchive: ${target}`);
  const original = fs.readFileSync(target);
  let files;
  try { files = decodeBrarchive(original); }
  catch (error) { throw new Error(`${target}: ${error.message}`); }
  assert.deepEqual(encodeBrarchive(files, { preserveOrder: true }), original, target);
  archives++; entries += files.length; bytes += original.length;
}
for (const target of process.argv.slice(2)) {
  const before = archives;
  check(target);
  assert.ok(archives > before, `No reference archives found in ${target}`);
  console.log(`${target}: ${archives - before} archives reproduced byte-for-byte`);
}
console.log(`Verified ${archives} real brarchives / ${entries} entries / ${bytes} bytes; reference files unchanged.`);
