// Standard upper-body bones for offline player fixtures that focus on other inputs.
export function upperBone(name) {
  if (name === 'head') return {t:{x:0,y:24,z:0},r:{x:0,y:0,z:0}};
  if (name === 'rightarm' || name === 'leftarm') return {t:{x:name==='rightarm'?-5:5,y:22,z:0},r:{x:0,y:0,z:0}};
  throw new Error('Unexpected fixture bone: '+name);
}
