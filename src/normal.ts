import { createImage, type RgbaImage } from "./image.ts";
import { luma } from "./palette.ts";

export interface NormalMapOptions {
  /** Frame size; height is computed per frame so neighbouring frames never bleed into each other. */
  frameWidth: number;
  frameHeight: number;
  /** Bevel width in pixels: how far from the silhouette edge the surface keeps rising. Default: ~1/16 of the frame. */
  bevel?: number;
  /** Slope multiplier; higher = more pronounced lighting. Default 2. */
  strength?: number;
  /** 0..1 share of the height taken from pixel luminance (surface detail) vs. silhouette bevel. Default 0.35. */
  detail?: number;
}

/**
 * Derives a tangent-space normal map (Godot / OpenGL convention, green = up) from a
 * sprite sheet so 2D lights can shade it: a bevelled height field from each frame's
 * silhouette plus luminance detail, differentiated with central differences.
 * Deterministic: only IEEE-exact arithmetic (+ - * / sqrt) and fixed rounding.
 */
export function generateNormalMap(image: RgbaImage, opts: NormalMapOptions): RgbaImage {
  const { width: W, height: H, data } = image;
  const { frameWidth: FW, frameHeight: FH } = opts;
  const bevel = opts.bevel ?? Math.max(2, Math.round(Math.min(FW, FH) / 16));
  const strength = opts.strength ?? 2;
  const detail = opts.detail ?? 0.35;

  // Chamfer (3-4) distance to the nearest transparent pixel or frame edge, per frame.
  const INF = 1 << 20;
  const dist = new Int32Array(W * H);
  const solid = (x: number, y: number) => data[(y * W + x) * 4 + 3]! >= 128;
  for (let i = 0; i < W * H; i++) dist[i] = solid(i % W, (i / W) | 0) ? INF : 0;
  const at = (x: number, y: number, fx: number, fy: number) =>
    x < fx || y < fy || x >= fx + FW || y >= fy + FH ? 0 : dist[y * W + x]!;
  for (let fy = 0; fy < H; fy += FH) {
    for (let fx = 0; fx < W; fx += FW) {
      for (let y = fy; y < Math.min(fy + FH, H); y++)
        for (let x = fx; x < Math.min(fx + FW, W); x++) {
          const i = y * W + x;
          if (!dist[i]) continue;
          dist[i] = Math.min(dist[i]!, at(x - 1, y, fx, fy) + 3, at(x, y - 1, fx, fy) + 3, at(x - 1, y - 1, fx, fy) + 4, at(x + 1, y - 1, fx, fy) + 4);
        }
      for (let y = Math.min(fy + FH, H) - 1; y >= fy; y--)
        for (let x = Math.min(fx + FW, W) - 1; x >= fx; x--) {
          const i = y * W + x;
          if (!dist[i]) continue;
          dist[i] = Math.min(dist[i]!, at(x + 1, y, fx, fy) + 3, at(x, y + 1, fx, fy) + 3, at(x + 1, y + 1, fx, fy) + 4, at(x - 1, y + 1, fx, fy) + 4);
        }
    }
  }

  const height = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const a = data[i * 4 + 3]!;
    if (!a) continue;
    const shape = Math.min(dist[i]! / 3, bevel) / bevel;
    const lum = luma(data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!) / 255;
    height[i] = (shape * (1 - detail) + lum * detail) * (a / 255);
  }

  const out = createImage(W, H);
  const h = (x: number, y: number, fx: number, fy: number) =>
    x < fx || y < fy || x >= fx + FW || y >= fy + FH ? 0 : height[y * W + x]!;
  for (let y = 0; y < H; y++) {
    const fy = y - (y % FH);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const o = i * 4;
      const a = data[o + 3]!;
      if (!a) {
        out.data.set([128, 128, 255, 0], o);
        continue;
      }
      const fx = x - (x % FW);
      const dx = (h(x + 1, y, fx, fy) - h(x - 1, y, fx, fy)) * strength;
      const dy = (h(x, y + 1, fx, fy) - h(x, y - 1, fx, fy)) * strength;
      // Image y grows downward; normal-map green points up.
      const nx = -dx;
      const ny = dy;
      const len = Math.sqrt(nx * nx + ny * ny + 1);
      out.data[o] = Math.round(((nx / len + 1) * 255) / 2);
      out.data[o + 1] = Math.round(((ny / len + 1) * 255) / 2);
      out.data[o + 2] = Math.round(((1 / len + 1) * 255) / 2);
      out.data[o + 3] = a;
    }
  }
  return out;
}
