#!/usr/bin/env bun
/**
 * Regenerates the example outputs shown in README.md (docs/examples/). Every image comes
 * from the same calls an MCP client makes, so the README stays honest:
 *
 *   bun run examples
 *
 * Animated previews are APNG (animated PNG), which GitHub renders inline.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { openLibrary } from "../src/config.ts";
import { createImage, readPng, writePng, type RgbaImage } from "../src/image.ts";
import { composeScene, openPropsLibrary } from "../src/scene.ts";
import { composeCharacterSprite } from "../src/sprite.ts";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, "docs", "examples");

// ---------------------------------------------------------------- APNG encoder

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Animated PNG with every frame full-size; `fps` sets each frame's delay. Loops forever. */
function encodeApng(frames: RgbaImage[], fps: number): Buffer {
  const { width: W, height: H } = frames[0]!;
  const u32 = (...values: number[]) => {
    const b = Buffer.alloc(values.length * 4);
    values.forEach((v, i) => b.writeUInt32BE(v, i * 4));
    return b;
  };
  const ihdr = Buffer.concat([u32(W, H), Buffer.from([8, 6, 0, 0, 0])]);
  const parts: Buffer[] = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("acTL", u32(frames.length, 0))];
  let seq = 0;
  frames.forEach((frame, i) => {
    const fctl = Buffer.alloc(26);
    fctl.writeUInt32BE(seq++, 0);
    fctl.writeUInt32BE(W, 4);
    fctl.writeUInt32BE(H, 8);
    fctl.writeUInt32BE(0, 12);
    fctl.writeUInt32BE(0, 16);
    fctl.writeUInt16BE(1, 20); // delay = 1 / fps seconds
    fctl.writeUInt16BE(fps, 22);
    fctl[24] = 0; // dispose: none (every frame is full-size and opaque)
    fctl[25] = 0; // blend: source
    parts.push(chunk("fcTL", fctl));
    const raw = Buffer.alloc((W * 4 + 1) * H);
    for (let y = 0; y < H; y++) Buffer.from(frame.data.buffer, frame.data.byteOffset + y * W * 4, W * 4).copy(raw, y * (W * 4 + 1) + 1);
    const data = deflateSync(raw, { level: 9 });
    if (i === 0) parts.push(chunk("IDAT", data));
    else parts.push(chunk("fdAT", Buffer.concat([u32(seq++), data])));
  });
  parts.push(chunk("IEND", new Uint8Array()));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- frame helpers

const BACKDROP = [36, 40, 48] as const;

/** Copies one sheet cell into `dst` at (dx, dy), scaled by an integer factor (nearest), over an opaque backdrop. */
function blitCell(dst: RgbaImage, sheet: RgbaImage, sx: number, sy: number, w: number, h: number, dx: number, dy: number, scale: number) {
  for (let y = 0; y < h * scale; y++)
    for (let x = 0; x < w * scale; x++) {
      const si = ((sy + Math.floor(y / scale)) * sheet.width + sx + Math.floor(x / scale)) * 4;
      const di = ((dy + y) * dst.width + dx + x) * 4;
      const a = sheet.data[si + 3]!;
      for (let c = 0; c < 3; c++) dst.data[di + c] = Math.round((sheet.data[si + c]! * a + dst.data[di + c]! * (255 - a)) / 255);
    }
}

function canvas(w: number, h: number): RgbaImage {
  const img = createImage(w, h);
  for (let i = 0; i < img.data.length; i += 4) img.data.set([...BACKDROP, 255], i);
  return img;
}

/** One animated strip: the same animation in several directions (or several sheets) side by side. */
function strip(sheets: RgbaImage[], rows: number[], frames: number, cell: { w: number; h: number; columns: number }, scale: number, pad = 8) {
  const columns = sheets.length * rows.length;
  const W = columns * (cell.w * scale + pad) + pad;
  const H = cell.h * scale + pad * 2;
  return Array.from({ length: frames }, (_, f) => {
    const img = canvas(W, H);
    let col = 0;
    for (const sheet of sheets)
      for (const row of rows) {
        blitCell(img, sheet, f * cell.w, row * cell.h, cell.w, cell.h, pad + col * (cell.w * scale + pad), pad, scale);
        col++;
      }
    return img;
  });
}

// ---------------------------------------------------------------- examples

