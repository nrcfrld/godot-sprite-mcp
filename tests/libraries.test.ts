import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { listLibraries, openLibrary } from "../src/config.ts";
import { readPng } from "../src/image.ts";
import { composeCharacterSprite, listSpriteParts } from "../src/sprite.ts";
import { parseSpriteFramesTres, tempDir } from "./helpers.ts";

describe("asset libraries", () => {
  test("discovers the default library plus libraries/<id>", () => {
    expect(listLibraries()).toEqual(["characters", "buildings", "hd_creatures", "lpc_female", "lpc_male", "scenery", "village"]);
    expect(() => openLibrary(undefined, "spaceships")).toThrow(/Unknown library "spaceships"/);
  });

  const cases: { library: string; size: number; parts: Record<string, string>; palettes: Record<string, string> }[] = [
    {
      library: "buildings",
      size: 96,
      parts: { ground: "cobble", walls: "brick", roof: "steep", chimney: "brick", door: "arched", windows: "round", decor: "sign" },
      palettes: { roof: "roof_slate", chimney: "stone_gray" },
    },
    {
      library: "scenery",
      size: 64,
      parts: { ground: "grass", trunk: "twisted", canopy: "round", detail: "apples" },
      palettes: { canopy: "leaf_autumn" },
    },
  ];

  for (const { library, size, parts, palettes } of cases) {
    test(`${library}: composes a ${size}x${size} sheet and matching .tres`, () => {
      const lib = openLibrary(undefined, library);
      expect(listSpriteParts(lib).library).toBe(library);
      const outputDir = tempDir();
      const res = composeCharacterSprite(lib, { name: "thing", parts, palettes, outputDir });
      const img = readPng(res.pngPath);
      expect([img.width, img.height]).toEqual([size * 4, size]);
      expect(res.layers.map((l) => l.layer)).toEqual(Object.keys(parts));

      const tres = parseSpriteFramesTres(readFileSync(res.tresPath, "utf8"));
      for (const { region } of tres.atlases.values()) expect(region.slice(2)).toEqual([size, size]);
      expect(tres.animations.map((a) => a.name)).toEqual(lib.manifest.animations.map((a) => a.name));

      const again = composeCharacterSprite(lib, { name: "thing", parts, palettes, outputDir: tempDir() });
      expect(again.sha256).toBe(res.sha256);
    });
  }

  test("scenery detail layer is not palette-swappable", () => {
    const lib = openLibrary(undefined, "scenery");
    expect(() =>
      composeCharacterSprite(lib, { name: "t", parts: { detail: "apples" }, palettes: { detail: "leaf_autumn" }, outputDir: tempDir() }),
    ).toThrow(/does not support palette swapping/);
  });
});
