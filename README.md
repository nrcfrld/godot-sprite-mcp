# godot-sprite-mcp

Headless MCP server (stdio) that assembles 2D pixel-art sprite sheets for Godot 4 using **only local pixel-buffer
operations**: layer compositing + indexed palette swapping via `pngjs`. No generative AI, no network.
The same input always produces byte-identical `.png` and `.tres` files.

## Setup

```sh
bun install
bun test                 # unit + MCP integration tests
bun run generate:assets  # (re)draw the dummy parts in assets/parts/ — deterministic
```

Register with an MCP client (e.g. Claude Code):

```sh
claude mcp add godot-sprite -- bun /abs/path/to/godot-sprite-mcp/src/cli.ts serve
```

Set `GODOT_SPRITE_ASSETS_ROOT` (or `--assets <dir>`) to use an asset library other than this repo.

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
  sprite.ts   the three operations
  server.ts   MCP tool registration
  cli.ts      CLI (serve | list | compose | normalize)
```

### Palette swap

Parts are painted with the 4 `sourceRamp` colors (`outline`, `shadow`, `base`, `highlight`). On compose, each
swappable layer's pixels that exactly match source shade *i* become shade *i* of the chosen ramp; any other
color (eyes, lenses…) is kept as is. Layers without an explicit palette use the layer's `defaultPalette`.

## Tools

| Tool | Input | Result |
| --- | --- | --- |
| `list_sprite_parts` | – | layers + part IDs, palettes, palette sets, animations with frame rects |
| `compose_character_sprite` | `name`, `parts` {layer: partId \| null}, `palettes` {layer: paletteId}, `outputDir` | writes `<name>.png` + `<name>_frames.tres`; returns paths, grid, layer stack, sha256 |
| `normalize_pixel_art` | `inputPath`, `targetWidth`, `targetHeight`, `paletteId` (ramp or set), `outputPath`, `alphaThreshold?` | nearest-neighbor downscale + snap to palette + binary alpha |

When `outputDir` is inside a Godot project (a parent has `project.godot`), the `.tres` references the texture as
`res://…`; otherwise it uses a path relative to the `.tres`, which Godot 4 also resolves.

## CLI

```sh
bun src/cli.ts list
bun src/cli.ts compose --name hero --out ../my-game/sprites \
  --part pants=trousers --part shirt=tunic --part hair=long \
  --palette body=skin_dark --palette hair=hair_blonde
bun src/cli.ts normalize --in raw.png --out clean.png --width 48 --height 48 --palette game_master
```
