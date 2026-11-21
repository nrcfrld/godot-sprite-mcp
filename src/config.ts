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

const colorList = z.array(hexColor).min(1).max(64);

/**
 * A palette family: the `source` colors parts are drawn with, and named variants
 * of the same length that replace them index-for-index (e.g. LPC's 6-color skin
 * ramps, or grey stops for gradient-mapping HD art).
 */
export const FamilySchema = z
  .object({
    label: z.string().optional(),
    source: colorList,
    variants: z.record(identifier, colorList),
  })
  .superRefine((f, ctx) => {
    for (const [id, colors] of Object.entries(f.variants)) {
      if (colors.length !== f.source.length) {
        ctx.addIssue({ code: "custom", path: ["variants", id], message: `has ${colors.length} colors, source has ${f.source.length}` });
      }
    }
  });

export const PalettesFileSchema = z.object({
  /** Key colors of the 4-shade "default" family (outline, shadow, base, highlight). */
  sourceRamp: RampSchema.optional(),
  /** Variants of the "default" family. */
  palettes: z.record(identifier, RampSchema.extend({ label: z.string().optional() })).default({}),
  /** Additional palette families with any number of colors. */
  families: z.record(identifier, FamilySchema).default({}),
  /**
   * Named unions of palettes, used e.g. as a full game palette for normalization.
   * Members are "family.variant", a bare default-family variant, or a family id (all its variants).
   */
  sets: z.record(identifier, z.array(z.string()).min(1)).default({}),
});

export const ChannelSchema = z.object({
  id: identifier,
  family: identifier,
  /**
   * swap: exact indexed palette swap (pixel art).
   * gradient: maps each pixel's luminance onto the variant's colors, using the
   * source colors' luminance as stops; keeps anti-aliasing and soft shading (HD art).
   */
  mode: z.enum(["swap", "gradient"]).default("swap"),
  default: identifier.optional(),
  /** Use the variant chosen for another layer's channel ("layer" or "layer.channel") unless set explicitly. */
  follow: z.string().optional(),
});

export const LayerSchema = z.object({
  id: identifier,
  folder: z.string().min(1),
  zIndex: z.number().int(),
  required: z.boolean().default(false),
  /** Shorthand for a single "main" swap channel on the default family. Ignored when `channels` is set. */
  swappable: z.boolean().default(true),
  defaultPart: identifier.optional(),
  defaultPalette: identifier.optional(),
  channels: z.array(ChannelSchema).optional(),
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
  /** Pixel art: Godot should sample with nearest filtering. HD art uses Godot's default (linear). */
  pixelArt: z.boolean().default(true),
  layers: z.array(LayerSchema).min(1),
  animations: z.array(AnimationSchema).min(1),
});

export const CreditSchema = z.object({
  title: z.string().optional(),
  authors: z.array(z.string()).default([]),
  licenses: z.array(z.string()).min(1),
  urls: z.array(z.string()).default([]),
  notes: z.string().optional(),
});

/** Optional assets/credits.json: attribution per "layer/part" (with an optional fallback for all parts). */
export const CreditsFileSchema = z.object({
  default: CreditSchema.optional(),
  parts: z.record(z.string(), CreditSchema).default({}),
});

export type Ramp = z.infer<typeof RampSchema>;
export type PalettesFile = z.infer<typeof PalettesFileSchema>;
export type Channel = z.infer<typeof ChannelSchema>;
export type Credit = z.infer<typeof CreditSchema>;
export type Layer = z.infer<typeof LayerSchema> & { channels: Channel[] };
export type Animation = z.infer<typeof AnimationSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;

export const RAMP_SHADES = ["outline", "shadow", "base", "highlight"] as const;

export function rampColors(ramp: Ramp): [Rgb, Rgb, Rgb, Rgb] {
  return RAMP_SHADES.map((s) => parseHex(ramp[s])) as [Rgb, Rgb, Rgb, Rgb];
}

export interface Family {
  label?: string;
  source: Rgb[];
  variants: Record<string, Rgb[]>;
}

export const DEFAULT_FAMILY = "default";

export interface AssetLibrary {
  id: string;
  root: string;
  partsDir: string;
  manifest: Manifest;
  palettes: PalettesFile;
  /** All palette families, including the 4-shade "default" family built from sourceRamp/palettes. */
  families: Record<string, Family>;
  /** "layer/part" -> attribution (falls back to credits.json `default`). */
  credits: Record<string, Credit>;
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

/** The asset root itself is the default library; others live in <root>/libraries/<id>/. */
export const DEFAULT_LIBRARY = "characters";

export function listLibraries(root: string = defaultAssetRoot()): string[] {
  const dir = join(root, "libraries");
  const extra = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "manifest.json")))
        .map((e) => e.name)
        .sort(byCodeUnit)
    : [];
  return [DEFAULT_LIBRARY, ...extra.filter((id) => id !== DEFAULT_LIBRARY)];
}

