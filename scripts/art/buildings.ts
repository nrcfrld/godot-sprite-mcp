/**
 * Dummy building parts. Frames (96x96, one row) form an idle loop: chimney smoke
 * rises, the lantern flickers, the window glint slides and the sign swings.
 */
import { parseHex } from "../../src/image.ts";
import { Canvas, hash, type ArtSet } from "./canvas.ts";

const GLASS = parseHex("#6ec6f0");
const GLASS_HI = parseHex("#d8f4ff");
const BRASS = parseHex("#ffd040");
const SMOKE = parseHex("#eeeef4");
const SMOKE_EDGE = parseHex("#b8b8c8");
const FLAME = [parseHex("#ffd060"), parseHex("#fff0a0"), parseHex("#ffe080"), parseHex("#ffc040")];
const PETALS = [parseHex("#f070a0"), parseHex("#ffd84a"), parseHex("#ffffff")];
const LEAF = parseHex("#4ea040");

// Shared footprint so every walls/roof/door/window combination lines up.
const WALL = { x: 16, y: 44, w: 64, h: 42 };
const WIN_L = { x: 22, y: 54, w: 14, h: 12 };
const WIN_R = { x: 60, y: 54, w: 14, h: 12 };
const DOOR = { x: 41, y: 62, w: 14, h: 24 };

function pose(frame: number) {
  return { frame, sway: [0, 1, 0, -1][frame % 4]! };
}

const inRect = (r: { x: number; y: number; w: number; h: number }) => (x: number, y: number) =>
  x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

/** Interior of a rect (excludes the 1px outline). */
const interior = (r: { x: number; y: number; w: number; h: number }) =>
  inRect({ x: r.x + 1, y: r.y + 1, w: r.w - 2, h: r.h - 2 });

function brickTexture(c: Canvas, r: { x: number; y: number; w: number; h: number }, course = 4, len = 8) {
  c.pattern(interior(r), r, (x, y) => {
    const row = Math.floor((y - r.y - 1) / course);
    return (y - r.y - 1) % course === course - 1 || (x - r.x + (row % 2) * (len / 2)) % len === 0;
  }, c.S);
}

function windowGlass(c: Canvas, mask: (x: number, y: number) => boolean, box: { x: number; y: number; w: number; h: number }, frame: number) {
  c.pattern(mask, box, () => true, GLASS);
  // A diagonal glint sweeps across the pane over the loop.
  c.pattern(mask, box, (x, y) => (x - box.x + (y - box.y) - frame * 3 + 40) % 14 < 2, GLASS_HI);
}

function smoke(c: Canvas, x0: number, y0: number, frame: number) {
  for (let i = 0; i < 3; i++) {
    // Puffs drift up and downwind (right), growing as they go; the frame edge clips them.
    const t = (frame * 2 + i * 8) % 24;
    const r = 1.5 + t / 8;
    const cx = x0 + Math.floor((t * 3) / 4);
    const cy = y0 - Math.floor(t / 3);
    c.disc(cx, cy, r + 1, SMOKE_EDGE, 220);
    c.disc(cx, cy, r, SMOKE, 235);
  }
}

