/**
 * Dummy character parts. Frames (48x48, one row): 0 idle, 1 idle bob, 2 walk step,
 * 3 action (arm raised).
 */
import { parseHex } from "../../src/image.ts";
import type { ArtSet } from "./canvas.ts";

// Fixed detail colors: deliberately outside the source ramp so they are never swapped.
const EYE_WHITE = parseHex("#ffffff");
const PUPIL = parseHex("#1a1a40");
const LENS = parseHex("#9ad8ff");

/** Character skeleton for a given frame. */
function pose(frame: number) {
  const bob = frame === 1 ? 1 : 0;
  const step = frame === 2;
  const action = frame === 3;
  return {
    head: { x: 17, y: 6 + bob, w: 14, h: 14 },
    torso: { x: 16, y: 20 + bob, w: 16, h: 12 },
    armL: { x: 12, y: 21 + bob, w: 5, h: 11 },
    armR: action ? { x: 31, y: 9, w: 5, h: 13 } : { x: 31, y: 21 + bob, w: 5, h: 11 },
    legL: step ? { x: 15, y: 31, w: 7, h: 12 } : { x: 17, y: 31, w: 7, h: 13 },
    legR: step ? { x: 26, y: 31, w: 7, h: 13 } : { x: 24, y: 31, w: 7, h: 13 },
    bob,
  };
}

export const characters: ArtSet<ReturnType<typeof pose>> = {
  pose,
  parts: {
    body: {
      base: (c, p) => {
        for (const r of [p.legL, p.legR, p.armL, p.armR, p.torso, p.head]) c.shaded(r);
        const ey = p.head.y + 7;
        for (const ex of [p.head.x + 3, p.head.x + 8]) {
          c.fill({ x: ex, y: ey, w: 3, h: 3 }, EYE_WHITE);
          c.fill({ x: ex + 1, y: ey + 1, w: 2, h: 2 }, PUPIL);
        }
        c.fill({ x: p.head.x + 6, y: p.head.y + 11, w: 2, h: 1 }, c.S);
      },
    },
    pants: {
      trousers: (c, p) => {
        c.shaded({ x: 16, y: 29 + p.bob, w: 16, h: 6 });
        c.shaded({ ...p.legL, h: p.legL.h - 1 });
        c.shaded({ ...p.legR, h: p.legR.h - 1 });
      },
      shorts: (c, p) => {
        c.shaded({ x: 16, y: 29 + p.bob, w: 16, h: 6 });
        c.shaded({ ...p.legL, h: 7 });
        c.shaded({ ...p.legR, h: 7 });
      },
    },
    shirt: {
      tshirt: (c, p) => {
        c.shaded({ ...p.torso, y: p.torso.y - 1, h: p.torso.h + 1 });
        c.shaded({ ...p.armL, h: 6 });
        c.shaded(p.armR.y < p.torso.y ? { ...p.armR, y: p.armR.y + 7, h: 6 } : { ...p.armR, h: 6 });
      },
      tunic: (c, p) => {
        c.shaded({ x: 15, y: p.torso.y - 1, w: 18, h: 18 });
        c.shaded({ ...p.armL, h: 10 });
        c.shaded({ ...p.armR, h: 10 });
        c.fill({ x: 16, y: p.torso.y + 9, w: 16, h: 1 }, c.O); // belt line
      },
    },
    hair: {
      short: (c, p) => {
        const h = p.head;
        c.shaded({ x: h.x - 1, y: h.y - 2, w: h.w + 2, h: 7 });
        c.shaded({ x: h.x - 1, y: h.y + 3, w: 3, h: 5 });
        c.shaded({ x: h.x + h.w - 2, y: h.y + 3, w: 3, h: 5 });
      },
      long: (c, p) => {
        const h = p.head;
        c.shaded({ x: h.x - 2, y: h.y - 2, w: h.w + 4, h: 7 });
        c.shaded({ x: h.x - 2, y: h.y + 3, w: 4, h: 15 });
        c.shaded({ x: h.x + h.w - 2, y: h.y + 3, w: 4, h: 15 });
      },
    },
    accessory: {
      glasses: (c, p) => {
        const ey = p.head.y + 6;
        for (const ex of [p.head.x + 2, p.head.x + 7]) {
          c.fill({ x: ex, y: ey, w: 5, h: 5 }, c.O);
          c.fill({ x: ex + 1, y: ey + 1, w: 3, h: 3 }, LENS);
          c.px(ex + 1, ey + 1, c.H);
        }
        c.fill({ x: p.head.x + 1, y: ey + 1, w: 1, h: 1 }, c.B);
        c.fill({ x: p.head.x + 12, y: ey + 1, w: 1, h: 1 }, c.B);
      },
      crown: (c, p) => {
        const h = p.head;
        c.shaded({ x: h.x + 1, y: h.y - 4, w: h.w - 2, h: 5 });
        for (const tx of [h.x + 1, h.x + 6, h.x + 11]) c.shaded({ x: tx, y: h.y - 7, w: 3, h: 4 });
      },
    },
  },
};
