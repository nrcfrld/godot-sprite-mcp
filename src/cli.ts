#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { defaultAssetRoot, loadAssetLibrary } from "./config.ts";
import { startStdioServer } from "./server.ts";
import { composeCharacterSprite, listSpriteParts, normalizePixelArt } from "./sprite.ts";

const USAGE = `godot-sprite-mcp <command> [options]

Commands:
  serve                       Start the MCP server on stdio (default)
  list                        Print layers, parts, palettes and animations as JSON
  compose --name <n> --out <dir> [--part layer=id ...] [--palette layer=id ...]
  normalize --in <png> --out <png> --width <w> --height <h> --palette <id> [--alpha <threshold>]

Global options:
  --assets <dir>              Asset root containing manifest.json (default: $GODOT_SPRITE_ASSETS_ROOT or package root)
`;

function pairs(values: string[] | undefined, flag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of values ?? []) {
    const eq = v.indexOf("=");
    if (eq <= 0) throw new Error(`--${flag} expects layer=id, got "${v}"`);
    out[v.slice(0, eq)] = v.slice(eq + 1);
  }
  return out;
}

function int(value: string | undefined, flag: string): number {
  const n = Number(value);
  if (value === undefined || !Number.isInteger(n)) throw new Error(`--${flag} must be an integer`);
  return n;
}

async function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      assets: { type: "string" },
      name: { type: "string" },
      out: { type: "string" },
      in: { type: "string" },
      part: { type: "string", multiple: true },
      palette: { type: "string", multiple: true },
      width: { type: "string" },
      height: { type: "string" },
      alpha: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const command = positionals[0] ?? "serve";
  if (values.help || command === "help") {
    console.log(USAGE);
    return;
  }
  const root = values.assets ?? defaultAssetRoot();
  const print = (data: unknown) => console.log(JSON.stringify(data, null, 2));

  switch (command) {
    case "serve":
      await startStdioServer(root);
      return;
    case "list":
      print(listSpriteParts(loadAssetLibrary(root)));
      return;
    case "compose":
      if (!values.name || !values.out) throw new Error("compose requires --name and --out");
      print(
        composeCharacterSprite(loadAssetLibrary(root), {
          name: values.name,
          outputDir: values.out,
          parts: pairs(values.part, "part"),
          palettes: pairs(values.palette, "palette"),
        }),
      );
      return;
    case "normalize":
      if (!values.in || !values.out || !values.palette?.[0]) throw new Error("normalize requires --in, --out and --palette");
      print(
        normalizePixelArt(loadAssetLibrary(root), {
          inputPath: values.in,
          outputPath: values.out,
          targetWidth: int(values.width, "width"),
          targetHeight: int(values.height, "height"),
          paletteId: values.palette[0],
          alphaThreshold: values.alpha === undefined ? undefined : int(values.alpha, "alpha"),
        }),
      );
      return;
    default:
      throw new Error(`Unknown command "${command}"\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