export const buildings: ArtSet<ReturnType<typeof pose>> = {
  pose,
  parts: {
    ground: {
      cobble: (c) => {
        const r = { x: 4, y: 82, w: 88, h: 10 };
        c.shaded(r);
        brickTexture(c, r, 3, 6);
      },
      grass_lot: (c) => {
        const box = { x: 0, y: 78, w: 96, h: 18 };
        c.shadedMask(Canvas.ellipse(48, 87, 47, 8), box);
        c.pattern(Canvas.ellipse(48, 87, 44, 6), box, (x, y) => hash(x, y) % 9 === 0, c.H);
        c.pattern(Canvas.ellipse(48, 87, 44, 6), box, (x, y) => hash(x + 3, y) % 13 === 0, c.S);
      },
    },
    walls: {
      plaster: (c) => {
        c.shaded(WALL);
        c.pattern(interior(WALL), WALL, (x, y) => hash(x, y) % 31 === 0, c.S);
        // Timber framing.
        for (const y of [WALL.y + 1, WALL.y + 19]) c.fill({ x: WALL.x + 1, y, w: WALL.w - 2, h: 2 }, c.O);
        for (const x of [WALL.x + 1, WALL.x + 38, WALL.x + WALL.w - 3]) c.fill({ x, y: WALL.y + 1, w: 2, h: WALL.h - 2 }, c.O);
      },
      brick: (c) => {
        c.shaded(WALL);
        brickTexture(c, WALL);
      },
      log: (c) => {
        c.shaded(WALL);
        c.pattern(interior(WALL), WALL, (_, y) => (y - WALL.y - 1) % 6 === 0, c.H);
        c.pattern(interior(WALL), WALL, (_, y) => (y - WALL.y - 1) % 6 === 4, c.S);
        c.pattern(interior(WALL), WALL, (_, y) => (y - WALL.y - 1) % 6 === 5, c.O);
        // Log ends sticking out at the corners.
        for (let y = WALL.y + 1; y < WALL.y + WALL.h - 2; y += 6) {
          c.shaded({ x: WALL.x - 3, y, w: 5, h: 6 });
          c.shaded({ x: WALL.x + WALL.w - 2, y, w: 5, h: 6 });
        }
      },
    },
    roof: {
      gable: (c) => {
        const box = { x: 8, y: 12, w: 80, h: 38 };
        const mask = Canvas.triangle(48, 14, 48, 37, 1);
        c.shadedMask(mask, box);
        // Shingle rows, staggered.
        c.pattern(mask, box, (x, y) => {
          const row = Math.floor((y - 14) / 4);
          return (y - 14) % 4 === 3 || ((y - 14) % 4 !== 0 && (x + (row % 2) * 3) % 6 === 0);
        }, c.S);
        c.pattern(mask, box, (_, y) => (y - 14) % 4 === 0 && y > 16, c.H);
      },
      steep: (c) => {
        const box = { x: 8, y: 2, w: 80, h: 48 };
        const mask = Canvas.triangle(48, 4, 48, 37, 1);
        c.shadedMask(mask, box);
        // Clay tile columns with scalloped rows.
        c.pattern(mask, box, (x, y) => x % 5 === 0 || ((y - 4) % 6 === 5 && x % 5 !== 2), c.S);
        c.pattern(mask, box, (x, y) => x % 5 === 1 && (y - 4) % 6 < 2, c.H);
      },
    },
    chimney: {
      brick: (c, p) => {
        const stack = { x: 62, y: 16, w: 10, h: 18 };
        c.shaded(stack);
        brickTexture(c, stack, 3, 4);
        c.shaded({ x: 60, y: 13, w: 14, h: 4 });
        smoke(c, 65, 10, p.frame);
      },
      pipe: (c, p) => {
        c.shaded({ x: 64, y: 14, w: 6, h: 22 });
        c.shaded({ x: 62, y: 11, w: 10, h: 4 });
        smoke(c, 65, 8, p.frame);
      },
    },
    door: {
      plank: (c) => {
        c.shaded(DOOR);
        c.pattern(interior(DOOR), DOOR, (x) => (x - DOOR.x) % 4 === 0, c.S);
        c.fill({ x: DOOR.x + 1, y: DOOR.y + 7, w: DOOR.w - 2, h: 1 }, c.O);
        c.fill({ x: DOOR.x + 10, y: DOOR.y + 12, w: 2, h: 2 }, BRASS);
      },
      arched: (c) => {
        const box = { x: 39, y: 56, w: 18, h: 30 };
        const mask = (x: number, y: number) =>
          (x >= 40 && x < 56 && y >= 64 && y < 86) || Canvas.ellipse(48, 64, 8, 8)(x, y);
        c.shadedMask(mask, box);
        c.pattern(mask, box, (x, y) => x % 4 === 0 && y > 58, c.S);
        c.fill({ x: 52, y: 74, w: 2, h: 2 }, BRASS);
      },
    },
    windows: {
      square: (c, p) => {
        for (const w of [WIN_L, WIN_R]) {
          c.shaded(w);
          const pane = { x: w.x + 2, y: w.y + 2, w: w.w - 4, h: w.h - 4 };
          windowGlass(c, inRect(pane), pane, p.frame);
          c.fill({ x: w.x + w.w / 2 - 1, y: w.y + 1, w: 2, h: w.h - 2 }, c.B); // mullion
          c.fill({ x: w.x + 1, y: w.y + w.h / 2 - 1, w: w.w - 2, h: 1 }, c.B); // transom
        }
      },
      round: (c, p) => {
        for (const w of [WIN_L, WIN_R]) {
          const cx = w.x + w.w / 2;
          const cy = w.y + w.h / 2;
          c.shadedMask(Canvas.ellipse(cx, cy, 7, 7), { x: w.x - 1, y: w.y - 2, w: w.w + 2, h: w.h + 4 });
          windowGlass(c, Canvas.ellipse(cx, cy, 4.6, 4.6), { x: w.x, y: w.y - 1, w: w.w, h: w.h + 2 }, p.frame);
          c.fill({ x: cx - 1, y: cy - 5, w: 2, h: 10 }, c.B);
        }
      },
    },
    decor: {
      flower_boxes: (c) => {
        for (const w of [WIN_L, WIN_R]) {
          const box = { x: w.x - 1, y: w.y + w.h + 1, w: w.w + 2, h: 4 };
          for (let x = box.x + 1; x < box.x + box.w - 1; x++) {
            const h = 1 + (hash(x, 7) % 3);
            for (let k = 1; k <= h; k++) c.px(x, box.y - k, LEAF);
            if (hash(x, 11) % 3 === 0) c.px(x, box.y - h - 1, PETALS[hash(x, 5) % 3]!);
          }
          c.shaded(box);
        }
      },
      sign: (c, p) => {
        c.fill({ x: 78, y: 50, w: 11, h: 2 }, c.O); // bracket
        const s = p.sway;
        c.px(82 + s, 52, c.O);
        c.px(87 + s, 52, c.O);
        const board = { x: 80 + s, y: 53, w: 11, h: 10 };
        c.shaded(board);
        c.disc(board.x + 5.5, board.y + 5, 2.5, BRASS); // coin emblem
      },
      lantern: (c, p) => {
        c.fill({ x: 37, y: 63, w: 3, h: 1 }, c.O);
        const body = { x: 35, y: 64, w: 5, h: 8 };
        c.shaded(body);
        c.fill({ x: 36, y: 66, w: 3, h: 4 }, FLAME[p.frame % 4]!);
        c.px(37, 67, parseHex("#ffffff"));
      },
    },
  },
};
