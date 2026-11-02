# brarchive format used by this packager

Verified on 2026-11-02 against the locally installed Microsoft.MinecraftUWP
**1.26.6005.0** and Microsoft.MinecraftWindowsBeta **1.26.7022.0**. Every archive
header in their `data/resource_packs` trees used binary version **1**: 1,288
archives in the release installation and 1,302 in Preview. The corresponding
vanilla manifests declare `header.pack_optimization_version: "0.1.0"`.
These are distinct version fields. The implementation matches the newest local
Preview as well as the release; it does not invent a newer format number.

Additional reference: the local `Project/DarkFountain/sample/Actions and Stuff
1.11` pack uses the same layout and manifest marker. The unpacked Actions &
Stuff 1.13 sample in this project does not contain its original archives.
No reference-pack assets are included in this repository or its output.

The reader/encoder reproduced all **2,758** reference archives byte-for-byte:
1,288 release + 1,302 Preview + 168 A&S archives, containing **67,534** records
and **544,773,426** archive bytes in total. This verifies actual binary output
against independently produced game files, including A&S's unsorted tables.

All integers are unsigned and little-endian:

| Offset | Size | Meaning |
| --- | --- | --- |
| 0 | 8 | Magic bytes `7d 27 25 b1 a0 52 70 26` |
| 8 | 4 | File count |
| 12 | 4 | Binary archive version, currently `1` |
| 16 | count × 256 | File table (vanilla orders by UTF-8 filename bytes) |
| 16 + count × 256 | remaining | Concatenated file payloads |

Each 256-byte table record contains:

| Record offset | Size | Meaning |
| --- | --- | --- |
| 0 | 1 | UTF-8 filename byte length, at most 247 |
| 1 | 247 | Filename followed by zero padding |
| 248 | 4 | Offset relative to the payload start |
| 252 | 4 | Payload byte length |

There is no per-file compression or encryption in this observed format. ZIP
compression applies to the outer `.mcpack`. Zero-length records have offset
zero even when preceding records store data; the game packs use these for
resources kept as loose files, including `.lang`, textures and audio.
Some A&S tables use insertion order instead of byte ordering; the reader accepts
either, and new cape archives use vanilla's sorted order for reproducible output.

The directory `animations/` becomes `__brarchive/animations.brarchive`;
`models/entity/` becomes `__brarchive/models/entity.brarchive`. Parent directories
also get an archive, possibly with zero entries. Each subpack has its own
`subpacks/<folder>/__brarchive/` tree. Root metadata, icon and credits stay loose.
JSON files in resource directories are stored in the archives; other files
retain loose copies and zero-length records. `texts/languages.json` is both
archived and kept loose, matching the release and Preview vanilla packs.

`node tools/check-pack.mjs` validates the produced ZIP, archive tables, reconstructed
virtual files and both cape profiles. To reproduce the byte-for-byte comparison
against another installed game or reference pack, run:

```powershell
node tools/check-brarchive.mjs "C:/path/to/Minecraft/data/resource_packs"
```

The reader rejects unknown versions, truncated data, invalid offsets, duplicate
filenames and unexpected padding/trailing bytes. This avoids silently treating a
future changed archive layout as version 1. A future game update can be checked
with the same command. Format reproduction is checked offline; client import and
rendering remain an in-game validation step.
