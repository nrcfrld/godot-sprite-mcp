import { join } from "node:path";
import { openLibrary, type AssetLibrary } from "../../src/config.ts";
import { createImage, parseHex, writePng, type RgbaImage } from "../../src/image.ts";
import { renderLayerStack, resolveLayerStack } from "../../src/sprite.ts";
import { hash } from "./canvas.ts";

function firstFrame(sheet: RgbaImage, width: number, height: number): RgbaImage {
  let bottom = height;
  while (bottom > 1) {
    const rowStart = (bottom - 1) * sheet.width * 4;
    if (sheet.data.subarray(rowStart, rowStart + width * 4).some((value, i) => i % 4 === 3 && value > 0)) break;
    bottom--;
  }
  const frame = createImage(width, bottom);
  for (let y = 0; y < bottom; y++) {
    const rowStart = y * sheet.width * 4;
    frame.data.set(sheet.data.subarray(rowStart, rowStart + width * 4), y * width * 4);
  }
  return frame;
}

export function renderVillage(root: string): string[] {
  const written: string[] = [];
  const save = (category: string, name: string, image: RgbaImage) => {
    const path = join(root, "libraries/village/assets/props", category, `${name}.png`);
    writePng(path, image);
    written.push(path);
  };

  const buildings = openLibrary(root, "buildings");
  const scenery = openLibrary(root, "scenery");
  const props: { category: string; name: string; lib: AssetLibrary; parts: Record<string, string> }[] = [
    { category: "buildings", name: "cottage", lib: buildings, parts: { chimney: "brick", door: "plank", windows: "square" } },
    { category: "buildings", name: "tavern", lib: buildings, parts: { walls: "brick", roof: "steep", chimney: "brick", door: "arched", windows: "round", decor: "sign" } },
    { category: "foliage", name: "apple_tree", lib: scenery, parts: { trunk: "straight", canopy: "round", detail: "apples" } },
    { category: "foliage", name: "pine_tree", lib: scenery, parts: { trunk: "straight", canopy: "pine" } },
    { category: "foliage", name: "bush", lib: scenery, parts: { canopy: "bush" } },
  ];
  for (const { category, name, lib, parts } of props) {
    const sheet = renderLayerStack(lib, resolveLayerStack(lib, { parts }));
    save(category, name, firstFrame(sheet, lib.manifest.frameWidth, lib.manifest.frameHeight));
  }

  for (const [variant, name] of ["grass", "grass_flowers"].entries()) {
    const tile = createImage(16, 16);
    const base = parseHex("#679253");
    const fleck = parseHex("#709b58");
    const flower = parseHex("#f0cf79");
    for (let y = 0; y < tile.height; y++) {
      for (let x = 0; x < tile.width; x++) {
        const noise = hash(x, y) % 37;
        const color = variant && noise === 1 ? flower : noise < 8 ? fleck : base;
        tile.data.set([...color, 255], (y * tile.width + x) * 4);
      }
    }
    save("tiles", name, tile);
  }

  const hills = createImage(96, 32);
  const ridge = [16, 12, 7, 5, 8, 14, 18, 21, 19, 13, 10, 12];
  const topColor = parseHex("#819d79");
  const baseColor = parseHex("#688969");
  for (let x = 0; x < hills.width; x++) {
    const segment = Math.floor(x / 8);
    const offset = x % 8;
    const top = Math.round((ridge[segment]! * (8 - offset) + ridge[(segment + 1) % ridge.length]! * offset) / 8);
    for (let y = top; y < hills.height; y++) {
      hills.data.set([...(y < top + 3 ? topColor : baseColor), 255], (y * hills.width + x) * 4);
    }
  }
  save("backdrop", "hills", hills);
  return written;
}
