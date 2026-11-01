import { toMolang, checkMolang, compactNames } from './molang.mjs';

export const clockReturn = 'return math.min(q.anim_time+q.delta_time,.5);';
const LIMIT = 61500;

// One variable map for all files of a profile. A&S variables are external and
// must keep their names, including v.cdnffy (which starts like local cloth state).
export function exportPack(cloth) {
  const raw = toMolang(cloth.program()) + clockReturn;
  const rawBones = cloth.bones(), rawRender = cloth.renderController();
  const { expression: encode } = compactNames([raw, JSON.stringify(rawBones), JSON.stringify(rawRender)], cloth.profile);
  const encodeValues = value => Array.isArray(value) ? value.map(encodeValues) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeValues(item)])) : typeof value === 'string' ? encode(value) : value;
  const bones = encodeValues(rawBones), render = encodeValues(rawRender);
  const update = checkMolang(encode(raw), 'anim_time_update');
  for (const [bone, channels] of Object.entries(bones)) for (const [channel, values] of Object.entries(channels))
    values.forEach((value, axis) => checkMolang(String(value), `${bone}.${channel}[${axis}]`));
  for (const [id, config] of Object.entries(render.render_controllers)) {
    for (const part of config.part_visibility) for (const [bone, expression] of Object.entries(part)) checkMolang(expression, `${id}.${bone}`);
    for (const color of ['overlay_color', 'is_hurt_color', 'on_fire_color'])
      for (const [component, expression] of Object.entries(config[color] ?? {})) checkMolang(String(expression), `${id}.${color}.${component}`);
  }
  const channelMax = Math.max(...Object.values(bones).flatMap(b => Object.values(b).flat()).map(e => String(e).length));
  if (update.length > LIMIT || channelMax > LIMIT) throw new Error(`${cloth.profile.animation}: Molang exceeds ${LIMIT} characters`);
  // The aliases share one solver state, frame stamp and output cache. Keeping the
  // native entry is necessary when an override replaces the entire animation file.
  const animation = { loop: true, animation_length: 1, anim_time_update: update, bones };
  const entries = [cloth.profile.animation, ...(cloth.profile.additionalAnimations ?? [])];
  return {
    animation: { format_version: '1.8.0', animations: Object.fromEntries(entries.map(id => [id, animation])) },
    geometry: cloth.geometry(), render, updateLength: update.length, channelMax,
  };
}
