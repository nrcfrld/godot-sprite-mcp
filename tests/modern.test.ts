import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openLibrary } from "../src/config.ts";
import { createImage, readPng, writePng } from "../src/image.ts";
import { generateNormalMap } from "../src/normal.ts";
import { gradientMap, luma } from "../src/palette.ts";
import { composeCharacterSprite, normalMapFile, resolveLayerStack } from "../src/sprite.ts";
import { parseSpriteFramesTres, tempDir } from "./helpers.ts";

describe("gradient map recolor", () => {
  test("maps luminance onto the target ramp and keeps alpha", () => {
    const img = createImage(3, 1);
    img.data.set([0, 0, 0, 255, 170, 170, 170, 128, 255, 255, 255, 255]);
    const out = gradientMap(img, [[0, 0, 0], [170, 170, 170], [255, 255, 255]], [[10, 0, 0], [200, 50, 50], [255, 220, 200]]);
    expect([...out.data]).toEqual([10, 0, 0, 255, 200, 50, 50, 128, 255, 220, 200, 255]);
    expect(luma(255, 255, 255)).toBe(255);
  });
});

describe("hd_creatures (HD 2D, gradient-mapped)", () => {
  const lib = openLibrary(undefined, "hd_creatures");

  test("is a 256px HD library with CC0 credits and animations", () => {
    expect(lib.manifest.pixelArt).toBe(false);
    expect(lib.manifest.frameWidth).toBe(256);
    expect(lib.manifest.animations.map((a) => a.name)).toEqual(["idle", "walk", "roll", "jump_start", "jump_end", "fall", "hit", "death"]);
    expect(lib.credits["body/body1"]!.licenses).toEqual(["CC0"]);
  });

  test("head skin follows the body; paired wings follow each other", () => {
    const stack = resolveLayerStack(lib, {
      parts: { wing_back: "wing1", wing_front: "wing1" },
      palettes: { body: "goblin", wing_back: "dragon" },
    });
    const v = (id: string) => stack.find((s) => s.layer.id === id)!.recolors[0]!.variant;
    expect(v("head")).toBe("goblin");
    expect(v("wing_front")).toBe("dragon");
    expect(stack.find((s) => s.layer.id === "eyes")!.recolors).toEqual([]);
  });

  test("recolors with soft edges and writes a linear-filtered CanvasTexture", () => {
    const res = composeCharacterSprite(lib, { name: "imp", parts: { horns: "horn1" }, palettes: { body: "demon" }, outputDir: tempDir(), normalMap: true });
    const img = readPng(res.pngPath);
    let soft = 0;
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i]! > 0 && img.data[i]! < 255) soft++;
    expect(soft).toBeGreaterThan(1000); // anti-aliased HD edges survive
    const tres = readFileSync(res.tresPath, "utf8");
    expect(tres).toContain('normal_texture = ExtResource("2_normal")');
    expect(tres).toContain("texture_filter = 2");
    expect(res.licenses).toEqual(["CC0"]);
  });
});

describe("lpc_male (modern pixel art, indexed swap)", () => {
  const lib = openLibrary(undefined, "lpc_male");

  test("has 4-directional animations and only non-copyleft parts", () => {
    const names = lib.manifest.animations.map((a) => a.name);
    expect(names).toContain("walk_down");
    expect(names).toContain("slash_right");
    for (const credit of Object.values(lib.credits)) {
      expect(credit.licenses.length).toBeGreaterThan(0);
      for (const l of credit.licenses) expect(l).not.toMatch(/SA|GPL/);
    }
  });

  test("head has skin (following body) and eye channels", () => {
    const stack = resolveLayerStack(lib, { parts: {}, palettes: { body: "bronze", "head.eyes": "green" } });
    const head = stack.find((s) => s.layer.id === "head")!;
    expect(head.recolors.map((r) => [r.channel, r.variant])).toEqual([["main", "bronze"], ["eyes", "green"]]);
    expect(() => resolveLayerStack(lib, { parts: {}, palettes: { "head.ears": "green" } })).toThrow(/no color channel "ears"/);
  });

  test("swaps the skin palette exactly, writes credits and a nearest-filtered normal-mapped .tres", () => {
    const outputDir = tempDir();
    const res = composeCharacterSprite(lib, {
      name: "hero",
      parts: { torso: "longsleeve", legs: "pants", hair: "plain" },
      palettes: { body: "bronze", torso: "navy" },
      outputDir,
      normalMap: true,
    });
    const colors = new Set<string>();
    const img = readPng(res.pngPath);
    for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 3]) colors.add(img.data.slice(i, i + 3).join(","));
    const hex = (h: string) => [1, 3, 5].map((o) => parseInt(h.slice(o, o + 2), 16)).join(",");
    const skin = lib.families.skin!;
    // Source ("light") skin colors are gone; bronze ones are present.
    expect(colors.has(skin.source[2]!.join(","))).toBe(false);
    expect(colors.has(skin.variants.bronze![2]!.join(","))).toBe(true);
    expect(hex("#000000")).toBe("0,0,0");

    expect(existsSync(res.creditsPath!)).toBe(true);
    expect(readFileSync(res.creditsPath!, "utf8")).toContain("OGA-BY");
    const tres = parseSpriteFramesTres(readFileSync(res.tresPath, "utf8"));
    expect(tres.extResources.map((e) => e.path)).toEqual(["hero.png", "hero_normal.png"]);
    expect(tres.header.loadSteps).toBe(2 + 1 + tres.atlases.size + 1);
    expect(readFileSync(res.tresPath, "utf8")).toContain("texture_filter = 1");
    for (const a of tres.atlases.values()) expect(a.atlas).toBe("CanvasTexture_sheet");
  });
});

describe("normal maps", () => {
  test("flat interior points at the viewer, edges tilt outward, frames do not bleed", () => {
    const img = createImage(32, 16); // two 16x16 frames, each with a solid 10x10 square
    for (const fx of [0, 16]) for (let y = 3; y < 13; y++) for (let x = fx + 3; x < fx + 13; x++) img.data.set([128, 128, 128, 255], (y * 32 + x) * 4);
    const n = generateNormalMap(img, { frameWidth: 16, frameHeight: 16, bevel: 2 });
    const px = (x: number, y: number) => [...n.data.slice((y * 32 + x) * 4, (y * 32 + x) * 4 + 4)];
    expect(px(8, 8).slice(0, 3)).toEqual([128, 128, 255]); // centre faces the camera
    expect(px(3, 8)[0]!).toBeLessThan(128); // left edge leans left
    expect(px(12, 8)[0]!).toBeGreaterThan(128); // right edge leans right
    expect(px(8, 3)[1]!).toBeGreaterThan(128); // top edge leans up (green = up)
    expect(px(0, 0)).toEqual([128, 128, 255, 0]);
    expect(px(8, 8)).toEqual(px(24, 8)); // both frames identical
  });

  test("normal-map CLI path is deterministic", () => {
    const dir = tempDir();
    const img = createImage(8, 8);
    for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) img.data.set([200, 100, 50, 255], (y * 8 + x) * 4);
    writePng(join(dir, "in.png"), img);
    const a = normalMapFile({ inputPath: join(dir, "in.png"), outputPath: join(dir, "a.png") });
    const b = normalMapFile({ inputPath: join(dir, "in.png"), outputPath: join(dir, "b.png") });
    expect(a.sha256).toBe(b.sha256);
  });
});
