// Compatibility boundary verified against the local Actions & Stuff 1.13 pack.
// Supply both established cape entry points. The selected subpack replaces the
// complete animation file, so it must not drop the native skin/cape entry.
// The player definition and movement controllers remain supplied by A&S.
export const actionsAndStuff = {
  folder: 'actions_and_stuff_1_13',
  animation: 'animation.oreville_ans.vuslkn',
  additionalAnimations: ['animation.player.cape'],
  externalNames: ['v.cdnffy', 'v.tsrqrd', 'v.tnlxsa', 'v.svawlg', 'v.oreville_chestplate_armor_layer_hidden'],
  effects: {
    is_hurt_color: {
      r: 'v.tsrqrd=1;return 1;', g: 1, b: 1,
      a: 'Math.lerp(0.6-Math.mod(q.life_time,0.25)*2.4,0,Math.clamp((v.cdnffy??0)/0.5,0,1))',
    },
    on_fire_color: { r: 1, g: 0.4, b: 0, a: 'Math.cos(q.life_time*1200)*-0.35+0.35' },
  },
};
