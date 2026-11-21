import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BatchInput, buildBatch } from "../scripts/buildings/batch.ts";
import { buildBuilding, BuildingError, BuildingInput } from "../scripts/buildings/builder.ts";
import { defaultAssetRoot, DEFAULT_LIBRARY, libraryKind, listLibraries, openLibrary } from "./config.ts";
import { composeScene, DEFAULT_PROPS_LIBRARY, listSceneProps, openPropsLibrary, SceneInputSchema } from "./scene.ts";
import { composeCharacterSprite, listSpriteParts, normalizePixelArt, normalMapFile } from "./sprite.ts";

function ok(data: object): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function fail(error: unknown): CallToolResult {
  return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
}

function buildingFailure(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { code: error instanceof BuildingError ? error.code : "BUILD_FAILED", message },
  };
}

const libraryArg = z
  .string()
  .optional()
  .describe(`Asset library id (default "${DEFAULT_LIBRARY}"). list_sprite_parts reports the available libraries, e.g. buildings, scenery.`);

const propsLibraryArg = z.string().optional().describe(`Props library id (default "${DEFAULT_PROPS_LIBRARY}")`);

/**
 * Builds the MCP server. The asset library is re-read on every call so edits to
 * manifest.json / palettes.json / parts are picked up without a restart.
 */
export function createServer(assetRoot: string = defaultAssetRoot()): McpServer {
  const server = new McpServer({ name: "godot-sprite-mcp", version: "0.1.0" });

  server.registerTool(
    "list_sprite_parts",
    {
      title: "List sprite parts",
      description:
        "List every layer (with its valid part IDs), palette ramp, palette set and animation (with frame grid coordinates) " +
        "of an asset library (characters, buildings, scenery, ...), plus the ids of all available libraries.",
      inputSchema: { library: libraryArg },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ library }) => {
      try {
        return ok({ libraries: listLibraries(assetRoot), ...listSpriteParts(openLibrary(assetRoot, library)) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "compose_character_sprite",
    {
      title: "Compose character sprite",
      description:
        "Deterministically composite part layers (a character, building, tree, ... depending on library) by z-index, apply palette swaps, and write <name>.png plus a Godot 4 " +
        "SpriteFrames resource <name>_frames.tres (one AtlasTexture per frame) into outputDir, plus <name>_CREDITS.md when " +
        "parts require attribution and an optional normal map for 2D lighting. " +
        "Same inputs always produce byte-identical files.",
      inputSchema: {
        library: libraryArg,
        name: z.string().regex(/^[A-Za-z0-9_-]+$/).describe("Base file name, e.g. 'villager_01'"),
        parts: z
          .record(z.string(), z.string().nullable())
          .describe("Layer id -> part id, e.g. {\"body\":\"base\",\"hair\":\"spiky\"}. null skips an optional layer."),
        palettes: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Layer id (or \"layer.channel\" for multi-color layers) -> palette variant, e.g. {\"body\":\"skin_tan\",\"head.eyes\":\"green\"}. " +
              "Channels with `follow` (e.g. head skin) match the followed layer unless set.",
          ),
        outputDir: z.string().describe("Destination folder, typically inside a Godot project (res:// paths are derived from project.godot)"),
        normalMap: z
          .boolean()
          .optional()
          .describe("Also write <name>_normal.png and wire it into the .tres (CanvasTexture) so Godot 2D lights shade the sprite"),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ library, ...args }) => {
      try {
        return ok(composeCharacterSprite(openLibrary(assetRoot, library), args));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "list_scene_props",
    {
      title: "List scene props",
      description: "List props and their dimensions, recolor palettes, and licenses in a scene library.",
      inputSchema: { library: propsLibraryArg },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ library }) => {
      try {
        return ok(listSceneProps(openPropsLibrary(assetRoot, library)));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "compose_scene",
    {
      title: "Compose Godot 2D scene",
      description: "Compose a sky, tiled ground, repeating backdrops, and depth-sorted props. Writes a PNG preview and an editable Godot 4 .tscn with textures, optional normal maps, and credits when available.",
      inputSchema: SceneInputSchema.extend({ library: propsLibraryArg }),
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ library, ...args }) => {
      try {
        return ok(composeScene(openPropsLibrary(assetRoot, library), args));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "generate_building_asset",
    {
      title: "Generate modular building",
      description: "Use local Blender to generate a village house, inn, inn interior, church or kegs. Writes Godot scenes, layout, sprite textures, collision and optional normal maps and GLB.",
      inputSchema: BuildingInput,
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (input, { signal }) => {
      try {
        return ok(await buildBuilding(input, undefined, signal));
      } catch (error) {
        return buildingFailure(error);
      }
    },
  );

  server.registerTool(
    "generate_building_batch",
    {
      title: "Regenerate a building manifest",
      description: "Build a version-1 manifest of village assets with stable per-ID Godot paths. Skips verified artifacts and reports failures per asset so other assets can finish.",
      inputSchema: BatchInput,
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ manifest, outputDir, jobs }, { signal }) => {
      try {
        const batch = await buildBatch(manifest, outputDir, jobs, undefined, signal);
        const result = ok(batch);
        return batch.assets.some((asset) => asset.status === "failed") ? { ...result, isError: true } : result;
      } catch (error) {
        return buildingFailure(error);
      }
    },
  );

  server.registerTool(
    "normalize_pixel_art",
    {
      title: "Normalize pixel art",
      description:
        "Downscale a PNG with nearest-neighbor sampling (no anti-aliasing), snap every pixel to the closest color in a " +
        "palette or palette set, binarise alpha, and save the result.",
      inputSchema: {
        library: libraryArg.describe("Asset library whose palettes.json defines paletteId (default \"characters\")"),
        inputPath: z.string(),
        targetWidth: z.number().int().positive(),
        targetHeight: z.number().int().positive(),
        paletteId: z.string().describe("Palette id or palette-set id from palettes.json"),
        outputPath: z.string(),
        alphaThreshold: z.number().int().min(1).max(255).optional().describe("Pixels with alpha below this become transparent (default 128)"),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ library, ...args }) => {
      try {
        return ok(normalizePixelArt(openLibrary(assetRoot, library), args));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "generate_normal_map",
    {
      title: "Generate normal map",
      description:
        "Derive a normal map (Godot convention) from any sprite or sprite sheet so it reacts to Light2D/PointLight2D — " +
        "the basis of 'cinematic' lit pixel art. Deterministic.",
      inputSchema: {
        inputPath: z.string(),
        outputPath: z.string(),
        frameWidth: z.number().int().positive().optional().describe("Frame width for sheets (default: whole image)"),
        frameHeight: z.number().int().positive().optional(),
        strength: z.number().positive().max(20).optional().describe("Slope multiplier (default 2)"),
        bevel: z.number().int().positive().max(256).optional().describe("Edge bevel in pixels (default ~1/16 of the frame)"),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      try {
        return ok(normalMapFile(args));
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}

export async function startStdioServer(assetRoot: string = defaultAssetRoot()): Promise<void> {
  // Validate up front so misconfiguration shows up in the client's server log.
  for (const id of listLibraries(assetRoot)) {
    if (libraryKind(assetRoot, id) === "props") openPropsLibrary(assetRoot, id);
    else openLibrary(assetRoot, id);
  }
  const server = createServer(assetRoot);
  await server.connect(new StdioServerTransport());
  console.error(`godot-sprite-mcp ready (assets: ${assetRoot})`);
}