const KNIGHT = {
  library: "lpc_male",
  name: "knight",
  parts: {
    torso: "longsleeve", legs: "pants", feet_armour: "plate_boots", torso_armour: "plate",
    shoulders: "bauldron", gloves: "gloves", helmet: "greathelm",
  },
  palettes: {
    torso: "navy", legs: "charcoal", torso_armour: "steel", feet_armour: "steel",
    gloves: "iron", helmet: "steel", shoulders: "maroon",
  },
};

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const lpc = openLibrary(ROOT, "lpc_male");
  const cell = { w: 64, h: 64, columns: lpc.manifest.columns };
  const row = (name: string) => Math.floor(lpc.manifest.animations.find((a) => a.name === name)!.frames[0]! / lpc.manifest.columns);
  const frameCount = (name: string) => lpc.manifest.animations.find((a) => a.name === name)!.frames.length;
  const DIRS = ["down", "left", "right", "up"];

  // 1. Knight: full sprite sheet + SpriteFrames + normal map + credits, exactly as the tool writes them.
  const { library, ...knightArgs } = KNIGHT;
  const knight = composeCharacterSprite(openLibrary(ROOT, library), { ...knightArgs, outputDir: join(OUT, "knight"), normalMap: true });
  const sheet = readPng(knight.pngPath);
  for (const anim of ["walk", "run"]) {
    const rows = DIRS.map((d) => row(`${anim}_${d}`));
    writeFileSync(join(OUT, `knight-${anim}.png`), encodeApng(strip([sheet], rows, frameCount(`${anim}_down`), cell, 3), anim === "run" ? 12 : 10));
  }
  writeFileSync(join(OUT, "knight-idle.png"), encodeApng(strip([sheet], DIRS.map((d) => row(`idle_${d}`)), frameCount("idle_down"), cell, 3), 3));

  // 2. Palette variants: same parts, different metal/cloth palettes (no new art).
  const variants = [
    { helmet: "gold", torso_armour: "gold", feet_armour: "gold", shoulders: "white", torso: "white" },
    { helmet: "copper", torso_armour: "copper", feet_armour: "copper", shoulders: "forest", torso: "forest" },
    { helmet: "iron", torso_armour: "iron", feet_armour: "iron", shoulders: "black", torso: "charcoal" },
  ].map((palettes, i) =>
    readPng(composeCharacterSprite(lpc, { name: `knight_v${i}`, parts: KNIGHT.parts, palettes: { ...KNIGHT.palettes, ...palettes }, outputDir: join(OUT, "variants") }).pngPath),
  );
  writeFileSync(join(OUT, "knight-variants.png"), encodeApng(strip([sheet, ...variants], [row("walk_down")], frameCount("walk_down"), cell, 3), 10));
  rmSync(join(OUT, "variants"), { recursive: true, force: true });

  // 3. Normal map next to the sprite (one frame), for 2D lighting in Godot.
  const normal = readPng(knight.normalPath!);
  const pair = canvas(2 * 64 * 4 + 24, 64 * 4 + 16);
  blitCell(pair, sheet, 0, row("walk_down") * 64, 64, 64, 8, 8, 4);
  blitCell(pair, normal, 0, row("walk_down") * 64, 64, 64, 64 * 4 + 16, 8, 4);
  writePng(join(OUT, "knight-normal.png"), pair);

  // 4. HD 2D creature (gradient-map recolor of CC0 vector parts).
  const hd = openLibrary(ROOT, "hd_creatures");
  const imp = composeCharacterSprite(hd, {
    name: "imp",
    parts: { hair: "hair3", horns: "horn1", wing_back: "wing1", wing_front: "wing1", eyes: "eyes2", mouth: "mouth5" },
    palettes: { body: "demon", horns: "obsidian", wing_back: "bat", hair: "black" },
    outputDir: join(OUT, "imp"),
  });
  const impSheet = readPng(imp.pngPath);
  const impCell = { w: hd.manifest.frameWidth, h: hd.manifest.frameHeight, columns: hd.manifest.columns };
  const walk = hd.manifest.animations.find((a) => a.name === "walk")!;
  const impFrames = walk.frames.map((f) => {
    const img = canvas(impCell.w + 16, impCell.h + 16);
    blitCell(img, impSheet, (f % impCell.columns) * impCell.w, Math.floor(f / impCell.columns) * impCell.h, impCell.w, impCell.h, 8, 8, 1);
    return img;
  });
  writeFileSync(join(OUT, "imp-walk.png"), encodeApng(impFrames, walk.fps));
  rmSync(join(OUT, "imp"), { recursive: true, force: true });

  // 5. Scene composition from the village props library.
  const scene = composeScene(openPropsLibrary(ROOT, "village"), {
    name: "village_square", outputDir: join(OUT, "scene"), width: 1280, height: 720,
    sky: { top: "#8fc3e8", bottom: "#dcefd8" },
    ground: { tiles: ["grass", "grass_flowers"], weights: [4, 1], y: 170 },
    layers: [{ prop: "hills", y: 200, x: 0, repeat: "x" }],
    placements: [
      { prop: "church", x: 330, y: 470 }, { prop: "tavern", x: 760, y: 560 }, { prop: "cottage", x: 1110, y: 430 },
      { prop: "pine_tree", x: 70, y: 330 }, { prop: "pine_tree", x: 150, y: 300 }, { prop: "apple_tree", x: 150, y: 660, flip: true },
      { prop: "autumn_oak", x: 1210, y: 600 }, { prop: "oak", x: 1010, y: 640 }, { prop: "bush", x: 480, y: 610 },
      { prop: "rocks", x: 260, y: 690 }, { prop: "snowy_pine", x: 1240, y: 300 },
    ],
  });
  writePng(join(OUT, "village-scene.png"), readPng(scene.pngPath));
  rmSync(join(OUT, "scene"), { recursive: true, force: true });

  console.log(`examples written to ${OUT}`);
}

await main();
