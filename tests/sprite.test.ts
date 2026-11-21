import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAssetLibrary, rampColors, resolvePaletteColors } from "../src/config.ts";
import { createImage, decodePng, parseHex, readPng, writePng } from "../src/image.ts";
import { composeCharacterSprite, listSpriteParts, normalizePixelArt, resizeNearest } from "../src/sprite.ts";
import { parseSpriteFramesTres, tempDir } from "./helpers.ts";

const lib = loadAssetLibrary();
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const request = {
  name: "hero",
  parts: { body: "base", pants: "trousers", shirt: "tshirt", hair: "short", accessory: "glasses" },
  palettes: { body: "skin_tan", pants: "cloth_blue", shirt: "cloth_green", hair: "hair_black", accessory: "metal_gold" },
};

function colorSet(img: { data: Uint8Array }): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3]) out.add(`${img.data[i]},${img.data[i + 1]},${img.data[i + 2]}`);
  }
  return out;
}
const rgbKey = (c: readonly number[]) => c.join(",");

describe("list_sprite_parts", () => {
  test("reports layers, parts, palettes and animations", () => {
    const info = listSpriteParts(lib);
    expect(info.frameWidth).toBe(48);
    expect(info.frameHeight).toBe(48);
    expect(info.layers.map((l) => l.id)).toEqual(["body", "pants", "shirt", "hair", "accessory"]);
    expect(info.layers.find((l) => l.id === "hair")!.parts.map((p) => p.id)).toEqual(["long", "short"]);
    expect(info.palettes.map((p) => p.id)).toContain("skin_light");
    expect(info.animations.map((a) => a.name)).toEqual(["idle", "walk", "action"]);
    expect(info.animations[1]!.frames[1]).toEqual({ index: 2, x: 96, y: 0, w: 48, h: 48 });
  });
});

