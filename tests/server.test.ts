import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readPng } from "../src/image.ts";
import { createServer } from "../src/server.ts";
import { tempDir } from "./helpers.ts";

async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("MCP server", () => {
  test("exposes the sprite and scene tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "compose_character_sprite", "compose_scene", "generate_building_asset", "generate_building_batch", "generate_normal_map", "list_scene_props", "list_sprite_parts", "normalize_pixel_art",
    ]);
  });

  test("building tool rejects mismatched template options before starting Blender", async () => {
    const client = await connect();
    const outputDir = tempDir();
    const result = await client.callTool({
      name: "generate_building_asset",
      arguments: { building: "house", interior: "upper", name: "bad_house", outputDir },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "INVALID_INPUT" });
    expect(existsSync(join(outputDir, "bad_house.png"))).toBe(false);
    await client.close();
  });

  test("lists props and exports a deterministic scene with editable Godot nodes", async () => {
    const client = await connect();
    const list = await client.callTool({ name: "list_scene_props", arguments: {} });
    expect(list.isError).toBeFalsy();
    expect(list.structuredContent).toMatchObject({ library: "village" });
    expect(JSON.stringify(list.structuredContent)).toContain("apple_tree");

    const outputDir = tempDir();
    writeFileSync(join(outputDir, "project.godot"), "config_version=5\n");
    const args = {
      name: "park",
      outputDir,
      width: 640,
      height: 400,
      sky: "#87b8d8",
      ground: { tiles: ["grass", "grass_flowers"], weights: [3, 1], y: 150 },
      layers: [{ prop: "hills", y: 160, x: 7, repeat: "x" }],
      placements: [{ prop: "cottage", x: 420, y: 380, flip: true }, { prop: "hills", x: 150, y: 200 }, { prop: "apple_tree", x: 120, y: 360 }],
      normalMap: true,
    };
    const result = await client.callTool({ name: "compose_scene", arguments: args });
    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as { pngPath: string; tscnPath: string; normalPath: string };
    const image = readPng(out.pngPath);
    expect([image.width, image.height]).toEqual([640, 400]);
    expect([...image.data.subarray(0, 4)]).toEqual([135, 184, 216, 255]);
    expect(readPng(out.normalPath).width).toBe(640);
    const scene = readFileSync(out.tscnPath, "utf8");
    expect(scene).toContain('path="res://park_assets/background.png"');
    expect(scene).toContain("region_rect = Rect2(505, 0, 640, 150)");
    expect(scene.match(/type="CanvasTexture"/g)).toHaveLength(3);
    expect(scene.indexOf("Vector2(120, 360)")).toBeLessThan(scene.indexOf("Vector2(420, 380)"));
    expect(scene).toContain("flip_h = true");
    // Rendered buildings and foliage get contact shadows on the ground, under all objects.
    expect(scene.match(/parent="Shadows"/g)).toHaveLength(2);
    expect(scene.indexOf('[node name="Shadows"')).toBeLessThan(scene.indexOf('[node name="Objects"'));

    const again = await client.callTool({ name: "compose_scene", arguments: args });
    expect(again.structuredContent).toEqual(result.structuredContent!);
    expect(readFileSync(out.tscnPath, "utf8")).toBe(scene);
  });

  test("rejects unusable ground tiles before writing a scene", async () => {
    const client = await connect();
    const outputDir = tempDir();
    const args = { name: "invalid", outputDir, width: 32, height: 32 };
    for (const ground of [
      { tiles: ["grass", "grass_flowers"], weights: [0, 0] },
      { tiles: ["grass", "hills"] },
    ]) {
      const res = await client.callTool({ name: "compose_scene", arguments: { ...args, ground } });
      expect(res.isError).toBe(true);
    }
    expect(existsSync(join(outputDir, "invalid.png"))).toBe(false);
  });

  test("list_sprite_parts and compose_character_sprite round-trip", async () => {
    const client = await connect();
    const list = await client.callTool({ name: "list_sprite_parts", arguments: {} });
    expect((list.structuredContent as { layers: unknown[] }).layers).toHaveLength(5);

    const outputDir = tempDir();
    const res = await client.callTool({
      name: "compose_character_sprite",
      arguments: { name: "npc", parts: { body: "base", hair: "long" }, palettes: { hair: "hair_blonde" }, outputDir },
    });
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent as { pngPath: string; tresPath: string; grid: { frameWidth: number } };
    expect(existsSync(out.pngPath) && existsSync(out.tresPath)).toBe(true);
    expect(out.grid.frameWidth).toBe(48);
  });

  test("compose_character_sprite accepts a library", async () => {
    const client = await connect();
    const list = await client.callTool({ name: "list_sprite_parts", arguments: { library: "buildings" } });
    expect((list.structuredContent as { libraries: string[] }).libraries).toContain("lpc_male");
    const res = await client.callTool({
      name: "compose_character_sprite",
      arguments: { library: "buildings", name: "house", parts: { chimney: "brick", windows: "square" }, outputDir: tempDir() },
    });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { grid: { sheetWidth: number } }).grid.sheetWidth).toBe(384);
  });

  test("reports invalid input as a tool error", async () => {
    const client = await connect();
    const res = await client.callTool({
      name: "compose_character_sprite",
      arguments: { name: "x", parts: { hair: "mohawk" }, outputDir: tempDir() },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("mohawk");
  });
});
