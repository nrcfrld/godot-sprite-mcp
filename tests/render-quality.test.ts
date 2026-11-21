/**
 * Render-quality rules (AGENTS.md "3. Render Quality"). Flat single-color materials,
 * a soft low-contrast light rig and heavy denoising at low samples made the Blender
 * sprites look like clay/plastic; these checks stop that from coming back.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPng, type RgbaImage } from "../src/image.ts";
import { blenderExecutable } from "../scripts/buildings/builder.ts";

const BUILDINGS = join(import.meta.dir, "..", "scripts", "buildings");
const PAINTED = join(BUILDINGS, "core", "painted_materials.py");
const SCENE_SETUP = join(BUILDINGS, "core", "scene_setup.py");

/** Minimum local surface detail (see surfaceDetail) — flat renders score ~1.9-2.1, painted ones ~2.8+. */
export const MIN_SURFACE_DETAIL = 2.5;

function pythonSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "__pycache__") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".py")) out.push(p);
    }
  };
  walk(BUILDINGS);
  walk(join(import.meta.dir, "integration"));
  return out.sort();
}

function constant(source: string, name: string): string {
  const m = new RegExp(`^${name}\\s*=\\s*(.+?)\\s*(#.*)?$`, "m").exec(source);
  if (!m) throw new Error(`${name} is not defined in scene_setup.py`);
  return m[1]!;
}

/**
 * Mean absolute difference between each pixel's luminance and its 3x3 neighbourhood mean,
 * over pixels whose whole neighbourhood is opaque (silhouette edges ignored). Low values
 * mean smooth, untextured surfaces: the clay look.
 */
export function surfaceDetail({ width: W, height: H, data }: RgbaImage): number {
  const lum = (i: number) => (data[i * 4]! * 77 + data[i * 4 + 1]! * 150 + data[i * 4 + 2]! * 29) / 256;
  let sum = 0;
  let n = 0;
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      let mean = 0;
      let opaque = true;
      for (let dy = -1; dy <= 1 && opaque; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const j = (y + dy) * W + x + dx;
          if (data[j * 4 + 3]! < 255) {
            opaque = false;
            break;
          }
          mean += lum(j);
        }
      if (!opaque) continue;
      sum += Math.abs(lum(y * W + x) - mean / 9);
      n++;
    }
  return n ? sum / n : 0;
}

describe("render quality rules", () => {
  test("every material is painted: no flat Principled materials outside painted_materials.py", () => {
    const offenders: string[] = [];
    for (const file of pythonSources()) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((raw, i) => {
        const where = `${file.slice(file.lastIndexOf("/scripts/") + 1 || file.lastIndexOf("/tests/") + 1)}:${i + 1}`;
        // Ignore comments and the two sanctioned names; whatever "material" identifier remains is a flat material.
        const line = raw.replace(/#.*$/, "").replace(/\b(painted_material|_base_material)\b/g, "");
        if (file !== PAINTED && /bpy\.data\.materials\.new\(/.test(line)) offenders.push(`${where} creates a material directly`);
        if (/(?<![\w."'])material\s*(\(|,|\)|$)/.test(line)) offenders.push(`${where} uses flat material(): ${raw.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test("painted materials keep texture: brush relief bump and limited self-illumination", () => {
    const src = readFileSync(PAINTED, "utf8");
    expect(src).toContain("ShaderNodeBump");
    const emission = Number(/"Emission Strength"\]\.default_value = ([\d.]+)/.exec(src)?.[1]);
    expect(emission).toBeLessThanOrEqual(0.1);
  });

  test("light rig and sampling stay crisp and contrasted", () => {
    const src = readFileSync(SCENE_SETUP, "utf8");
    expect(Number(constant(src, "RENDER_SAMPLES"))).toBeGreaterThanOrEqual(48);
    expect(Number(constant(src, "SUN_ANGLE"))).toBeLessThanOrEqual(0.08);
    expect(Number(constant(src, "SUN_ENERGY"))).toBeGreaterThanOrEqual(2.5);
    expect(Number(constant(src, "FILL_ENERGY"))).toBeLessThanOrEqual(150);
    expect(Number(constant(src, "WORLD_STRENGTH"))).toBeLessThanOrEqual(0.32);
    expect(constant(src, "VIEW_LOOK")).toMatch(/Contrast|Punchy/);
    // The constants must actually drive the scene.
    expect(src).toContain('light("SUN", SUN_POSITION, SUN_ENERGY, SUN_ANGLE, SUN_COLOR)');
    expect(src).toContain("scene.cycles.samples = RENDER_SAMPLES");
    expect(src).toContain("scene.view_settings.look = VIEW_LOOK");
  });

  test("rendered props sit on the ground: buildings and foliage categories cast contact shadows", () => {
    const libraries = join(import.meta.dir, "..", "libraries");
    for (const id of readdirSync(libraries)) {
      const manifestPath = join(libraries, id, "manifest.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.kind !== "props" || manifest.pixelArt) continue;
      for (const c of manifest.categories) {
        if (["buildings", "foliage"].includes(c.id)) expect({ library: id, category: c.id, contactShadow: c.contactShadow }).toEqual({ library: id, category: c.id, contactShadow: true });
      }
    }
  });

  test("village props are textured, not clay", () => {
    const props = join(import.meta.dir, "..", "libraries", "village", "assets", "props", "buildings");
    for (const file of readdirSync(props).filter((f) => f.endsWith(".png") && f !== "kegs.png")) {
      expect({ prop: file, detail: surfaceDetail(readPng(join(props, file))) >= MIN_SURFACE_DETAIL }).toEqual({ prop: file, detail: true });
    }
  });
});

const blender = blenderExecutable();
const hasBlender = blender.startsWith("/") ? existsSync(blender) : Bun.which(blender) !== null;

describe("render quality (Blender)", () => {
  test.skipIf(!hasBlender)(
    "a fresh house render meets the surface-detail threshold",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "render-quality-"));
      try {
        const out = join(dir, "house.png");
        const proc = Bun.spawn(
          [blender, "--background", "--factory-startup", "--python-exit-code", "1", "--python", join(BUILDINGS, "assemble.py"), "--", "--building", "house", "--output", out],
          { stdout: "pipe", stderr: "pipe" },
        );
        const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
        expect({ code, err: code ? err.slice(-2000) : "" }).toEqual({ code: 0, err: "" });
        expect(surfaceDetail(readPng(out))).toBeGreaterThanOrEqual(MIN_SURFACE_DETAIL);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
