import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { defaultAssetRoot, loadAssetLibrary } from "./config.ts";
import { composeCharacterSprite, listSpriteParts, normalizePixelArt } from "./sprite.ts";

function ok(data: object): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function fail(error: unknown): CallToolResult {
  return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
}

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
        "defined by manifest.json, assets/palettes.json and assets/parts/.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => {
      try {
        return ok(listSpriteParts(loadAssetLibrary(assetRoot)));
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
        "Deterministically composite part layers by z-index, apply palette swaps, and write <name>.png plus a Godot 4 " +
        "SpriteFrames resource <name>_frames.tres (one AtlasTexture per frame) into outputDir. " +
        "Same inputs always produce byte-identical files.",
      inputSchema: {
        name: z.string().regex(/^[A-Za-z0-9_-]+$/).describe("Base file name, e.g. 'villager_01'"),
        parts: z
          .record(z.string(), z.string().nullable())
          .describe("Layer id -> part id, e.g. {\"body\":\"base\",\"hair\":\"spiky\"}. null skips an optional layer."),
        palettes: z
          .record(z.string(), z.string())
          .optional()
          .describe("Layer id -> palette id, e.g. {\"body\":\"skin_tan\",\"hair\":\"hair_black\"}"),
        outputDir: z.string().describe("Destination folder, typically inside a Godot project (res:// paths are derived from project.godot)"),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      try {
        return ok(composeCharacterSprite(loadAssetLibrary(assetRoot), args));
      } catch (e) {
        return fail(e);
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
        inputPath: z.string(),
        targetWidth: z.number().int().positive(),
        targetHeight: z.number().int().positive(),
        paletteId: z.string().describe("Palette id or palette-set id from palettes.json"),
        outputPath: z.string(),
        alphaThreshold: z.number().int().min(1).max(255).optional().describe("Pixels with alpha below this become transparent (default 128)"),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      try {
        return ok(normalizePixelArt(loadAssetLibrary(assetRoot), args));
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}

export async function startStdioServer(assetRoot?: string): Promise<void> {
  // Validate up front so misconfiguration shows up in the client's server log.
  loadAssetLibrary(assetRoot ?? defaultAssetRoot());
  const server = createServer(assetRoot);
  await server.connect(new StdioServerTransport());
  console.error(`godot-sprite-mcp ready (assets: ${assetRoot ?? defaultAssetRoot()})`);
}