describe("compose_character_sprite", () => {
  test("writes a valid PNG sprite sheet with the manifest grid", () => {
    const res = composeCharacterSprite(lib, { ...request, outputDir: tempDir() });
    const bytes = readFileSync(res.pngPath);
    expect([...bytes.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    const img = decodePng(bytes);
    expect(img.width).toBe(192);
    expect(img.height).toBe(48);
    expect(res.grid).toMatchObject({ frameWidth: 48, frameHeight: 48, columns: 4, rows: 1, frameCount: 4 });
    // Every frame contains a character.
    for (let f = 0; f < 4; f++) {
      let opaque = 0;
      for (let y = 0; y < 48; y++) for (let x = f * 48; x < f * 48 + 48; x++) opaque += img.data[(y * 192 + x) * 4 + 3]! ? 1 : 0;
      expect(opaque).toBeGreaterThan(200);
    }
  });

  test("writes a well-formed Godot 4 SpriteFrames .tres", () => {
    const res = composeCharacterSprite(lib, { ...request, outputDir: tempDir() });
    const tres = parseSpriteFramesTres(readFileSync(res.tresPath, "utf8"));
    expect(res.tresPath.endsWith("hero_frames.tres")).toBe(true);
    expect(tres.header).toEqual({ type: "SpriteFrames", format: 3, loadSteps: 1 + tres.atlases.size + 1 });
    expect(tres.extResources).toEqual([{ type: "Texture2D", path: "hero.png", id: "1_sheet" }]);

    expect(tres.atlases.size).toBe(4);
    for (const { atlas, region } of tres.atlases.values()) {
      expect(atlas).toBe("1_sheet");
      const [x, y, w, h] = region;
      expect([w, h]).toEqual([48, 48]);
      expect(x % 48 === 0 && y % 48 === 0 && x + w <= 192 && y + h <= 48).toBe(true);
    }

    expect(tres.animations.map((a) => a.name)).toEqual(lib.manifest.animations.map((a) => a.name));
    for (const anim of tres.animations) {
      const spec = lib.manifest.animations.find((a) => a.name === anim.name)!;
      expect(anim.speed).toBe(spec.fps);
      expect(anim.loop).toBe(spec.loop);
      const regions = anim.frames.map((f) => tres.atlases.get(f.texture)!.region[0]);
      expect(regions).toEqual(spec.frames.map((f) => f * 48));
    }
  });

  test("uses res:// texture paths inside a Godot project", () => {
    const project = tempDir();
    writeFileSync(join(project, "project.godot"), "config_version=5\n");
    const res = composeCharacterSprite(lib, { ...request, outputDir: join(project, "sprites", "npc") });
    expect(res.texturePath).toBe("res://sprites/npc/hero.png");
    expect(readFileSync(res.tresPath, "utf8")).toContain('path="res://sprites/npc/hero.png"');
  });

  test("is deterministic: identical inputs give byte-identical files", () => {
    const a = composeCharacterSprite(lib, { ...request, outputDir: tempDir() });
    const b = composeCharacterSprite(lib, { ...request, outputDir: tempDir() });
    expect(readFileSync(a.pngPath).equals(readFileSync(b.pngPath))).toBe(true);
    expect(readFileSync(a.tresPath, "utf8")).toBe(readFileSync(b.tresPath, "utf8"));
    expect(a.sha256).toBe(b.sha256);
  });

  test("applies palette swaps: no source ramp colors survive, target ramps appear", () => {
    const res = composeCharacterSprite(lib, { ...request, outputDir: tempDir() });
    const colors = colorSet(readPng(res.pngPath));
    for (const c of rampColors(lib.palettes.sourceRamp!)) expect(colors.has(rgbKey(c))).toBe(false);
    for (const id of Object.values(request.palettes)) {
      const ramp = rampColors(lib.palettes.palettes[id]!);
      expect(ramp.some((c) => colors.has(rgbKey(c)))).toBe(true);
    }
    // Fixed detail colors (glasses lenses) are not swapped.
    expect(colors.has(rgbKey(parseHex("#9ad8ff")))).toBe(true);
  });

  test("different palettes change pixels but not the silhouette", () => {
    const a = readPng(composeCharacterSprite(lib, { ...request, outputDir: tempDir() }).pngPath);
    const b = readPng(
      composeCharacterSprite(lib, { ...request, palettes: { ...request.palettes, hair: "hair_blonde" }, outputDir: tempDir() }).pngPath,
    );
    let diff = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      expect(a.data[i + 3]).toBe(b.data[i + 3]!);
      if (a.data[i] !== b.data[i]) diff++;
    }
    expect(diff).toBeGreaterThan(0);
  });

  test("respects z-order: hair is drawn over the body", () => {
    const res = composeCharacterSprite(lib, { ...request, outputDir: tempDir() });
    const img = readPng(res.pngPath);
    const i = (8 * 192 + 24) * 4; // top of head, frame 0
    const hair = rampColors(lib.palettes.palettes.hair_black!).map(rgbKey);
    expect(hair).toContain(rgbKey([...img.data.subarray(i, i + 3)]));
  });

  test("rejects invalid requests with helpful errors", () => {
    const outputDir = tempDir();
    expect(() => composeCharacterSprite(lib, { ...request, parts: { ...request.parts, hair: "mohawk" }, outputDir })).toThrow(/Unknown part "mohawk"/);
    expect(() => composeCharacterSprite(lib, { ...request, palettes: { ...request.palettes, hair: "neon" }, outputDir })).toThrow(/Unknown palette "neon"/);
    expect(() => composeCharacterSprite(lib, { ...request, parts: { ...request.parts, wings: "big" }, outputDir })).toThrow(/Unknown layer "wings"/);
    expect(() => composeCharacterSprite(lib, { ...request, parts: { ...request.parts, body: null }, outputDir })).toThrow(/required/);
    expect(() => composeCharacterSprite(lib, { ...request, name: "../evil", outputDir })).toThrow(/Invalid name/);
  });

  test("accepts folder names as layer keys and skips optional layers", () => {
    const res = composeCharacterSprite(lib, {
      name: "minimal",
      parts: { "01_body": "base", hair: null },
      palettes: { "01_body": "skin_dark" },
      outputDir: tempDir(),
    });
    expect(res.layers).toEqual([{ layer: "body", zIndex: 0, part: "base", palette: "skin_dark" }]);
  });
});

describe("normalize_pixel_art", () => {
  test("nearest-neighbor downscale picks source pixels without blending", () => {
    const src = createImage(4, 4);
    for (let i = 0; i < 16; i++) src.data.set([i * 10, 0, 0, 255], i * 4);
    const out = resizeNearest(src, 2, 2);
    // Pixel centers (0.5,0.5)->(1,1), (1.5,0.5)->(3,1), ...
    expect([out.data[0], out.data[4], out.data[8], out.data[12]]).toEqual([50, 70, 130, 150]);
  });

  test("downscales and snaps every pixel to the palette, deterministically", () => {
    const dir = tempDir();
    const input = join(dir, "raw.png");
    // Deterministic noisy gradient with soft alpha edges, like an AI/painted raw asset.
    const raw = createImage(96, 80);
    let seed = 1234;
    const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 0xff;
    for (let y = 0; y < 80; y++)
      for (let x = 0; x < 96; x++) {
        const a = x < 4 || y < 4 ? 60 : x < 8 ? 200 : 255;
        raw.data.set([(x * 2 + rand() / 8) & 0xff, (y * 3) & 0xff, rand(), a], (y * 96 + x) * 4);
      }
    writePng(input, raw);

    const r1 = normalizePixelArt(lib, { inputPath: input, targetWidth: 48, targetHeight: 40, paletteId: "game_master", outputPath: join(dir, "a.png") });
    const r2 = normalizePixelArt(lib, { inputPath: input, targetWidth: 48, targetHeight: 40, paletteId: "game_master", outputPath: join(dir, "b.png") });
    expect(readFileSync(r1.outputPath).equals(readFileSync(r2.outputPath))).toBe(true);

    const out = readPng(r1.outputPath);
    expect([out.width, out.height]).toEqual([48, 40]);
    const allowed = new Set(resolvePaletteColors(lib, "game_master").map(rgbKey));
    for (const c of colorSet(out)) expect(allowed.has(c)).toBe(true);
    for (let i = 3; i < out.data.length; i += 4) expect([0, 255]).toContain(out.data[i]!);
    expect(out.data[3]).toBe(0); // soft edge (alpha 60) dropped
    expect(r1.colorsUsed).toBeGreaterThan(1);
  });

  test("accepts a single ramp id and rejects unknown palettes", () => {
    const dir = tempDir();
    const input = join(dir, "in.png");
    const img = createImage(8, 8);
    img.data.fill(200);
    writePng(input, img);
    const res = normalizePixelArt(lib, { inputPath: input, targetWidth: 4, targetHeight: 4, paletteId: "cloth_red", outputPath: join(dir, "o.png") });
    expect(res.paletteSize).toBe(4);
    expect(() =>
      normalizePixelArt(lib, { inputPath: input, targetWidth: 4, targetHeight: 4, paletteId: "nope", outputPath: join(dir, "o.png") }),
    ).toThrow(/Unknown palette/);
  });
});
