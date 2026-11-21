import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  frameRect,
  partPath,
  resolvePaletteColors,
  type AssetLibrary,
  type Channel,
  type Credit,
  type Layer,
} from "./config.ts";
import { compositeOver, createImage, encodePng, readPng, type Rgb, type RgbaImage } from "./image.ts";
import { gradientMap, quantizeToPalette, swapPalette } from "./palette.ts";
import { generateNormalMap } from "./normal.ts";
import { buildSpriteFramesTres, godotResourcePath } from "./tres.ts";

export function listSpriteParts(lib: AssetLibrary) {
  return {
    library: lib.id,
    frameWidth: lib.manifest.frameWidth,
    frameHeight: lib.manifest.frameHeight,
    columns: lib.manifest.columns,
    rows: lib.rows,
    frameCount: lib.manifest.frameCount,
    sheetWidth: lib.sheetWidth,
    sheetHeight: lib.sheetHeight,
    layers: lib.layers.map((l) => ({
      id: l.id,
      folder: l.folder,
      zIndex: l.zIndex,
      required: l.required,
      defaultPart: l.defaultPart ?? null,
      channels: l.channels.map((c) => ({
        id: c.id,
        family: c.family,
        mode: c.mode,
        default: c.default ?? null,
        follow: c.follow ?? null,
        variants: Object.keys(lib.families[c.family]!.variants),
      })),
      parts: (lib.parts[l.id] ?? []).map((id) => {
        const credit = lib.credits[`${l.id}/${id}`];
        return credit ? { id, licenses: credit.licenses } : { id };
      }),
    })),
    pixelArt: lib.manifest.pixelArt,
    sourceRamp: lib.palettes.sourceRamp ?? null,
    palettes: Object.entries(lib.palettes.palettes).map(([id, p]) => ({ id, ...p })),
    families: Object.entries(lib.families).map(([id, f]) => ({ id, label: f.label ?? null, colors: f.source.length, variants: Object.keys(f.variants) })),
    paletteSets: lib.palettes.sets,
    animations: lib.manifest.animations.map((a) => ({
      name: a.name,
      fps: a.fps,
      loop: a.loop,
      frames: a.frames.map((f) => ({ index: f, ...frameRect(lib, f) })),
    })),
  };
}

export interface ComposeInput {
  name: string;
  /** layer id (or folder name) -> part id; null skips an optional layer. */
  parts: Record<string, string | null>;
  /** "layer" (first color channel) or "layer.channel" -> palette variant id. */
  palettes?: Record<string, string>;
  outputDir: string;
  /** Also write <name>_normal.png and reference it from the .tres via a CanvasTexture (for 2D lighting). */
  normalMap?: boolean;
}

function resolveLayerKey(lib: AssetLibrary, key: string, field: string): Layer {
  const layer = lib.layers.find((l) => l.id === key || l.folder === key);
  if (!layer) {
    throw new Error(`Unknown layer "${key}" in ${field}. Valid layers: ${lib.layers.map((l) => l.id).join(", ")}`);
  }
  return layer;
}

function normaliseLayerMap<T>(lib: AssetLibrary, map: Record<string, T>, field: string): Map<string, T> {
  const out = new Map<string, T>();
  for (const [key, value] of Object.entries(map)) {
    const layer = resolveLayerKey(lib, key, field);
    if (out.has(layer.id)) throw new Error(`Layer "${layer.id}" specified twice in ${field}`);
    out.set(layer.id, value);
  }
  return out;
}

/** Normalises palette keys ("layer", "folder" or "layer.channel") to "layer.channel". */
function normalisePaletteMap(lib: AssetLibrary, map: Record<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(map)) {
    const dot = key.indexOf(".");
    const layer = resolveLayerKey(lib, dot > 0 ? key.slice(0, dot) : key, "palettes");
    if (layer.channels.length === 0) throw new Error(`Layer "${layer.id}" does not support palette swapping`);
    const channelId = dot > 0 ? key.slice(dot + 1) : layer.channels[0]!.id;
    const channel = layer.channels.find((c) => c.id === channelId);
    if (!channel) {
      throw new Error(`Layer "${layer.id}" has no color channel "${channelId}". Channels: ${layer.channels.map((c) => c.id).join(", ")}`);
    }
    const id = `${layer.id}.${channel.id}`;
    if (out.has(id)) throw new Error(`Palette for "${id}" specified twice`);
    const family = lib.families[channel.family]!;
    if (!family.variants[value]) {
      throw new Error(
        `Unknown palette "${value}" for layer "${layer.id}"${layer.channels.length > 1 ? ` channel "${channel.id}"` : ""}. ` +
          `Available: ${Object.keys(family.variants).join(", ")}`,
      );
    }
    out.set(id, value);
  }
  return out;
}

