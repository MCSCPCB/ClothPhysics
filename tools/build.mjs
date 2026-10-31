// Writes the resource pack into ../src. Run: node tools/build.mjs
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { program, bones, geometry, renderController } from "./cloth.mjs";
import { toMolang, checkMolang } from "./molang.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src"), LIMIT = 61500;
const write = (rel, data) => {
  const file = path.join(src, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data, null, 1) + "\n");
};

// Every expression is checked for Molang argument counts before anything is written.
const update = checkMolang(toMolang(program()) + "return 0;", "anim_time_update");
for (const [b, ch] of Object.entries(bones())) for (const [c, vals] of Object.entries(ch)) vals.forEach((x, i) => checkMolang(String(x), `${b}.${c}[${i}]`));
if (update.length > LIMIT) throw new Error(`anim_time_update is ${update.length} chars, over ${LIMIT}`);
const channelMax = Math.max(...Object.values(bones()).flatMap(b => Object.values(b).flat()).map(e => String(e).length));
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
  loop: true, animation_length: 1, anim_time_update: update, bones: bones() } } });
write("models/entity/cloth_cape.geo.json", geometry());
write("render_controllers/cloth_cape.render_controllers.json", renderController());
fs.copyFileSync(path.join(root, "_sample", "pack_icon.png"), path.join(src, "pack_icon.png"));
console.log(`src written: anim_time_update ${update.length} chars, largest channel ${channelMax} chars`);
