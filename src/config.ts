import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { parseHex, type Rgb } from "./image.ts";

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "expected #RRGGBB");
const identifier = z.string().regex(/^[a-z0-9_]+$/, "expected lowercase snake_case identifier");

export const RampSchema = z.object({
  outline: hexColor,
  shadow: hexColor,
  base: hexColor,
  highlight: hexColor,
});

export const PalettesFileSchema = z.object({
  /** Key colors the part artists draw with; these are what palette swaps replace. */
  sourceRamp: RampSchema,
  palettes: z.record(identifier, RampSchema.extend({ label: z.string().optional() })),
  /** Named unions of ramps, used e.g. as a full game palette for normalization. */
  sets: z.record(identifier, z.array(identifier).min(1)).default({}),
});

export const LayerSchema = z.object({
  id: identifier,
  folder: z.string().min(1),
  zIndex: z.number().int(),
  required: z.boolean().default(false),
  swappable: z.boolean().default(true),
  defaultPart: identifier.optional(),
  defaultPalette: identifier.optional(),
});

export const AnimationSchema = z.object({
  name: identifier,
  frames: z.array(z.number().int().nonnegative()).min(1),
  fps: z.number().positive().default(8),
  loop: z.boolean().default(true),
});

export const ManifestSchema = z.object({
  frameWidth: z.number().int().positive(),
  frameHeight: z.number().int().positive(),
  columns: z.number().int().positive(),
  frameCount: z.number().int().positive(),
  partsDir: z.string().default("assets/parts"),
  palettesFile: z.string().default("assets/palettes.json"),
  layers: z.array(LayerSchema).min(1),
  animations: z.array(AnimationSchema).min(1),
});

export type Ramp = z.infer<typeof RampSchema>;
export type PalettesFile = z.infer<typeof PalettesFileSchema>;
export type Layer = z.infer<typeof LayerSchema>;
export type Animation = z.infer<typeof AnimationSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;

export const RAMP_SHADES = ["outline", "shadow", "base", "highlight"] as const;

export function rampColors(ramp: Ramp): [Rgb, Rgb, Rgb, Rgb] {
  return RAMP_SHADES.map((s) => parseHex(ramp[s])) as [Rgb, Rgb, Rgb, Rgb];
}

export interface AssetLibrary {
  root: string;
  partsDir: string;
  manifest: Manifest;
  palettes: PalettesFile;
  /** Layers sorted by ascending zIndex (bottom first). */
  layers: Layer[];
  /** layer id -> sorted part ids found on disk. */
  parts: Record<string, string[]>;
  rows: number;
  sheetWidth: number;
  sheetHeight: number;
}

export function defaultAssetRoot(): string {
  return resolve(process.env.GODOT_SPRITE_ASSETS_ROOT ?? join(import.meta.dir, ".."));
}

function readJson(path: string): unknown {
  if (!existsSync(path)) throw new Error(`File not found: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function formatZodError(file: string, error: z.ZodError): Error {
  const issues = error.issues.map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`).join("\n");
  return new Error(`Invalid ${file}:\n${issues}`);
}

// Plain code-unit comparison: locale-independent, so listings are stable everywhere.
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function loadAssetLibrary(root: string = defaultAssetRoot()): AssetLibrary {
  const manifestPath = join(root, "manifest.json");
  const manifestResult = ManifestSchema.safeParse(readJson(manifestPath));
  if (!manifestResult.success) throw formatZodError(manifestPath, manifestResult.error);
  const manifest = manifestResult.data;

  const palettesPath = resolve(root, manifest.palettesFile);
  const palettesResult = PalettesFileSchema.safeParse(readJson(palettesPath));
  if (!palettesResult.success) throw formatZodError(palettesPath, palettesResult.error);
  const palettes = palettesResult.data;

  const problems: string[] = [];
  const seenLayers = new Set<string>();
  for (const layer of manifest.layers) {
    if (seenLayers.has(layer.id)) problems.push(`duplicate layer id "${layer.id}"`);
    seenLayers.add(layer.id);
    if (layer.defaultPalette && !palettes.palettes[layer.defaultPalette]) {
      problems.push(`layer "${layer.id}" defaultPalette "${layer.defaultPalette}" is not defined`);
    }
  }
  for (const anim of manifest.animations) {
    for (const f of anim.frames) {
      if (f >= manifest.frameCount) {
        problems.push(`animation "${anim.name}" references frame ${f} but frameCount is ${manifest.frameCount}`);
      }
    }
  }
  for (const [setId, members] of Object.entries(palettes.sets)) {
    for (const m of members) {
      if (!palettes.palettes[m]) problems.push(`palette set "${setId}" references unknown palette "${m}"`);
    }
  }

  const partsDir = resolve(root, manifest.partsDir);
  const parts: Record<string, string[]> = {};
  for (const layer of manifest.layers) {
    const dir = join(partsDir, layer.folder);
    parts[layer.id] = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.toLowerCase().endsWith(".png"))
          .map((f) => f.slice(0, -4))
          .sort(byCodeUnit)
      : [];
  }
  if (problems.length) throw new Error(`Invalid asset library at ${root}:\n  - ${problems.join("\n  - ")}`);

  const rows = Math.ceil(manifest.frameCount / manifest.columns);
  return {
    root,
    partsDir,
    manifest,
    palettes,
    layers: [...manifest.layers].sort((a, b) => a.zIndex - b.zIndex || byCodeUnit(a.id, b.id)),
    parts,
    rows,
    sheetWidth: manifest.columns * manifest.frameWidth,
    sheetHeight: rows * manifest.frameHeight,
  };
}

export function partPath(lib: AssetLibrary, layer: Layer, partId: string): string {
  return join(lib.partsDir, layer.folder, `${partId}.png`);
}

export function frameRect(lib: AssetLibrary, frame: number) {
  const { columns, frameWidth, frameHeight } = lib.manifest;
  return {
    x: (frame % columns) * frameWidth,
    y: Math.floor(frame / columns) * frameHeight,
    w: frameWidth,
    h: frameHeight,
  };
}

/** Resolves a palette id or palette-set id to a flat, de-duplicated color list (stable order). */
export function resolvePaletteColors(lib: AssetLibrary, paletteId: string): Rgb[] {
  const ids = lib.palettes.sets[paletteId] ?? (lib.palettes.palettes[paletteId] ? [paletteId] : null);
  if (!ids) {
    const known = [...Object.keys(lib.palettes.palettes), ...Object.keys(lib.palettes.sets)].join(", ");
    throw new Error(`Unknown palette or palette set "${paletteId}". Known: ${known}`);
  }
  const seen = new Set<number>();
  const out: Rgb[] = [];
  for (const id of ids) {
    for (const c of rampColors(lib.palettes.palettes[id]!)) {
      const key = (c[0] << 16) | (c[1] << 8) | c[2];
      if (!seen.has(key)) {
        seen.add(key);
        out.push(c);
      }
    }
  }
  return out;
}