export interface ResolvedRecolor {
  channel: string;
  family: string;
  mode: Channel["mode"];
  variant: string;
}

export interface ResolvedLayer {
  layer: Layer;
  partId: string;
  recolors: ResolvedRecolor[];
}

/** Validates the request against the library and returns the layer stack bottom-to-top. */
export function resolveLayerStack(lib: AssetLibrary, input: Pick<ComposeInput, "parts" | "palettes">): ResolvedLayer[] {
  const parts = normaliseLayerMap(lib, input.parts, "parts");
  const palettes = normalisePaletteMap(lib, input.palettes ?? {});

  const channelKey = (ref: string) => {
    const [lid, cid] = ref.split(".");
    const layer = lib.layers.find((l) => l.id === lid)!;
    return `${layer.id}.${cid ?? layer.channels[0]!.id}`;
  };
  const defaultOf = (key: string) => {
    const [lid, cid] = key.split(".");
    return lib.layers.find((l) => l.id === lid)!.channels.find((c) => c.id === cid)!.default ?? null;
  };
  // Explicit choice > the followed channel's choice (explicit or default) > own default.
  const variantFor = (layer: Layer, ch: Channel): string | null => {
    const own = `${layer.id}.${ch.id}`;
    if (palettes.has(own)) return palettes.get(own)!;
    if (ch.follow) {
      const target = channelKey(ch.follow);
      const v = palettes.get(target) ?? defaultOf(target);
      if (v) return v;
    }
    return ch.default ?? null;
  };

  const stack: ResolvedLayer[] = [];
  for (const layer of lib.layers) {
    const requested = parts.has(layer.id) ? parts.get(layer.id)! : layer.defaultPart ?? null;
    if (requested === null) {
      if (layer.required) throw new Error(`Layer "${layer.id}" is required but no part was given`);
      const given = [...palettes.keys()].find((k) => k.startsWith(`${layer.id}.`));
      if (given && !lib.layers.some((l) => l.channels.some((c) => c.follow && channelKey(c.follow) === given))) {
        throw new Error(`Palette given for layer "${layer.id}" but no part selected`);
      }
      continue;
    }
    const available = lib.parts[layer.id] ?? [];
    if (!available.includes(requested)) {
      throw new Error(`Unknown part "${requested}" for layer "${layer.id}". Available: ${available.join(", ") || "(none)"}`);
    }
    const recolors: ResolvedRecolor[] = [];
    for (const ch of layer.channels) {
      const variant = variantFor(layer, ch);
      if (variant) recolors.push({ channel: ch.id, family: ch.family, mode: ch.mode, variant });
    }
    stack.push({ layer, partId: requested, recolors });
  }
  return stack;
}

/** Applies a layer's recolor channels. Swap channels are merged into one pass so they never chain. */
export function recolorLayer(lib: AssetLibrary, img: RgbaImage, recolors: ResolvedRecolor[]): RgbaImage {
  const source: Rgb[] = [];
  const target: Rgb[] = [];
  for (const r of recolors) {
    const family = lib.families[r.family]!;
    if (r.mode === "gradient") return gradientMap(img, family.source, family.variants[r.variant]!);
    source.push(...family.source);
    target.push(...family.variants[r.variant]!);
  }
  return source.length ? swapPalette(img, source, target) : img;
}

