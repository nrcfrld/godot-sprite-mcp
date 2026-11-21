import type { RgbaImage, Rgb } from "./image.ts";

const key = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b;

/**
 * Indexed palette swap: every opaque-ish pixel whose RGB exactly matches
 * `source[i]` becomes `target[i]`. Alpha is preserved; non-matching pixels
 * (e.g. fixed-color details like eyes) are left untouched. Returns a new image.
 */
export function swapPalette(image: RgbaImage, source: readonly Rgb[], target: readonly Rgb[]): RgbaImage {
  if (source.length !== target.length) {
    throw new Error(`Palette length mismatch: ${source.length} source vs ${target.length} target colors`);
  }
  const lookup = new Map<number, Rgb>();
  source.forEach((c, i) => {
    // First mapping wins if the source ramp repeats a color.
    if (!lookup.has(key(...c))) lookup.set(key(...c), target[i]!);
  });
  const out = new Uint8Array(image.data);
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] === 0) continue;
    const t = lookup.get(key(out[i]!, out[i + 1]!, out[i + 2]!));
    if (t) {
      out[i] = t[0];
      out[i + 1] = t[1];
      out[i + 2] = t[2];
    }
  }
  return { width: image.width, height: image.height, data: out };
}

/** Index of the closest palette color by squared RGB distance; ties go to the lowest index. */
export function nearestColorIndex(palette: readonly Rgb[], r: number, g: number, b: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const c = palette[i]!;
    const dr = r - c[0];
    const dg = g - c[1];
    const db = b - c[2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/**
 * Snaps every pixel to the nearest palette color and binarises alpha
 * (alpha < threshold -> fully transparent black, otherwise opaque).
 * Returns a new image.
 */
export function quantizeToPalette(image: RgbaImage, palette: readonly Rgb[], alphaThreshold = 128): RgbaImage {
  if (palette.length === 0) throw new Error("Palette is empty");
  const out = new Uint8Array(image.data.length);
  const cache = new Map<number, number>();
  const src = image.data;
  for (let i = 0; i < src.length; i += 4) {
    if (src[i + 3]! < alphaThreshold) continue; // stays 0,0,0,0
    const k = key(src[i]!, src[i + 1]!, src[i + 2]!);
    let idx = cache.get(k);
    if (idx === undefined) {
      idx = nearestColorIndex(palette, src[i]!, src[i + 1]!, src[i + 2]!);
      cache.set(k, idx);
    }
    const c = palette[idx]!;
    out[i] = c[0];
    out[i + 1] = c[1];
    out[i + 2] = c[2];
    out[i + 3] = 255;
  }
  return { width: image.width, height: image.height, data: out };
}
