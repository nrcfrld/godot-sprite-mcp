#!/usr/bin/env bun
/**
 * Rebuilds libraries/village from the Blender pipeline so every prop shares the
 * building camera, sun and low-poly style: buildings from assemble.py, trees,
 * shrubs and rocks from render_props.py, plus seamless HD ground tiles and a
 * repeating hill backdrop drawn here. Requires the pinned Blender version.
 *
 *   bun run generate:village [--blender <path>]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createImage, parseHex, readPng, writePng, type Rgb, type RgbaImage } from "../../src/image.ts";
import { blenderExecutable, blenderTimeoutMs } from "./builder.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const PROPS = join(ROOT, "libraries", "village", "assets", "props");

// Library prop id -> assemble.py arguments. Names kept from the earlier procedural village.
const BUILDINGS: Record<string, string[]> = {
  cottage: ["--building", "house"],
  tavern: ["--building", "inn"],
  church: ["--building", "church", "--tower", "right"],
  shop: ["--building", "shop"],
  kegs: ["--building", "kegs"],
};
// Library prop id -> nature.py prop id.
const NATURE: Record<string, string> = {
  oak: "oak",
  autumn_oak: "autumn_oak",
  apple_tree: "apple_tree",
  pine_tree: "pine",
  snowy_pine: "snowy_pine",
  bush: "bush",
  autumn_bush: "autumn_bush",
  rocks: "rocks",
};

async function blender(bin: string, script: string, args: string[]) {
  const proc = Bun.spawn([bin, "--background", "--factory-startup", "--python-exit-code", "1", "--python", join(import.meta.dir, script), "--", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: blenderTimeoutMs(),
    killSignal: "SIGKILL",
  });
  const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  if (proc.signalCode === "SIGKILL") {
    output.catch(() => {});
    throw new Error(`${script} timed out after ${blenderTimeoutMs()} ms`);
  }
  const [out, err] = await output;
  if (code !== 0) throw new Error(`${script} failed (exit ${code}):\n${(err || out).trim().slice(-3000)}`);
}

/** Trims fully transparent margins so the prop's bottom-centre is its ground anchor. */
function trim(img: RgbaImage): RgbaImage {
  let [x0, y0, x1, y1] = [img.width, img.height, -1, -1];
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if (img.data[(y * img.width + x) * 4 + 3]! > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) throw new Error("render is empty");
  const out = createImage(x1 - x0 + 1, y1 - y0 + 1);
  for (let y = 0; y < out.height; y++) {
    const from = ((y0 + y) * img.width + x0) * 4;
    out.data.set(img.data.subarray(from, from + out.width * 4), y * out.width * 4);
  }
  return out;
}

function hash(x: number, y: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Tileable value noise in 0..1 with a `period`-cell lattice and smoothstep interpolation. */
function noise(x: number, y: number, period: number, size: number, seed: number): number {
  const cell = size / period;
  const gx = x / cell;
  const gy = y / cell;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const fx = gx - ix;
  const fy = gy - iy;
  const v = (i: number, j: number) => (hash(((i % period) + period) % period + seed, ((j % period) + period) % period - seed) % 1024) / 1023;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const top = v(ix, iy) * (1 - sx) + v(ix + 1, iy) * sx;
  const bottom = v(ix, iy + 1) * (1 - sx) + v(ix + 1, iy + 1) * sx;
  return top * (1 - sy) + bottom * sy;
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((i) => Math.round(a[i]! + (b[i]! - a[i]!) * t)) as unknown as Rgb;

function grassTile(flowers: boolean): RgbaImage {
  const S = 128;
  const dark = parseHex("#5b8340");
  const light = parseHex("#86ae58");
  const tile = createImage(S, S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const n = noise(x, y, 4, S, 11) * 0.6 + noise(x, y, 16, S, 23) * 0.4;
      const blade = hash(x, y) % 9 === 0 ? 0.08 : 0;
      tile.data.set([...mix(dark, light, Math.min(1, n + blade)), 255], (y * S + x) * 4);
    }
  if (flowers) {
    const petals = [parseHex("#f2d66b"), parseHex("#f4f1e6"), parseHex("#e98aa6")];
    for (let i = 0; i < 14; i++) {
      const cx = hash(i, 7) % S;
      const cy = hash(i, 13) % S;
      const c = petals[i % petals.length]!;
      for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const x = (cx + dx + S) % S;
        const y = (cy + dy + S) % S;
        tile.data.set([...(dx || dy ? c : parseHex("#c98a2e")), 255], (y * S + x) * 4);
      }
    }
  }
  return tile;
}

function hillsBackdrop(): RgbaImage {
  const W = 512;
  const H = 150;
  const top = parseHex("#9cbc84");
  const bottom = parseHex("#6f945e");
  const img = createImage(W, H);
  for (let x = 0; x < W; x++) {
    // Tileable ridge: two octaves of 1-D value noise, period = image width.
    const ridge = 20 + (noise(x, 0, 4, W, 5) * 0.7 + noise(x, 0, 12, W, 9) * 0.3) * 90;
    for (let y = 0; y < H; y++) {
      const coverage = Math.min(1, Math.max(0, y + 1 - ridge)); // anti-aliased skyline
      if (!coverage) continue;
      const shade = mix(top, bottom, Math.min(1, (y - ridge) / (H - ridge)));
      img.data.set([...shade, Math.round(coverage * 255)], (y * W + x) * 4);
    }
  }
  return img;
}

async function main() {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { blender: { type: "string" } } });
  const bin = blenderExecutable(values.blender);
  const work = mkdtempSync(join(tmpdir(), "village-"));
  try {
    for (const [id, args] of Object.entries(BUILDINGS)) {
      await blender(bin, "assemble.py", [...args, "--output", join(work, `${id}.png`)]);
      writePng(join(PROPS, "buildings", `${id}.png`), trim(readPng(join(work, `${id}.png`))));
      console.log(`  buildings/${id}.png`);
    }
    await blender(bin, "render_props.py", ["--output-dir", work, "--props", Object.values(NATURE).join(",")]);
    for (const [id, source] of Object.entries(NATURE)) {
      writePng(join(PROPS, "foliage", `${id}.png`), trim(readPng(join(work, `${source}.png`))));
      console.log(`  foliage/${id}.png`);
    }
    writePng(join(PROPS, "tiles", "grass.png"), grassTile(false));
    writePng(join(PROPS, "tiles", "grass_flowers.png"), grassTile(true));
    writePng(join(PROPS, "backdrop", "hills.png"), hillsBackdrop());
    console.log("  tiles/grass.png, tiles/grass_flowers.png, backdrop/hills.png");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

await main();