/** Pure compositing step: same stack + same asset files => identical pixels. */
export function renderLayerStack(lib: AssetLibrary, stack: ResolvedLayer[]): RgbaImage {
  const sheet = createImage(lib.sheetWidth, lib.sheetHeight);
  for (const { layer, partId, recolors } of stack) {
    const img = readPng(partPath(lib, layer, partId));
    if (img.width !== lib.sheetWidth || img.height !== lib.sheetHeight) {
      throw new Error(
        `Part "${layer.id}/${partId}" is ${img.width}x${img.height}, expected ${lib.sheetWidth}x${lib.sheetHeight} ` +
          `(${lib.manifest.columns}x${lib.rows} frames of ${lib.manifest.frameWidth}x${lib.manifest.frameHeight})`,
      );
    }
    compositeOver(sheet, recolorLayer(lib, img, recolors));
  }
  return sheet;
}

const SAFE_NAME = /^[A-Za-z0-9_-]+$/;

export function buildCreditsMarkdown(name: string, file: string, credits: ({ part: string } & Credit)[]): string {
  const lines = [`# Credits for ${file}`, "", `Generated by godot-sprite-mcp for "${name}". Keep this file with the sprite.`, ""];
  for (const c of credits) {
    lines.push(`## ${c.part}${c.title ? ` — ${c.title}` : ""}`, "");
    if (c.authors.length) lines.push(`- Authors: ${c.authors.join(", ")}`);
    lines.push(`- License: ${c.licenses.join(" / ")}`);
    for (const u of c.urls) lines.push(`- Source: ${u}`);
    if (c.notes) lines.push(`- Notes: ${c.notes}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function composeCharacterSprite(lib: AssetLibrary, input: ComposeInput, resourceDir = input.outputDir) {
  if (!SAFE_NAME.test(input.name)) {
    throw new Error(`Invalid name "${input.name}": use only letters, digits, "_" and "-"`);
  }
  const stack = resolveLayerStack(lib, input);
  const sheet = renderLayerStack(lib, stack);

  const outputDir = resolve(input.outputDir);
  mkdirSync(outputDir, { recursive: true });
  const pngPath = join(outputDir, `${input.name}.png`);
  const tresPath = join(outputDir, `${input.name}_frames.tres`);

  const pngBytes = encodePng(sheet);
  writeFileSync(pngPath, pngBytes);

  let normalPath: string | null = null;
  if (input.normalMap) {
    normalPath = join(outputDir, `${input.name}_normal.png`);
    const normal = generateNormalMap(sheet, { frameWidth: lib.manifest.frameWidth, frameHeight: lib.manifest.frameHeight });
    writeFileSync(normalPath, encodePng(normal));
  }

  const frames = Array.from({ length: lib.manifest.frameCount }, (_, i) => frameRect(lib, i));
  const resourcePath = (filename: string) => godotResourcePath(join(resourceDir, filename), resourceDir);
  const texturePath = resourcePath(`${input.name}.png`);
  const tres = buildSpriteFramesTres({
    texturePath,
    normalPath: normalPath ? resourcePath(`${input.name}_normal.png`) : undefined,
    filter: lib.manifest.pixelArt ? "nearest" : "linear",
    frames,
    animations: lib.manifest.animations,
  });
  writeFileSync(tresPath, tres);

  const credits = stack
    .filter((s) => lib.credits[`${s.layer.id}/${s.partId}`])
    .map((s) => ({ part: `${s.layer.id}/${s.partId}`, ...lib.credits[`${s.layer.id}/${s.partId}`]! }));
  let creditsPath: string | null = null;
  if (credits.length) {
    creditsPath = join(outputDir, `${input.name}_CREDITS.md`);
    writeFileSync(creditsPath, buildCreditsMarkdown(input.name, `${input.name}.png`, credits));
  }

  return {
    library: lib.id,
    pngPath,
    tresPath,
    normalPath,
    creditsPath,
    texturePath,
    grid: {
      frameWidth: lib.manifest.frameWidth,
      frameHeight: lib.manifest.frameHeight,
      columns: lib.manifest.columns,
      rows: lib.rows,
      frameCount: lib.manifest.frameCount,
      sheetWidth: sheet.width,
      sheetHeight: sheet.height,
    },
    layers: stack.map((s) => ({
      layer: s.layer.id,
      zIndex: s.layer.zIndex,
      part: s.partId,
      palette: s.recolors[0]?.variant ?? null,
      ...(s.recolors.length > 1 ? { palettes: Object.fromEntries(s.recolors.map((r) => [r.channel, r.variant])) } : {}),
    })),
    animations: lib.manifest.animations.map((a) => a.name),
    licenses: [...new Set(credits.flatMap((c) => c.licenses))],
    sha256: createHash("sha256").update(pngBytes).digest("hex"),
  };
}

/** Nearest-neighbor resample (pixel centers, integer math, no filtering). */
export function resizeNearest(image: RgbaImage, width: number, height: number): RgbaImage {
  const out = createImage(width, height);
  for (let y = 0; y < height; y++) {
    const sy = Math.floor(((2 * y + 1) * image.height) / (2 * height));
    for (let x = 0; x < width; x++) {
      const sx = Math.floor(((2 * x + 1) * image.width) / (2 * width));
      const si = (sy * image.width + sx) * 4;
      const di = (y * width + x) * 4;
      out.data[di] = image.data[si]!;
      out.data[di + 1] = image.data[si + 1]!;
      out.data[di + 2] = image.data[si + 2]!;
      out.data[di + 3] = image.data[si + 3]!;
    }
  }
  return out;
}

export interface NormalMapInput {
  inputPath: string;
  outputPath: string;
  /** Frame size of the sheet (defaults to the whole image as one frame). */
  frameWidth?: number;
  frameHeight?: number;
  strength?: number;
  bevel?: number;
}

export function normalMapFile(input: NormalMapInput) {
  const inputPath = resolve(input.inputPath);
  if (!existsSync(inputPath)) throw new Error(`Input file not found: ${inputPath}`);
  const src = readPng(inputPath);
  const frameWidth = input.frameWidth ?? src.width;
  const frameHeight = input.frameHeight ?? src.height;
  if (src.width % frameWidth || src.height % frameHeight) {
    throw new Error(`Image ${src.width}x${src.height} is not a whole number of ${frameWidth}x${frameHeight} frames`);
  }
  const normal = generateNormalMap(src, { frameWidth, frameHeight, strength: input.strength, bevel: input.bevel });
  const outputPath = resolve(input.outputPath);
  mkdirSync(resolve(outputPath, ".."), { recursive: true });
  const bytes = encodePng(normal);
  writeFileSync(outputPath, bytes);
  return { outputPath, width: src.width, height: src.height, frameWidth, frameHeight, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export interface NormalizeInput {
  inputPath: string;
  targetWidth: number;
  targetHeight: number;
  /** A palette id or palette-set id from palettes.json. */
  paletteId: string;
  outputPath: string;
  alphaThreshold?: number;
}

export function normalizePixelArt(lib: AssetLibrary, input: NormalizeInput) {
  const inputPath = resolve(input.inputPath);
  if (!existsSync(inputPath)) throw new Error(`Input file not found: ${inputPath}`);
  for (const [k, v] of [["targetWidth", input.targetWidth], ["targetHeight", input.targetHeight]] as const) {
    if (!Number.isInteger(v) || v <= 0) throw new Error(`${k} must be a positive integer, got ${v}`);
  }
  const palette = resolvePaletteColors(lib, input.paletteId);
  const src = readPng(inputPath);
  const resized = resizeNearest(src, input.targetWidth, input.targetHeight);
  const result = quantizeToPalette(resized, palette, input.alphaThreshold ?? 128);

  const outputPath = resolve(input.outputPath);
  mkdirSync(resolve(outputPath, ".."), { recursive: true });
  const bytes = encodePng(result);
  writeFileSync(outputPath, bytes);

  const used = new Set<number>();
  for (let i = 0; i < result.data.length; i += 4) {
    if (result.data[i + 3]) used.add((result.data[i]! << 16) | (result.data[i + 1]! << 8) | result.data[i + 2]!);
  }
  return {
    library: lib.id,
    outputPath,
    sourceWidth: src.width,
    sourceHeight: src.height,
    width: result.width,
    height: result.height,
    paletteId: input.paletteId,
    paletteSize: palette.length,
    colorsUsed: used.size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
