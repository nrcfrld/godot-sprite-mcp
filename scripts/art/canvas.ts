import { join } from "node:path";
import { DEFAULT_FAMILY, type AssetLibrary } from "../../src/config.ts";
import { createImage, writePng, type Rgb, type RgbaImage } from "../../src/image.ts";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Mask = (x: number, y: number) => boolean;

/** Integer hash for deterministic texture noise (no Math.random). */
export function hash(x: number, y: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Frame-local drawing surface over a full sprite sheet. Shapes are painted with
 * the library's 4 source-ramp key colors (O/S/B/H) so they can be palette-swapped;
 * any other color passed in is a fixed detail color.
 */
export class Canvas {
  readonly img: RgbaImage;
  readonly fw: number;
  readonly fh: number;
  readonly O: Rgb;
  readonly S: Rgb;
  readonly B: Rgb;
  readonly H: Rgb;
  private ox = 0;
  private oy = 0;

  constructor(private readonly lib: AssetLibrary) {
    this.fw = lib.manifest.frameWidth;
    this.fh = lib.manifest.frameHeight;
    this.img = createImage(lib.sheetWidth, lib.sheetHeight);
    [this.O, this.S, this.B, this.H] = lib.families[DEFAULT_FAMILY]!.source as [Rgb, Rgb, Rgb, Rgb];
  }

  frame(i: number) {
    this.ox = (i % this.lib.manifest.columns) * this.fw;
    this.oy = Math.floor(i / this.lib.manifest.columns) * this.fh;
  }

  px(x: number, y: number, c: Rgb, a = 255) {
    if (x < 0 || y < 0 || x >= this.fw || y >= this.fh) return;
    this.img.data.set([c[0], c[1], c[2], a], ((this.oy + y) * this.img.width + this.ox + x) * 4);
  }

  fill({ x, y, w, h }: Rect, c: Rgb) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.px(x + i, y + j, c);
  }

  /** Outlined block: highlight on top/left, shadow on bottom/right. */
  shaded(r: Rect) {
    this.fill(r, this.O);
    if (r.w < 3 || r.h < 3) return;
    const inner = { x: r.x + 1, y: r.y + 1, w: r.w - 2, h: r.h - 2 };
    this.fill(inner, this.B);
    this.fill({ ...inner, h: 1 }, this.H);
    this.fill({ ...inner, w: 1 }, this.H);
    this.fill({ x: inner.x + inner.w - 1, y: inner.y + 1, w: 1, h: inner.h - 1 }, this.S);
    this.fill({ x: inner.x + 1, y: inner.y + inner.h - 1, w: inner.w - 1, h: 1 }, this.S);
  }

  /**
   * Shades an arbitrary shape: outline on its border, a highlight rim on the
   * top/left inside edge and a shadow rim on the bottom/right. With `volume`,
   * the interior also gets a diagonal light-to-dark gradient (for round forms).
   */
  shadedMask(mask: Mask, box: Rect, volume = false) {
    const inside = (x: number, y: number) => mask(x, y);
    const edge = (x: number, y: number) =>
      inside(x, y) && !(inside(x - 1, y) && inside(x + 1, y) && inside(x, y - 1) && inside(x, y + 1));
    for (let y = box.y; y < box.y + box.h; y++) {
      for (let x = box.x; x < box.x + box.w; x++) {
        if (!inside(x, y)) continue;
        if (edge(x, y)) this.px(x, y, this.O);
        else if (edge(x - 1, y) || edge(x, y - 1)) this.px(x, y, this.H);
        else if (edge(x + 1, y) || edge(x, y + 1)) this.px(x, y, this.S);
        else if (volume) {
          const t = (x - box.x) / box.w + (y - box.y) / box.h; // 0 (top-left) .. 2 (bottom-right)
          this.px(x, y, t < 0.6 ? this.H : t > 1.25 ? this.S : this.B);
        } else this.px(x, y, this.B);
      }
    }
  }

  static ellipse(cx: number, cy: number, rx: number, ry: number): Mask {
    return (x, y) => ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1;
  }

  /** Isosceles triangle pointing up, apex at (cx, top), base half-width `half` at `bottom`. */
  static triangle(cx: number, top: number, bottom: number, half: number, minHalf = 0): Mask {
    return (x, y) => y >= top && y <= bottom && Math.abs(x + 0.5 - cx) <= minHalf + ((y - top) / (bottom - top)) * half;
  }

  /** Paints `c` on every pixel of `box` that satisfies both `mask` and `pattern`. */
  pattern(mask: Mask, box: Rect, pattern: (x: number, y: number) => boolean, c: Rgb) {
    for (let y = box.y; y < box.y + box.h; y++)
      for (let x = box.x; x < box.x + box.w; x++) if (mask(x, y) && pattern(x, y)) this.px(x, y, c);
  }

  /** Filled disc in fixed colors (used for smoke, fruit, lights). */
  disc(cx: number, cy: number, r: number, c: Rgb, a = 255) {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++)
        if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) this.px(x, y, c, a);
  }
}

export type Painter<P> = (c: Canvas, pose: P, frame: number) => void;

export interface ArtSet<P> {
  pose: (frame: number) => P;
  /** layer id -> part id -> painter */
  parts: Record<string, Record<string, Painter<P>>>;
}

/** Renders every part of an art set into the library's parts folders. */
export function renderArtSet<P>(lib: AssetLibrary, art: ArtSet<P>): string[] {
  const written: string[] = [];
  for (const layer of lib.layers) {
    for (const [partId, paint] of Object.entries(art.parts[layer.id] ?? {})) {
      const canvas = new Canvas(lib);
      for (let f = 0; f < lib.manifest.frameCount; f++) {
        canvas.frame(f);
        paint(canvas, art.pose(f), f);
      }
      const out = join(lib.partsDir, layer.folder, `${partId}.png`);
      writePng(out, canvas.img);
      written.push(out);
    }
  }
  return written;
}
