import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  frameRect,
  partPath,
  rampColors,
  resolvePaletteColors,
  type AssetLibrary,
  type Layer,
} from "./config.ts";
import { compositeOver, createImage, encodePng, readPng, type RgbaImage } from "./image.ts";
import { quantizeToPalette, swapPalette } from "./palette.ts";
import { buildSpriteFramesTres, godotResourcePath } from "./tres.ts";

export function listSpriteParts(lib: AssetLibrary) {
  return {
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
      swappable: l.swappable,
      defaultPart: l.defaultPart ?? null,
      defaultPalette: l.defaultPalette ?? null,
      parts: lib.parts[l.id] ?? [],
    })),
    sourceRamp: lib.palettes.sourceRamp,
    palettes: Object.entries(lib.palettes.palettes).map(([id, p]) => ({ id, ...p })),
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
  /** layer id (or folder name) -> palette id. */
  palettes?: Record<string, string>;
  outputDir: string;
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

export interface ResolvedLayer {
  layer: Layer;
  partId: string;
  paletteId: string | null;
}

/** Validates the request against the library and returns the layer stack bottom-to-top. */
export function resolveLayerStack(lib: AssetLibrary, input: Pick<ComposeInput, "parts" | "palettes">): ResolvedLayer[] {
  const parts = normaliseLayerMap(lib, input.parts, "parts");
  const palettes = normaliseLayerMap(lib, input.palettes ?? {}, "palettes");
  const stack: ResolvedLayer[] = [];
  for (const layer of lib.layers) {
    const requested = parts.has(layer.id) ? parts.get(layer.id)! : layer.defaultPart ?? null;
    if (requested === null) {
      if (layer.required) throw new Error(`Layer "${layer.id}" is required but no part was given`);
      if (palettes.has(layer.id)) throw new Error(`Palette given for layer "${layer.id}" but no part selected`);
      continue;
    }
    const available = lib.parts[layer.id] ?? [];
    if (!available.includes(requested)) {
      throw new Error(`Unknown part "${requested}" for layer "${layer.id}". Available: ${available.join(", ") || "(none)"}`);
    }
    let paletteId = palettes.get(layer.id) ?? null;
    if (paletteId !== null && !layer.swappable) {
      throw new Error(`Layer "${layer.id}" does not support palette swapping`);
    }
    if (paletteId === null && layer.swappable) paletteId = layer.defaultPalette ?? null;
    if (paletteId !== null && !lib.palettes.palettes[paletteId]) {
      throw new Error(`Unknown palette "${paletteId}" for layer "${layer.id}". Available: ${Object.keys(lib.palettes.palettes).join(", ")}`);
    }
    stack.push({ layer, partId: requested, paletteId });
  }
  return stack;
}

/** Pure compositing step: same stack + same asset files => identical pixels. */
export function renderLayerStack(lib: AssetLibrary, stack: ResolvedLayer[]): RgbaImage {
  const sheet = createImage(lib.sheetWidth, lib.sheetHeight);
  const source = rampColors(lib.palettes.sourceRamp);
  for (const { layer, partId, paletteId } of stack) {
    let img = readPng(partPath(lib, layer, partId));
    if (img.width !== lib.sheetWidth || img.height !== lib.sheetHeight) {
      throw new Error(
        `Part "${layer.id}/${partId}" is ${img.width}x${img.height}, expected ${lib.sheetWidth}x${lib.sheetHeight} ` +
          `(${lib.manifest.columns}x${lib.rows} frames of ${lib.manifest.frameWidth}x${lib.manifest.frameHeight})`,
      );
    }
    if (paletteId) img = swapPalette(img, source, rampColors(lib.palettes.palettes[paletteId]!));
    compositeOver(sheet, img);
  }
  return sheet;
}

const SAFE_NAME = /^[A-Za-z0-9_-]+$/;

export function composeCharacterSprite(lib: AssetLibrary, input: ComposeInput) {
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

  const frames = Array.from({ length: lib.manifest.frameCount }, (_, i) => frameRect(lib, i));
  const texturePath = godotResourcePath(pngPath, outputDir);
  const tres = buildSpriteFramesTres({ texturePath, frames, animations: lib.manifest.animations });
  writeFileSync(tresPath, tres);

  return {
    pngPath,
    tresPath,
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
    layers: stack.map((s) => ({ layer: s.layer.id, zIndex: s.layer.zIndex, part: s.partId, palette: s.paletteId })),
    animations: lib.manifest.animations.map((a) => a.name),
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
