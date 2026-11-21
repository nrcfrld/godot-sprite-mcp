import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PNG } from "pngjs";

/** Straight (non-premultiplied) RGBA8 pixel buffer. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export type Rgb = readonly [number, number, number];

export function createImage(width: number, height: number): RgbaImage {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid image size ${width}x${height}`);
  }
  return { width, height, data: new Uint8Array(width * height * 4) };
}

export function decodePng(buffer: Uint8Array): RgbaImage {
  // pngjs normalises palette, grayscale and 16-bit inputs to RGBA8.
  const png = PNG.sync.read(Buffer.from(buffer));
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
}

export function readPng(path: string): RgbaImage {
  return decodePng(readFileSync(path));
}

/**
 * Encodes with fixed options so identical pixels always produce identical bytes.
 * pngjs writes no timestamp or other volatile chunks.
 */
export function encodePng(image: RgbaImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  return PNG.sync.write(png, {
    colorType: 6,
    bitDepth: 8,
    inputHasAlpha: true,
    deflateLevel: 9,
    deflateStrategy: 3,
    filterType: 0,
  });
}

export function writePng(path: string, image: RgbaImage): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encodePng(image));
}

export function parseHex(hex: string): Rgb {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) throw new Error(`Invalid hex color "${hex}" (expected #RRGGBB)`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export function toHex([r, g, b]: Rgb): string {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

/**
 * Source-over alpha compositing of `src` onto `dst` in place, using integer
 * math only so results are bit-exact across platforms.
 */
export function compositeOver(dst: RgbaImage, src: RgbaImage): void {
  if (dst.width !== src.width || dst.height !== src.height) {
    throw new Error(
      `Layer size mismatch: ${src.width}x${src.height} cannot be composited onto ${dst.width}x${dst.height}`,
    );
  }
  const d = dst.data;
  const s = src.data;
  for (let i = 0; i < d.length; i += 4) {
    const sa = s[i + 3]!;
    if (sa === 0) continue;
    if (sa === 255) {
      d[i] = s[i]!;
      d[i + 1] = s[i + 1]!;
      d[i + 2] = s[i + 2]!;
      d[i + 3] = 255;
      continue;
    }
    const da = d[i + 3]!;
    // All values scaled by 255 to stay in integers.
    const dw = (da * (255 - sa) + 127) / 255 | 0;
    const oa = sa + dw;
    if (oa === 0) continue;
    for (let c = 0; c < 3; c++) {
      d[i + c] = ((s[i + c]! * sa + d[i + c]! * dw + (oa >> 1)) / oa) | 0;
    }
    d[i + 3] = oa;
  }
}
