import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createImage, type RgbaImage } from "../../src/image.ts";

export const ROOT = resolve(import.meta.dir, "..", "..");
/** Raw pack downloads live here (git-ignored); only processed libraries are committed. */
export const CACHE = join(ROOT, ".cache", "packs");

export async function download(url: string, dest: string): Promise<string> {
  if (existsSync(dest)) return dest;
  mkdirSync(dirname(dest), { recursive: true });
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  await Bun.write(dest + ".part", res);
  await Bun.$`mv ${dest + ".part"} ${dest}`.quiet();
  return dest;
}

export async function downloadText(url: string, dest: string): Promise<string> {
  await download(url, dest);
  return Bun.file(dest).text();
}

/** Recreates a library's parts folder so stale parts never survive a re-import. */
export function resetDir(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

export function writeJson(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

/**
 * Crops `src` at (x, y, size*factor) and box-filters it down by an integer factor,
 * averaging in premultiplied alpha so edges stay clean. Integer math only.
 */
export function cropDownscale(src: RgbaImage, x0: number, y0: number, outW: number, outH: number, factor: number): RgbaImage {
  const out = createImage(outW, outH);
  const n = factor * factor;
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let a = 0, r = 0, g = 0, b = 0;
      for (let j = 0; j < factor; j++) {
        const sy = y0 + y * factor + j;
        if (sy < 0 || sy >= src.height) continue;
        for (let i = 0; i < factor; i++) {
          const sx = x0 + x * factor + i;
          if (sx < 0 || sx >= src.width) continue;
          const si = (sy * src.width + sx) * 4;
          const sa = src.data[si + 3]!;
          a += sa;
          r += src.data[si]! * sa;
          g += src.data[si + 1]! * sa;
          b += src.data[si + 2]! * sa;
        }
      }
      if (!a) continue;
      const o = (y * outW + x) * 4;
      out.data[o] = ((r + (a >> 1)) / a) | 0;
      out.data[o + 1] = ((g + (a >> 1)) / a) | 0;
      out.data[o + 2] = ((b + (a >> 1)) / a) | 0;
      out.data[o + 3] = ((a + (n >> 1)) / n) | 0;
    }
  }
  return out;
}

/** Copies `src` into `dst` at (dx, dy) (no blending). */
export function blit(dst: RgbaImage, src: RgbaImage, dx: number, dy: number, sx = 0, sy = 0, w = src.width, h = src.height) {
  for (let y = 0; y < h; y++) {
    const from = ((sy + y) * src.width + sx) * 4;
    dst.data.set(src.data.subarray(from, from + w * 4), ((dy + y) * dst.width + dx) * 4);
  }
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  area: number;
}

/**
 * Finds the separate objects on an atlas sheet: 8-connected groups of visible
 * pixels, sorted top-to-bottom then left-to-right (deterministic order).
 */
export function findObjects(img: RgbaImage, minArea = 24): Box[] {
  const { width: W, height: H, data } = img;
  const seen = new Uint8Array(W * H);
  const boxes: Box[] = [];
  const stack: number[] = [];
  for (let start = 0; start < W * H; start++) {
    if (seen[start] || data[start * 4 + 3]! === 0) continue;
    let [x0, y0, x1, y1, area] = [W, H, -1, -1, 0];
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % W;
      const y = (i / W) | 0;
      area++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (!seen[j] && data[j * 4 + 3]! !== 0) {
            seen[j] = 1;
            stack.push(j);
          }
        }
    }
    if (area >= minArea) boxes.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, area });
  }
  return boxes.sort((a, b) => a.y - b.y || a.x - b.x);
}

export function crop(img: RgbaImage, b: { x: number; y: number; w: number; h: number }): RgbaImage {
  const out = createImage(b.w, b.h);
  blit(out, img, 0, 0, b.x, b.y, b.w, b.h);
  return out;
}
