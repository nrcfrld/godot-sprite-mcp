# godot-sprite-mcp

Headless MCP server (stdio) that composes 2D sprite sheets and scenes for Godot 4 using local pixel-buffer operations.
The same inputs produce byte-identical PNGs, SpriteFrames resources (`.tres`), and scenes (`.tscn`).

## Setup

```sh
bun install
bun test                 # unit + MCP integration tests
bun run generate:assets  # (re)draw the procedural placeholder libraries — deterministic
```

## Connect an MCP client

Run `bun install` in this checkout before registering the local stdio server. Replace the
example paths with the absolute paths to your Bun executable (`command -v bun` on macOS/Linux)
and this checkout's `src/cli.ts`.

### Claude Code

```sh
claude mcp add godot-sprite -- \
  "/absolute/path/to/bun" "/absolute/path/to/godot-sprite-mcp/src/cli.ts" serve
claude mcp list
```

### Codex

```sh
codex mcp add godot-sprite -- \
  "/absolute/path/to/bun" "/absolute/path/to/godot-sprite-mcp/src/cli.ts" serve
codex mcp list
```

The Codex CLI, desktop app, and IDE extension share the local MCP configuration when
they use the same Codex host. Open a new session after adding the server. To configure
it from the app instead, open **Settings → MCP servers → Add server**, choose **STDIO**,
and use the Bun path as the command, with the `src/cli.ts` path and `serve` as arguments.
[Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli#connect-codex-to-an-mcp-server)

### Google Antigravity

Open **Settings → Customizations → Open MCP Config** in the standalone app. In the IDE,
open the agent panel menu **… → MCP Servers → Manage MCP Servers → View raw config**.
Add `godot-sprite` under `mcpServers`, keeping any existing entries, then save the file.
[Antigravity MCP documentation](https://antigravity.google/docs/ide-mcp)

```json
{
  "mcpServers": {
    "godot-sprite": {
      "command": "/absolute/path/to/bun",
      "args": ["/absolute/path/to/godot-sprite-mcp/src/cli.ts", "serve"]
    }
  }
}
```

### Verify the connection

In your MCP client, ask it to call `list_sprite_parts` on `godot-sprite`. The tool
should return the available asset libraries and sprite parts.

Set `GODOT_SPRITE_ASSETS_ROOT` in the server environment (or append `--assets` and an
absolute directory path to the server arguments) to use a different asset library.
The building generation tools require Blender. If the server cannot find Blender,
set `BLENDER_BIN` to its executable path. In Codex and Claude Code, pass
`--env "BLENDER_BIN=/absolute/path/to/blender"` before `--` in the registration command.
In Antigravity, add `"env": { "BLENDER_BIN": "/absolute/path/to/blender" }` inside the
`godot-sprite` object.

## Asset libraries

Sprite libraries define their own frame size, layers, palettes and animations. Props libraries contain
individual PNGs for composing scenes. Use `library` (CLI: `--library`) to select an asset library.
`list_sprite_parts` reports the available library IDs.

| Library | Style | Frame | Source art | License |
| --- | --- | --- | --- | --- |
| `hd_creatures` | HD 2D (vector, soft edges) | 256×368, 42 frames: idle, walk, roll, jump, fall, hit, death | [rgsdev modular animated characters](https://opengameart.org/content/free-cc0-modular-animated-vector-characters-2d) | CC0 |
| `lpc_male`, `lpc_female` | Modern pixel art, 4 directions | 64×64: idle, walk, run, slash, spellcast (×4 dirs), hurt | [Universal LPC generator](https://github.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator) | OGA-BY / CC-BY / CC0 — attribution required, auto-generated |
| `characters`, `buildings`, `scenery` | Procedural placeholders | 48 / 96 / 64 px | `scripts/art/` | — |
| `village` | Procedural scene props | Individual PNGs | `scripts/art/village.ts` | — |

**Cinematic pixel art** = any library + `normalMap: true` (or the `generate_normal_map` tool). The `.tres` then
uses a `CanvasTexture` with the normal map, so `PointLight2D` / `DirectionalLight2D` shade the sprite. Pair it with
`CanvasModulate` (dark ambient) and `WorldEnvironment` glow for the full look.

### Re-importing packs

Raw downloads go to `.cache/packs/` (git-ignored); the processed libraries are committed.

```sh
bun scripts/packs/rgsdev.ts   # ~70 MB download, crops + box-filters 2048px frames to 256px
bun scripts/packs/lpc.ts      # fetches only the needed sheets; skips CC-BY-SA/GPL-only items (logged)
```

### Recoloring

Each layer declares color **channels** (`manifest.json` → `layers[].channels`), each bound to a palette
**family** in `assets/palettes.json`:

- `swap` — exact indexed palette swap of the family's `source` colors (pixel art, e.g. LPC's 6-color skin ramps).
- `gradient` — maps pixel luminance onto the variant, using the source colors' luminance as stops; keeps
  anti-aliasing and soft shading (HD art).
- `follow` — e.g. the head's skin follows the body unless set explicitly.

Address a channel with `"layer"` (first channel) or `"layer.channel"`: `{"body": "bronze", "head.eyes": "green"}`.

### Credits

Libraries with `assets/credits.json` produce `<name>_CREDITS.md` next to the sprite listing authors, the license
the part is used under, and source URLs. The compose result also returns `licenses`.

## Layout

```
manifest.json            frame size, sheet grid, layers (z-index, folder, defaults), animations
assets/palettes.json     sourceRamp (key colors the parts are drawn in), palette ramps, palette sets
assets/parts/<NN_layer>/<part_id>.png   sprite sheets, all the same size (columns x rows of frames)
src/
  config.ts   manifest/palette schemas (zod) + asset discovery
  image.ts    PNG I/O with fixed encoder settings, integer source-over compositing
  palette.ts  exact-match ramp swap, nearest-color quantization
  tres.ts     Godot 4 SpriteFrames (.tres) writer, res:// path resolution
  sprite.ts   the tool operations
  normal.ts   normal-map generation
  scene.ts    prop library loader and Godot scene composer
  server.ts   MCP tool registration
  cli.ts      sprite and scene CLI
libraries/<id>/          extra asset libraries (same structure as the root)
scripts/art/             procedural placeholder art (scripts/generate-assets.ts renders it)
scripts/packs/           importers that turn free asset packs into libraries
```

### Palette swap

Parts are painted with the 4 `sourceRamp` colors (`outline`, `shadow`, `base`, `highlight`). On compose, each
swappable layer's pixels that exactly match source shade *i* become shade *i* of the chosen ramp; any other
color (eyes, lenses…) is kept as is. Layers without an explicit palette use the layer's `defaultPalette`.

## Tools

| Tool | Input | Result |
| --- | --- | --- |
| `list_sprite_parts` | `library?` | libraries, layers + part IDs (with licenses), color channels, palette families, animations with frame rects |
| `compose_character_sprite` | `library?`, `name`, `parts` {layer: partId \| null}, `palettes` {layer[.channel]: variant}, `outputDir`, `normalMap?` | writes `<name>.png`, `<name>_frames.tres`, optional `<name>_normal.png` and `<name>_CREDITS.md`; returns paths, grid, layer stack, licenses, sha256 |
| `normalize_pixel_art` | `library?`, `inputPath`, `targetWidth`, `targetHeight`, `paletteId` (variant, `family.variant`, family or set), `outputPath`, `alphaThreshold?` | nearest-neighbor downscale + snap to palette + binary alpha |
| `generate_normal_map` | `inputPath`, `outputPath`, `frameWidth?`, `frameHeight?`, `strength?`, `bevel?` | normal map for 2D lighting from any sprite/sheet |
| `list_scene_props` | `library?` (defaults to `village`) | prop IDs, dimensions, category palettes and licenses |
| `compose_scene` | `library?`, `name`, `outputDir`, `width`, `height`, `sky?`, `ground?`, `layers?`, `placements?`, `normalMap?` | PNG preview, editable Godot 4 scene, texture assets, optional normal maps and credits |

When `outputDir` is inside a Godot project (a parent has `project.godot`), the `.tres` references the texture as
`res://…`; otherwise it uses a path relative to the `.tres`, which Godot 4 also resolves.

## CLI

```sh
bun src/cli.ts list
bun src/cli.ts compose --name hero --out ../my-game/sprites \
  --part pants=trousers --part shirt=tunic --part hair=long \
  --palette body=skin_dark --palette hair=hair_blonde
bun src/cli.ts compose --library lpc_female --name mage --out ../my-game/chars --normal-map \
  --part torso=longsleeve --part legs=skirt --part hair=long_straight \
  --palette body=amber --palette torso=lavender --palette hair=platinum --palette head.eyes=purple
bun src/cli.ts compose --library hd_creatures --name imp --out ../my-game/chars \
  --part horns=horn1 --part wing_back=wing1 --part wing_front=wing1 \
  --palette body=demon --palette horns=obsidian --palette wing_back=bat
bun src/cli.ts compose --library buildings --name tavern --out ../my-game/props \
  --part walls=brick --part roof=steep --part chimney=brick --part door=arched --part windows=round --part decor=sign \
  --palette roof=roof_slate
bun src/cli.ts compose --library scenery --name apple_tree --out ../my-game/props \
  --part ground=grass --part trunk=straight --part canopy=round --part detail=apples
bun src/cli.ts normalize --in raw.png --out clean.png --width 48 --height 48 --palette game_master
```

### Compose a Godot scene

Run `bun src/cli.ts list-props` to see the default `village` props. Save a scene specification as
`scene.json` and run `bun src/cli.ts compose-scene --in scene.json`. Use `--out` to override the output directory.

```json
{
  "name": "village_square",
  "outputDir": "../my-game/maps",
  "width": 256,
  "height": 160,
  "sky": { "top": "#87b8d8", "bottom": "#d9ece3" },
  "ground": { "tiles": ["grass", "grass_flowers"], "weights": [5, 1], "y": 52 },
  "layers": [{ "prop": "hills", "x": 8, "y": 52, "repeat": "x" }],
  "placements": [
    { "prop": "tavern", "x": 128, "y": 122 },
    { "prop": "apple_tree", "x": 69, "y": 139, "flip": true },
    { "prop": "bush", "x": 186, "y": 145 }
  ],
  "normalMap": true
}
```

`sky` accepts a hex color or a `{ "top": "#rrggbb", "bottom": "#rrggbb" }` gradient.
`ground.tiles` cover the canvas from `ground.y` (default 0) and must all use the same dimensions.
Backdrop layers use their bottom edge as the `y` anchor. Placements use a bottom-center anchor
and draw in ascending `z` order (default 0), then by `y`. Props in a recolorable category accept
a `palette` variant. Keep the generated `<name>_assets/` folder with the `<name>.tscn` file.

### Generate a modular 2.5D building

The building generator uses Blender to render authored geometry, then exports a transparent PNG
and a Godot SpriteFrames resource through the sprite composer. Templates include a village house,
Inn & Bar with two separate interiors, kegs, and a church with an optional tower on either side.

```sh
bun run generate:building --out ../my-game/buildings --name village_church --tower left --normal-map
bun run generate:building --out ../my-game/buildings --name village_chapel --tower none
bun run generate:building --building inn --out ../my-game/buildings --normal-map
bun run generate:building --building house --out ../my-game/buildings --normal-map --glb
```

Use `--blender <path>` or `BLENDER_BIN` if Blender is outside `PATH`. The layout uses Y as the vertical
axis and converts to Blender's Z-up coordinates. The generator measures each foundation to place its
underside at Y=0, connects the tower through a wing socket with roof clearance, and reserves the entry
for the stairs. The cross uses the tower apex when present and the main roof otherwise. An ornament
that still intersects another module is omitted. Unexpected overlap between structural modules
stops the build before rendering. The `<name>.layout.json` output records the sockets used.

#### Inn interiors

Request either floor as a cutaway sprite with the same footprint and camera as the inn exterior.
The ground floor contains the taproom and stairs. The upper floor contains two guest rooms, a
corridor, and a matching stairwell opening. The generator checks reserved passages for mesh overlaps.
Interior wood, plaster, and cloth use matte procedural materials with stylized surface detail.

```sh
bun run generate:building --building inn --interior ground --out ../my-game/buildings --normal-map
bun run generate:building --building inn --interior upper --out ../my-game/buildings --normal-map
```

Each floor exports a composite PNG and SpriteFrames for previews, plus a layered `.tscn` for gameplay.
Keep the `<name>_layers/` directory with the scene. It contains `shell.png`, individual textures for
furniture and partition segments, and `layout.json` with each layer's projected anchor and crop offset.

Add your player under the scene's `YSort` node, with the player origin at its feet. Furniture and
partition segments share that sort layer. Rugs and the entrance mat sit below it. The `Markers` node
contains projected door and stair positions. The layout JSON also records Y-up markers and floor
elevation for use by game logic.

Generated building scenes load `_building_footprints.gd`, which creates collision bodies from the
layout JSON. Keep the script and layout together with the scene. Exterior scenes export building
foundation collisions for use with your world map. Interior navigation uses the deck footprint
with the walls, furniture bases, and stairwell excluded, plus 0.14 world units of clearance.
The entrance remains open. Wire door and stair transitions from the exported markers in your game.
In packaged Godot exports, the scene can use the same geometry embedded at generation time.

#### Scale contract and production batches

Buildings and props share the fixed orthographic camera. One world unit is one meter at
46.08 orthographic pixels per meter, with a 2.05 m door casing and a ground pivot reported in
pixel coordinates in `scale` in each layout JSON. For the LPC reference actor, the calibration
script measures the standing frame, places the origin at the feet, and uses the camera's
**projected vertical** pixels per meter for the 1.75 m reference height.

```sh
bun run generate:buildings --manifest scripts/buildings/village-batch.json --out ../my-game/buildings --jobs 2
bun scripts/calibrate-character.ts --layout ../my-game/buildings/village_inn/village_inn.layout.json --out ../my-game/actors
```

The version-1 manifest assigns each asset a stable ID and outputs it at `<out>/<id>/`.
The batch checks engine sources, Blender version, options, and output hashes. It skips verified
artifacts, repairs missing files, and records results per asset. A failed asset preserves its
last successful output, and other assets can finish. Existing Godot import sidecars stay with
their paths. `glb: true` also exports the validated mesh assembly and its supported material
properties. The sprite render carries Blender's procedural shading.

The MCP server exposes the same generator via `generate_building_asset`
(`building`, `outputDir`, optional `name`, `interior`, `tower`, `normalMap`, `glb`) and
`generate_building_batch` (`manifest`, `outputDir`, optional `jobs`). Set `BLENDER_BIN`
in the server environment for a custom Blender installation.