export type LibraryKind = "sprites" | "props";

/** Directory of a library id (the asset root itself for the default library). */
export function libraryDir(root: string, library: string): string {
  if (library === DEFAULT_LIBRARY) return root;
  const available = listLibraries(root);
  if (!available.includes(library)) {
    throw new Error(`Unknown library "${library}". Available: ${available.join(", ")}`);
  }
  return join(root, "libraries", library);
}

/** "props" libraries hold free-standing objects for compose_scene; "sprites" libraries hold layered sprite sheets. */
export function libraryKind(root: string, library: string): LibraryKind {
  const manifest = readJson(join(libraryDir(root, library), "manifest.json")) as { kind?: string };
  return manifest.kind === "props" ? "props" : "sprites";
}

/** Loads a sprite library by id from an asset root (default library when `library` is omitted). */
export function openLibrary(root: string = defaultAssetRoot(), library: string = DEFAULT_LIBRARY): AssetLibrary {
  const dir = libraryDir(root, library);
  if (libraryKind(root, library) === "props") {
    throw new Error(`Library "${library}" is a props library: use list_scene_props / compose_scene`);
  }
  return loadAssetLibrary(dir, library);
}

export function readJson(path: string): unknown {
  if (!existsSync(path)) throw new Error(`File not found: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

export function formatZodError(file: string, error: z.ZodError): Error {
  const issues = error.issues.map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`).join("\n");
  return new Error(`Invalid ${file}:\n${issues}`);
}

