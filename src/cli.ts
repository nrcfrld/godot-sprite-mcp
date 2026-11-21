#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { defaultAssetRoot, listLibraries, openLibrary, readJson } from "./config.ts";
import { composeScene, listSceneProps, openPropsLibrary, SceneInputSchema } from "./scene.ts";
import { startStdioServer } from "./server.ts";
import { composeCharacterSprite, listSpriteParts, normalizePixelArt, normalMapFile } from "./sprite.ts";

const USAGE = `godot-sprite-mcp <command> [options]

Commands:
  serve                       Start the MCP server on stdio (default)
  list                        Print layers, parts, palettes and animations as JSON
  compose --name <n> --out <dir> [--part layer=id ...] [--palette layer[.channel]=id ...] [--normal-map]
  list-props                  Print props, dimensions and palettes (default library: village)
  compose-scene --in <json>   Compose a scene from a JSON spec (optional --out overrides outputDir)
  normalize --in <png> --out <png> --width <w> --height <h> --palette <id> [--alpha <threshold>]
  normal-map --in <png> --out <png> [--width <frameW> --height <frameH>] [--strength <n>] [--bevel <px>]

Global options:
  --library <id>              Asset library: characters (default), buildings, scenery, ...
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
      library: { type: "string" },
      name: { type: "string" },
      out: { type: "string" },
      in: { type: "string" },
      part: { type: "string", multiple: true },
      palette: { type: "string", multiple: true },
      width: { type: "string" },
      height: { type: "string" },
      alpha: { type: "string" },
      strength: { type: "string" },
      bevel: { type: "string" },
      "normal-map": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const command = positionals[0] ?? "serve";
  if (values.help || command === "help") {
    console.log(USAGE);
    return;
  }
  const root = values.assets ?? defaultAssetRoot();
  const lib = () => openLibrary(root, values.library);
  const print = (data: unknown) => console.log(JSON.stringify(data, null, 2));

  switch (command) {
    case "serve":
      await startStdioServer(root);
      return;
    case "list":
      print({ libraries: listLibraries(root), ...listSpriteParts(lib()) });
      return;
    case "compose":
      if (!values.name || !values.out) throw new Error("compose requires --name and --out");
      print(
        composeCharacterSprite(lib(), {
          name: values.name,
          outputDir: values.out,
          parts: pairs(values.part, "part"),
          palettes: pairs(values.palette, "palette"),
          normalMap: values["normal-map"],
        }),
      );
      return;
    case "list-props":
      print(listSceneProps(openPropsLibrary(root, values.library)));
      return;
    case "compose-scene": {
      if (!values.in) throw new Error("compose-scene requires --in");
      const spec = SceneInputSchema.parse({
        ...readJsonObject(values.in),
        ...(values.out === undefined ? {} : { outputDir: values.out }),
      });
      print(composeScene(openPropsLibrary(root, values.library), spec));
      return;
    }
    case "normalize":
      if (!values.in || !values.out || !values.palette?.[0]) throw new Error("normalize requires --in, --out and --palette");
      print(
        normalizePixelArt(lib(), {
          inputPath: values.in,
          outputPath: values.out,
          targetWidth: int(values.width, "width"),
          targetHeight: int(values.height, "height"),
          paletteId: values.palette[0],
          alphaThreshold: values.alpha === undefined ? undefined : int(values.alpha, "alpha"),
        }),
      );
      return;
    case "normal-map":
      if (!values.in || !values.out) throw new Error("normal-map requires --in and --out");
      print(
        normalMapFile({
          inputPath: values.in,
          outputPath: values.out,
          frameWidth: values.width === undefined ? undefined : int(values.width, "width"),
          frameHeight: values.height === undefined ? undefined : int(values.height, "height"),
          strength: values.strength === undefined ? undefined : Number(values.strength),
          bevel: values.bevel === undefined ? undefined : int(values.bevel, "bevel"),
        }),
      );
      return;
    default:
      throw new Error(`Unknown command "${command}"\n\n${USAGE}`);
  }
}

function readJsonObject(path: string): object {
  const spec = readJson(path);
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error(`Expected a JSON object in ${path}`);
  return spec;
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
