// Writes the resource pack into ../src. Run: node tools/build.mjs
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { program, bones, geometry, renderController } from "./cloth.mjs";
import { toMolang, checkMolang, compactNames } from "./molang.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src"), LIMIT = 61500;
const write = (rel, data) => {
  const file = path.join(src, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data, null, 1) + "\n");
};

// Validate Bedrock grammar and argument counts before writing any pack files.
const rawUpdate = toMolang(program()) + "return math.min(q.anim_time+q.delta_time,.5);", rawBones = bones(), rawRender = renderController();
const { expression: encode } = compactNames([rawUpdate, JSON.stringify(rawBones), JSON.stringify(rawRender)]);
const encodeValues = value => Array.isArray(value) ? value.map(encodeValues) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).map(([key,item]) => [key,encodeValues(item)])) : typeof value === 'string' ? encode(value) : value;
const builtBones = encodeValues(rawBones), builtRender = encodeValues(rawRender);
const update = checkMolang(encode(rawUpdate), "anim_time_update");
for (const [b, ch] of Object.entries(builtBones)) for (const [c, vals] of Object.entries(ch)) vals.forEach((x, i) => checkMolang(String(x), `${b}.${c}[${i}]`));
for (const [controller, config] of Object.entries(builtRender.render_controllers)) {
  for (const part of config.part_visibility)
    for (const [bone, expression] of Object.entries(part)) checkMolang(expression, `${controller}.${bone}`);
  for (const [component, expression] of Object.entries(config.overlay_color))
    checkMolang(String(expression), `${controller}.overlay_color.${component}`);
}
if (update.length > LIMIT) throw new Error(`anim_time_update is ${update.length} chars, over ${LIMIT}`);
const channelMax = Math.max(...Object.values(builtBones).flatMap(b => Object.values(b).flat()).map(e => String(e).length));
if (channelMax > LIMIT) throw new Error(`a bone channel is ${channelMax} chars, over ${LIMIT}`);

// Keep UUIDs stable across rebuilds so the game treats it as the same pack.
const old = fs.existsSync(path.join(src, "manifest.json")) ? JSON.parse(fs.readFileSync(path.join(src, "manifest.json"), "utf8")) : null;
write("manifest.json", {
  format_version: 3,
  header: { name: "ClothPhysics", description: "物理披风：粒子网格布料，玩家身体碰撞。", uuid: old?.header.uuid ?? crypto.randomUUID(),
    version: "0.2.0", min_engine_version: "1.26.50" },
  modules: [{ type: "resources", uuid: old?.modules[0].uuid ?? crypto.randomUUID(), version: "0.2.0" }],
});
write("animations/cloth_cape.animation.json", { format_version: "1.8.0", animations: { "animation.player.cape": {
  loop: true, animation_length: 1, anim_time_update: update, bones: builtBones } } });
write("models/entity/cloth_cape.geo.json", geometry());
write("render_controllers/cloth_cape.render_controllers.json", builtRender);
fs.copyFileSync(path.join(root, "_sample", "pack_icon.png"), path.join(src, "pack_icon.png"));
console.log(`src written: anim_time_update ${update.length} chars, largest channel ${channelMax} chars`);
