import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAssetLibrary, openLibrary, resolvePaletteColors } from "../src/config.ts";
import { createImage, writePng } from "../src/image.ts";
import { checkOutputDir, checkOutputPng } from "../src/paths.ts";
import { openPropsLibrary, composeScene } from "../src/scene.ts";
import { createServer } from "../src/server.ts";
import { resolveLayerStack } from "../src/sprite.ts";
import { tempDir } from "./helpers.ts";

describe("prototype keys are unknown ids", () => {
  test("palette, palette set and prop names like constructor/toString give clear errors", () => {
    const lib = openLibrary(undefined, "lpc_male");
    expect(() => resolveLayerStack(lib, { parts: {}, palettes: { body: "constructor" } })).toThrow(/Unknown palette "constructor" for layer "body"/);
    expect(() => resolvePaletteColors(lib, "toString")).toThrow(/Unknown palette or palette set "toString"/);
    expect(() =>
      composeScene(openPropsLibrary(join(import.meta.dir, "..")), {
        name: "x", outputDir: tempDir(), width: 8, height: 8, placements: [{ prop: "constructor", x: 1, y: 1 }],
      }),
    ).toThrow(/Unknown prop "constructor"/);
  });
});

describe("follow chains", () => {
  function chainLibrary() {
    const root = tempDir();
    const part = createImage(4, 4);
    part.data.fill(255);
    for (const layer of ["base", "mid", "top", "x", "y"]) writePng(join(root, "assets", "parts", layer, "p.png"), part);
    writeFileSync(join(root, "assets", "palettes.json"), JSON.stringify({
      families: { f: { source: ["#ffffff"], variants: { a: ["#ff0000"], b: ["#00ff00"], c: ["#0000ff"] } } },
    }));
    const ch = (extra: object) => [{ id: "main", family: "f", mode: "swap", ...extra }];
    writeFileSync(join(root, "manifest.json"), JSON.stringify({
      frameWidth: 4, frameHeight: 4, columns: 1, frameCount: 1,
      layers: [
        { id: "base", folder: "base", zIndex: 0, defaultPart: "p", channels: ch({ default: "a" }) },
        { id: "mid", folder: "mid", zIndex: 1, defaultPart: "p", channels: ch({ follow: "base" }) },
        { id: "top", folder: "top", zIndex: 2, defaultPart: "p", channels: ch({ follow: "mid", default: "c" }) },
        // A follow cycle must terminate and fall back to the defaults.
        { id: "x", folder: "x", zIndex: 3, defaultPart: "p", channels: ch({ follow: "y", default: "b" }) },
        { id: "y", folder: "y", zIndex: 4, defaultPart: "p", channels: ch({ follow: "x", default: "c" }) },
      ],
      animations: [{ name: "still", frames: [0] }],
    }));
    return loadAssetLibrary(root, "chain");
  }
  const variants = (stack: ReturnType<typeof resolveLayerStack>) => Object.fromEntries(stack.map((s) => [s.layer.id, s.recolors[0]?.variant ?? null]));

  test("a channel follows the end of the chain, explicit choices win at any link", () => {
    const lib = chainLibrary();
    expect(variants(resolveLayerStack(lib, { parts: {} }))).toMatchObject({ base: "a", mid: "a", top: "a" });
    expect(variants(resolveLayerStack(lib, { parts: {}, palettes: { base: "b" } }))).toMatchObject({ base: "b", mid: "b", top: "b" });
    expect(variants(resolveLayerStack(lib, { parts: {}, palettes: { base: "b", mid: "c" } }))).toMatchObject({ base: "b", mid: "c", top: "c" });
  });

  test("follow cycles terminate", () => {
    const lib = chainLibrary();
    expect(variants(resolveLayerStack(lib, { parts: {} }))).toMatchObject({ x: "b", y: "c" });
    expect(variants(resolveLayerStack(lib, { parts: {}, palettes: { x: "a" } }))).toMatchObject({ x: "a", y: "a" });
  });
});

describe("MCP output locations", () => {
  test("relative paths are rejected; output roots confine writes, including through symlinks", () => {
    expect(() => checkOutputDir("out/sprites", "outputDir", {})).toThrow(/must be an absolute path/);
    const root = tempDir();
    const outside = tempDir();
    const env = { GODOT_SPRITE_OUTPUT_ROOTS: root };
    expect(checkOutputDir(join(root, "game", "sprites"), "outputDir", env)).toBe(join(root, "game", "sprites"));
    expect(() => checkOutputDir(outside, "outputDir", env)).toThrow(/outside the allowed output roots/);
    expect(() => checkOutputDir(join(root, "..", "elsewhere"), "outputDir", env)).toThrow(/outside the allowed output roots/);
    symlinkSync(outside, join(root, "escape"));
    expect(() => checkOutputDir(join(root, "escape", "x"), "outputDir", env)).toThrow(/outside the allowed output roots/);
  });

  test("image tools only write .png and never overwrite a non-PNG file", () => {
    const dir = tempDir();
    expect(() => checkOutputPng(join(dir, "notes.txt"), "outputPath", {})).toThrow(/must end with \.png/);
    writeFileSync(join(dir, "fake.png"), "not an image");
    expect(() => checkOutputPng(join(dir, "fake.png"), "outputPath", {})).toThrow(/not a PNG file/);
    writePng(join(dir, "real.png"), createImage(1, 1));
    expect(checkOutputPng(join(dir, "real.png"), "outputPath", {})).toBe(join(dir, "real.png"));
  });

  test("tools reject a relative outputDir before writing anything", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverTransport);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientTransport);
    const res = await client.callTool({ name: "compose_character_sprite", arguments: { name: "rel", parts: {}, outputDir: "relative-out" } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("absolute path");
    expect(existsSync(join(process.cwd(), "relative-out"))).toBe(false);
  });
});

describe("Blender timeout", () => {
  test("a hung Blender is killed and reported as BLENDER_TIMEOUT", async () => {
    const { buildBuilding } = await import("../scripts/buildings/builder.ts");
    const dir = tempDir();
    const fake = join(dir, "hung-blender.sh");
    writeFileSync(fake, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    const previous = process.env.BLENDER_TIMEOUT_MS;
    process.env.BLENDER_TIMEOUT_MS = "400";
    const started = performance.now();
    try {
      await expect(buildBuilding({ building: "house", outputDir: join(dir, "out") }, fake)).rejects.toMatchObject({ code: "BLENDER_TIMEOUT" });
    } finally {
      if (previous === undefined) delete process.env.BLENDER_TIMEOUT_MS;
      else process.env.BLENDER_TIMEOUT_MS = previous;
    }
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(existsSync(join(dir, "out"))).toBe(false);
  });
});
