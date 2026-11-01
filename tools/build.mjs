// Writes the resource pack into ../src. Run: node tools/build.mjs
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import * as vanilla from './cloth.mjs';
import * as actions from './cloth.mjs?profile=actions_and_stuff_1_13';
import { exportPack } from './export-pack.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src");
const write = (rel, data) => {
  const file = path.join(src, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data, null, 1) + "\n");
};

// Validate both profiles before writing any pack files.
const standard = exportPack(vanilla), adapted = exportPack(actions);

// Keep UUIDs stable across rebuilds so the game treats it as the same pack.
const old = fs.existsSync(path.join(src, "manifest.json")) ? JSON.parse(fs.readFileSync(path.join(src, "manifest.json"), "utf8")) : null;
write("manifest.json", {
  format_version: 3,
  header: { name: "pack.name", description: "pack.description", uuid: old?.header.uuid ?? crypto.randomUUID(),
    version: "0.2.0", min_engine_version: "1.26.50" },
  modules: [{ type: "resources", uuid: old?.modules[0].uuid ?? crypto.randomUUID(), version: "0.2.0" }],
  capabilities: ['pbr'],
  metadata: { authors: ['MINECRAFT-SCPCB'] },
  // Bedrock initially selects the last subpack. Keep the standard mode last.
  subpacks: [
    { folder_name: actions.profile.folder, name: 'Compatible with Actions & Stuff 1.13 §8Place this pack above Actions & Stuff', memory_performance_tier: 0 },
    { folder_name: vanilla.profile.folder, name: 'Default', memory_performance_tier: 0 },
  ],
});
// Standard resources live at the pack root; the optional subpack overrides them.
for (const [prefix, pack] of [['', standard], [`subpacks/${actions.profile.folder}/`, adapted]]) {
  write(prefix + 'animations/cloth_cape.animation.json', pack.animation);
  write(prefix + 'models/entity/cloth_cape.geo.json', pack.geometry);
  write(prefix + 'render_controllers/cloth_cape.render_controllers.json', pack.render);
}
// Language files in src/texts are editable resource-pack source files.
const languages = ['en_US', 'zh_CN'];
write('texts/languages.json', languages);
write('subpacks/default/texts/languages.json', languages);
// Remove only obsolete generated files from the experimental split layout.
// Never delete directories recursively: unrelated files are user-owned.
for (const rel of ['subpacks/default/animations/cloth_cape.animation.json', 'subpacks/default/models/entity/cloth_cape.geo.json',
  'subpacks/default/render_controllers/cloth_cape.render_controllers.json'])
  fs.rmSync(path.join(src, rel), { force: true });
for (const rel of ['subpacks/default/animations', 'subpacks/default/models/entity', 'subpacks/default/models', 'subpacks/default/render_controllers']) {
  const dir = path.join(src, rel);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}
fs.copyFileSync(path.join(root, "_sample", "pack_icon.png"), path.join(src, "pack_icon.png"));
for (const [label, pack] of [['Default', standard], ['Actions & Stuff 1.13', adapted]])
  console.log(`${label}: anim_time_update ${pack.updateLength} chars, largest channel ${pack.channelMax} chars`);