// Plain code-unit comparison: locale-independent, so listings are stable everywhere.
export const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function loadAssetLibrary(root: string = defaultAssetRoot(), id: string = DEFAULT_LIBRARY): AssetLibrary {
  const manifestPath = join(root, "manifest.json");
  const manifestResult = ManifestSchema.safeParse(readJson(manifestPath));
  if (!manifestResult.success) throw formatZodError(manifestPath, manifestResult.error);
  const manifest = manifestResult.data;

  const palettesPath = resolve(root, manifest.palettesFile);
  const palettesResult = PalettesFileSchema.safeParse(readJson(palettesPath));
  if (!palettesResult.success) throw formatZodError(palettesPath, palettesResult.error);
  const palettes = palettesResult.data;

  const problems: string[] = [];
  const families = buildFamilies(palettes, problems);
  const layers: Layer[] = manifest.layers.map((l) => ({
    ...l,
    channels:
      l.channels ??
      (l.swappable ? [{ id: "main", family: DEFAULT_FAMILY, mode: "swap" as const, default: l.defaultPalette }] : []),
  }));
  const seenLayers = new Set<string>();
  for (const layer of layers) {
    if (seenLayers.has(layer.id)) problems.push(`duplicate layer id "${layer.id}"`);
    seenLayers.add(layer.id);
    const seenChannels = new Set<string>();
    for (const ch of layer.channels) {
      const where = `layer "${layer.id}" channel "${ch.id}"`;
      if (seenChannels.has(ch.id)) problems.push(`${where} is duplicated`);
      seenChannels.add(ch.id);
      const family = families[ch.family];
      if (!family) problems.push(`${where} uses unknown palette family "${ch.family}"`);
      else if (ch.default && !family.variants[ch.default]) problems.push(`${where} default "${ch.default}" is not in family "${ch.family}"`);
    }
    if (layer.channels.some((c) => c.mode === "gradient") && layer.channels.length > 1) {
      problems.push(`layer "${layer.id}": a gradient channel must be the layer's only channel`);
    }
  }
  for (const layer of layers) {
    for (const ch of layer.channels) {
      if (!ch.follow) continue;
      const [lid, cid] = ch.follow.split(".");
      const target = layers.find((l) => l.id === lid)?.channels.find((c) => (cid ? c.id === cid : true));
      if (!target) problems.push(`layer "${layer.id}" channel "${ch.id}" follows unknown "${ch.follow}"`);
      else if (target.family !== ch.family) problems.push(`layer "${layer.id}" channel "${ch.id}" follows "${ch.follow}" of a different family`);
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
      try {
        resolveVariantRefs(families, {}, m);
      } catch {
        problems.push(`palette set "${setId}" references unknown palette "${m}"`);
      }
    }
  }

  const credits: Record<string, Credit> = {};
  const creditsPath = join(root, "assets", "credits.json");
  let creditsFile: z.infer<typeof CreditsFileSchema> | null = null;
  if (existsSync(creditsPath)) {
    const r = CreditsFileSchema.safeParse(readJson(creditsPath));
    if (!r.success) throw formatZodError(creditsPath, r.error);
    creditsFile = r.data;
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
    for (const part of parts[layer.id]!) {
      const c = creditsFile?.parts[`${layer.id}/${part}`] ?? creditsFile?.default;
      if (c) credits[`${layer.id}/${part}`] = c;
    }
  }
  if (problems.length) throw new Error(`Invalid asset library at ${root}:\n  - ${problems.join("\n  - ")}`);

  const rows = Math.ceil(manifest.frameCount / manifest.columns);
  return {
    id,
    root,
    partsDir,
    manifest,
    palettes,
    families,
    credits,
    layers: layers.sort((a, b) => a.zIndex - b.zIndex || byCodeUnit(a.id, b.id)),
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

export function buildFamilies(palettes: PalettesFile, problems: string[]): Record<string, Family> {
  const families: Record<string, Family> = {};
  if (palettes.sourceRamp) {
    if (palettes.families[DEFAULT_FAMILY]) problems.push(`family "${DEFAULT_FAMILY}" is defined twice (sourceRamp and families)`);
    families[DEFAULT_FAMILY] = {
      source: rampColors(palettes.sourceRamp),
      variants: Object.fromEntries(Object.entries(palettes.palettes).map(([id, r]) => [id, rampColors(r)])),
    };
  } else if (Object.keys(palettes.palettes).length) {
    problems.push(`"palettes" requires "sourceRamp"`);
  }
  for (const [id, f] of Object.entries(palettes.families)) {
    families[id] = {
      label: f.label,
      source: f.source.map(parseHex),
      variants: Object.fromEntries(Object.entries(f.variants).map(([v, cs]) => [v, cs.map(parseHex)])),
    };
  }
  return families;
}

/** Expands a palette reference to [family, variant] pairs. */
function resolveVariantRefs(
  families: Record<string, Family>,
  sets: Record<string, string[]>,
  ref: string,
  seen: Set<string> = new Set(),
): [string, string][] {
  if (sets[ref]) {
    if (seen.has(ref)) throw new Error(`Palette set "${ref}" is recursive`);
    seen.add(ref);
    return sets[ref]!.flatMap((m) => resolveVariantRefs(families, sets, m, seen));
  }
  const dot = ref.indexOf(".");
  if (dot > 0) {
    const [fid, vid] = [ref.slice(0, dot), ref.slice(dot + 1)];
    if (families[fid]?.variants[vid]) return [[fid, vid]];
  } else {
    if (families[DEFAULT_FAMILY]?.variants[ref]) return [[DEFAULT_FAMILY, ref]];
    if (families[ref]) return Object.keys(families[ref]!.variants).map((v) => [ref, v] as [string, string]);
    const matches = Object.entries(families).filter(([, f]) => f.variants[ref]);
    if (matches.length === 1) return [[matches[0]![0], ref]];
    if (matches.length > 1) {
      throw new Error(`Palette "${ref}" is ambiguous; use one of ${matches.map(([f]) => `${f}.${ref}`).join(", ")}`);
    }
  }
  throw new Error(`Unknown palette "${ref}"`);
}

/** Every palette reference accepted by resolvePaletteColors, for error messages and listings. */
export function knownPaletteRefs(lib: AssetLibrary): string[] {
  const refs = Object.keys(lib.palettes.sets);
  for (const [fid, f] of Object.entries(lib.families)) {
    refs.push(fid);
    for (const v of Object.keys(f.variants)) refs.push(fid === DEFAULT_FAMILY ? v : `${fid}.${v}`);
  }
  return refs;
}

/**
 * Resolves a palette set, family, "family.variant" or bare variant id to a flat,
 * de-duplicated color list (stable order).
 */
export function resolvePaletteColors(lib: AssetLibrary, paletteId: string): Rgb[] {
  let refs: [string, string][];
  try {
    refs = resolveVariantRefs(lib.families, lib.palettes.sets, paletteId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${msg.replace("Unknown palette", "Unknown palette or palette set")}. Known: ${knownPaletteRefs(lib).join(", ")}`);
  }
  const seen = new Set<number>();
  const out: Rgb[] = [];
  for (const [fid, vid] of refs) {
    for (const c of lib.families[fid]!.variants[vid]!) {
      const key = (c[0] << 16) | (c[1] << 8) | c[2];
      if (!seen.has(key)) {
        seen.add(key);
        out.push(c);
      }
    }
  }
  return out;
}
