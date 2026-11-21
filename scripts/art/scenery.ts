/**
 * Dummy scenery parts (trees, bushes, ground patches). Frames (64x64, one row)
 * form a wind-sway loop: foliage and its details shift sideways, trunks stay put.
 */
import { parseHex } from "../../src/image.ts";
import { Canvas, hash, type ArtSet } from "./canvas.ts";

const APPLE = parseHex("#d83a2e");
const APPLE_HI = parseHex("#ff9a8a");
const BLOSSOM = [parseHex("#f7a8c8"), parseHex("#fff0f6")];
const BIRD_BODY = parseHex("#3a6ec8");
const BIRD_BELLY = parseHex("#f0e0c0");

// Round canopy geometry, shared by details so they land on the foliage.
const CANOPY = { cx: 32, cy: 22, rx: 20, ry: 17 };
// Integer wobble table for the twisted trunk (no trig, fully reproducible).
const TWIST = [0, 0, 1, 1, 2, 2, 2, 1, 1, 0, 0, -1, -1, -2, -2, -2, -1, -1];

function pose(frame: number) {
  return { sway: [0, 1, 0, -1][frame % 4]! };
}

export const scenery: ArtSet<ReturnType<typeof pose>> = {
  pose,
  parts: {
    ground: {
      grass: (c) => {
        const box = { x: 0, y: 48, w: 64, h: 16 };
        c.shadedMask(Canvas.ellipse(32, 57, 26, 6), box);
        // Grass tufts poking out of the top edge.
        for (let x = 10; x < 54; x += 3 + (hash(x, 1) % 3)) {
          const h = 2 + (hash(x, 2) % 3);
          for (let k = 0; k < h; k++) c.px(x, 53 - k, k === h - 1 ? c.H : c.B);
        }
      },
      dirt: (c) => {
        const box = { x: 0, y: 48, w: 64, h: 16 };
        const mask = Canvas.ellipse(32, 57, 26, 6);
        c.shadedMask(mask, box);
        c.pattern(Canvas.ellipse(32, 57, 23, 4), box, (x, y) => hash(x, y) % 11 === 0, c.S);
        c.pattern(Canvas.ellipse(32, 57, 23, 4), box, (x, y) => hash(x + 9, y) % 17 === 0, c.H);
      },
    },
    trunk: {
      straight: (c) => {
        const box = { x: 22, y: 28, w: 20, h: 32 };
        const mask = (x: number, y: number) =>
          (y >= 30 && y <= 58 && x >= 28 && x < 36) || (y >= 54 && y <= 58 && Math.abs(x + 0.5 - 32) <= 6 - (58 - y));
        c.shadedMask(mask, box);
        c.pattern(mask, box, (x, y) => x % 3 === 0 && hash(x, y >> 2) % 3 !== 0 && y > 31 && y < 56, c.S);
      },
      twisted: (c) => {
        const box = { x: 20, y: 28, w: 24, h: 32 };
        const mask = (x: number, y: number) =>
          y >= 30 && y <= 58 && Math.abs(x + 0.5 - (32 + TWIST[(y - 30) % TWIST.length]!)) <= 4 + (y > 54 ? y - 54 : 0);
        c.shadedMask(mask, box);
        c.pattern(mask, box, (x, y) => (x + y) % 5 === 0 && y > 31 && y < 56, c.S);
      },
    },
    canopy: {
      round: (c, p) => {
        const cx = CANOPY.cx + p.sway;
        const box = { x: cx - 22, y: 2, w: 44, h: 40 };
        const mask = Canvas.ellipse(cx, CANOPY.cy, CANOPY.rx, CANOPY.ry);
        c.shadedMask(mask, box, true);
        // Leaf clumps: texture moves with the sway so the canopy reads as one mass.
        const inner = Canvas.ellipse(cx, CANOPY.cy, CANOPY.rx - 3, CANOPY.ry - 3);
        c.pattern(inner, box, (x, y) => hash(x - p.sway, y) % 9 === 0, c.S);
        c.pattern(inner, box, (x, y) => hash(x - p.sway + 5, y) % 13 === 0 && y < CANOPY.cy, c.H);
      },
      pine: (c, p) => {
        // Bottom tier first so the upper tiers' outlines overlap it.
        const tiers: [number, number, number][] = [[20, 48, 20], [10, 36, 15], [2, 24, 10]];
        tiers.forEach(([top, bottom, half], i) => {
          const cx = 32 + p.sway * (i === 2 ? 1 : i === 1 ? 1 : 0);
          const box = { x: cx - half - 3, y: top, w: half * 2 + 6, h: bottom - top + 1 };
          const mask = Canvas.triangle(cx, top, bottom, half, 1);
          c.shadedMask(mask, box);
          c.pattern(mask, box, (x, y) => (x - cx + y) % 4 === 0 && y > top + 3 && x + 0.5 > cx, c.S);
        });
      },
      bush: (c, p) => {
        const box = { x: 10, y: 34, w: 44, h: 26 };
        const mask = (x: number, y: number) =>
          Canvas.ellipse(32 + p.sway, 46, 18, 10)(x, y) ||
          Canvas.ellipse(22 + p.sway, 50, 10, 7)(x, y) ||
          Canvas.ellipse(43 + p.sway, 50, 10, 7)(x, y);
        c.shadedMask(mask, box, true);
        c.pattern(mask, box, (x, y) => hash(x - p.sway, y) % 10 === 0 && y > 38 && y < 56, c.S);
      },
    },
    detail: {
      apples: (c, p) => {
        const spots = [[-10, -4], [6, -8], [-3, 5], [11, 3], [-12, 8], [2, -12], [8, 10]] as const;
        for (const [dx, dy] of spots) {
          const x = CANOPY.cx + p.sway + dx;
          const y = CANOPY.cy + dy;
          c.disc(x, y, 1.6, APPLE);
          c.px(x - 1, y - 1, APPLE_HI);
        }
      },
      blossoms: (c, p) => {
        const mask = Canvas.ellipse(CANOPY.cx + p.sway, CANOPY.cy, CANOPY.rx - 2, CANOPY.ry - 2);
        const box = { x: 8, y: 4, w: 48, h: 36 };
        c.pattern(mask, box, (x, y) => hash(x - p.sway, y + 101) % 23 === 0, BLOSSOM[0]!);
        c.pattern(mask, box, (x, y) => hash(x - p.sway, y + 202) % 41 === 0, BLOSSOM[1]!);
      },
      bird: (c, p) => {
        // Hops along the top of the canopy across the loop.
        const x = 36 + p.sway + [0, 0, 1, 1][(p.sway + 4) % 4]!;
        const y = 4 - (p.sway === 1 ? 1 : 0);
        c.disc(x, y + 1, 2.5, BIRD_BODY);
        c.disc(x + 1, y + 2, 1.2, BIRD_BELLY);
        c.px(x + 3, y + 1, parseHex("#f0a020"));
        c.px(x + 1, y, parseHex("#101010"));
      },
    },
  },
};
