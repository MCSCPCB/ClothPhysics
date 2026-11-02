# 物理披风打包器

需要 Node.js 22 或更新版本，无需 npm 依赖。在项目根目录运行：

```powershell
node tools/pack.mjs
```

直接读取当前 `src/`，固定输出 **`packs/CapePhysics.mcpack`**。包内版本号和 UUID 沿用 `src/manifest.json`。重复运行会替换同名成品，失败时保留上次成功的成品。

默认流程：JSON 压缩 → 私有名称混淆 → brarchive 归档 → ZIP `.mcpack`。
格式已核对本机正式版 **1.26.6005.0** 和预览版 **1.26.7022.0**：二进制归档版本均为 **1**，发布 manifest 添加 `header.pack_optimization_version: "0.1.0"`。具体依据与格式见 [brarchive.md](brarchive.md)。

资源按目录装入 `__brarchive/*.brarchive`，两个子包各有独立的归档目录。语言文本和语言列表按照原版布局保留独立副本；图标和 `src/README.md` 的致谢也会打包。

文件名、披风私有骨骼名和私有 Molang 变量会被混淆，跨文件引用使用统一映射。变量采用等长改名，避免主表达式超过项目的 61,500 字符限制。原版/A&S 的公开入口、外部变量和共享玩家骨骼名保留。默认种子为资源包 UUID；相同源文件、种子和 Node.js/zlib 版本会生成相同内容。映射表不写入发布包。

```powershell
# 保留原名，但仍用 brarchive：packs/CapePhysics-plain.mcpack
node tools/pack.mjs --plain

# 便于检查 JSON 的调试包：packs/CapePhysics-plain-loose.mcpack
node tools/pack.mjs --plain --loose

# 指定种子和输出文件
node tools/pack.mjs --seed release-1 --output packs/CapePhysics.mcpack

# ZIP、brarchive、引用一致性、语言回退和源文件完整性检查
node tools/check-pack.mjs
```

`--plain` 仅关闭名称混淆，`--loose` 仅关闭 brarchive 并移除优化标记。调试输出使用不同文件名，不会覆盖默认发布包。

打包不修改 `src/`，不执行 `tools/build.mjs`，不依赖 `_sample/` 或游戏安装。如果修改生成器代码，需要先单独更新 `src/`。目前 `build.mjs` 仍硬编码版本 `0.2.0`、最低引擎版本 `1.26.50`，并从 `_sample/pack_icon.png` 复制图标，重新生成时应核对这些配置。

brarchive 是资源归档机制，名称混淆是另一个步骤；两者都不是加密。离线检查覆盖归档结构和内容一致性，游戏内导入与显示效果仍需要实际客户端验证。
