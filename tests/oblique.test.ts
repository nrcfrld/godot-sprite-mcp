import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPng } from "../src/image.ts";
import { blenderExecutable } from "../scripts/buildings/builder.ts";
import { renderObliqueAsset } from "../scripts/oblique/oblique.ts";

const CALIBRATION = join(import.meta.dir, "..", "scripts", "oblique", "examples", "calibration.py");
const blender = blenderExecutable();
const hasBlender = blender.startsWith("/") ? existsSync(blender) : Bun.which(blender) !== null;

describe("render_oblique_asset input", () => {
  test("rejects a relative or missing scene before starting Blender", async () => {
    const out = mkdtempSync(join(tmpdir(), "oblique-input-"));
    try {
      await expect(renderObliqueAsset({ scene: "asset.py", name: "a", outputDir: out }, "/nonexistent")).rejects.toThrow(/absolute/);
      await expect(renderObliqueAsset({ scene: "/no/such/asset.py", name: "a", outputDir: out }, "/nonexistent")).rejects.toThrow(/existing \.py/);
      await expect(renderObliqueAsset({ scene: CALIBRATION, name: "bad name", outputDir: out }, "/nonexistent")).rejects.toThrow();
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("render_oblique_asset (Blender)", () => {
  test.skipIf(!hasBlender)(
    "renders components, hinge frames and passes on one anchored canvas, byte-identically",
    async () => {
      const a = mkdtempSync(join(tmpdir(), "oblique-a-"));
      const b = mkdtempSync(join(tmpdir(), "oblique-b-"));
      try {
        const options = { scene: CALIBRATION, name: "cal", samples: 4, pxPerUnit: 1 };
        const first = await renderObliqueAsset({ ...options, outputDir: a }, blender);
        const second = await renderObliqueAsset({ ...options, outputDir: b }, blender);
        expect(second.artifacts).toEqual(first.artifacts);

        const meta = JSON.parse(readFileSync(first.metadataPath, "utf8"));
        expect(Object.keys(meta.components).sort()).toEqual(["body", "door", "reference", "roof"]);
        expect(meta.components.door.frames).toHaveLength(5);
        expect(meta.components.body.frames[0].emission).toBe("cal-body.emission.png");
        expect(meta.shadow).toBe("cal-shadow.png");
        // Ground pivot is the world origin: the threshold marker (x = -1.2 m, y = -0.06 m) lands left of it.
        expect(meta.markers.door_threshold[0]).toBeCloseTo((-1.2 - 0.06 * 0.8) * 36, 2);
        expect(meta.markers.door_threshold[1]).toBeCloseTo(0.06 * 0.4 * 36, 2);
        // Footprint back edge is drawn up and to the right by the depth axis.
        expect(meta.footprints.body[2][0]).toBeCloseTo((3 + 4 * 0.8) * 36, 2);
        expect(meta.footprints.body[2][1]).toBeCloseTo(-4 * 0.4 * 36, 2);

        for (const frame of [...meta.components.door.frames, ...meta.components.body.frames]) {
          for (const file of [frame.color, frame.normal]) {
            const png = readPng(join(a, file));
            expect([png.width, png.height]).toEqual([meta.width, meta.height]);
          }
        }
        // Normal map: the sunlit facade faces the camera (blue), the right wall faces +X (red).
        const normal = readPng(join(a, "cal-body.normal.png"));
        const at = (x: number, y: number) => Array.from(normal.data.subarray((y * normal.width + x) * 4, (y * normal.width + x) * 4 + 3));
        const [ax, ay] = meta.anchor;
        const facade = at(ax + Math.round(0.5 * 36), ay - Math.round(1.0 * 36));
        expect(facade[2]!).toBeGreaterThan(240);
        expect(Math.abs(facade[0]! - 128)).toBeLessThan(8);
        const side = at(ax + Math.round((3 + 2 * 0.8) * 36), ay - Math.round((1.0 + 2 * 0.4) * 36));
        expect(side[0]!).toBeGreaterThan(200);
        // Shadow layer is pure alpha on black.
        const shadow = readPng(join(a, "cal-shadow.png"));
        let shaded = 0;
        for (let i = 0; i < shadow.data.length; i += 4) {
          expect(shadow.data[i]! + shadow.data[i + 1]! + shadow.data[i + 2]!).toBe(0);
          if (shadow.data[i + 3]! > 64) shaded++;
        }
        expect(shaded).toBeGreaterThan(500);
      } finally {
        rmSync(a, { recursive: true, force: true });
        rmSync(b, { recursive: true, force: true });
      }
    },
    300_000,
  );
});
