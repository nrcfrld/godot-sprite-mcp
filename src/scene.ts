import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  buildFamilies,
  byCodeUnit,
  ChannelSchema,
  CreditsFileSchema,
  formatZodError,
  libraryDir,
  libraryKind,
  own,
  PalettesFileSchema,
  readJson,
  type Channel,
  type Credit,
  type Family,
} from "./config.ts";
import { compositeOver, createImage, encodePng, parseHex, readPng, type Rgb, type RgbaImage } from "./image.ts";
import { generateNormalMap } from "./normal.ts";
import { gradientMap, swapPalette } from "./palette.ts";
import { buildCreditsMarkdown, groupCredits } from "./sprite.ts";
import { godotResourcePath } from "./tres.ts";

export const DEFAULT_PROPS_LIBRARY = "village";

export const PropsManifestSchema = z.object({
  kind: z.literal("props"),
  pixelArt: z.boolean().default(true),
  propsDir: z.string().default("assets/props"),
  palettesFile: z.string().default("assets/palettes.json"),
  categories: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9_]+$/),
        folder: z.string().min(1),
        description: z.string().optional(),
        /** Optional recolor channel for every prop in the category. */
        channel: ChannelSchema.omit({ follow: true, id: true }).optional(),
        /** Draw a soft ground shadow under each placed prop so it sits on the ground instead of floating. */
        contactShadow: z.boolean().default(false),
      }),
    )
    .min(1),
});

export interface Prop {
  id: string;
  category: string;
  path: string;
  width: number;
  height: number;
}

export interface PropsLibrary {
  id: string;
  root: string;
  manifest: z.infer<typeof PropsManifestSchema>;
  families: Record<string, Family>;
  props: Record<string, Prop>;
  credits: Record<string, Credit>;
}

/** Reads width/height from a PNG's IHDR chunk without decoding pixels. */
function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error(`Invalid PNG header: ${path}`);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height) throw new Error(`Invalid PNG size: ${path}`);
  return { width, height };
}

export function openPropsLibrary(root: string, library: string = DEFAULT_PROPS_LIBRARY): PropsLibrary {
  const dir = libraryDir(root, library);
  if (libraryKind(root, library) !== "props") {
    throw new Error(`Library "${library}" is a sprite library: use list_sprite_parts / compose_character_sprite`);
  }
  const manifestPath = join(dir, "manifest.json");
  const m = PropsManifestSchema.safeParse(readJson(manifestPath));
  if (!m.success) throw formatZodError(manifestPath, m.error);
  const manifest = m.data;

  const problems: string[] = [];
  let families: Record<string, Family> = {};
  const palettesPath = resolve(dir, manifest.palettesFile);
  if (existsSync(palettesPath)) {
    const p = PalettesFileSchema.safeParse(readJson(palettesPath));
    if (!p.success) throw formatZodError(palettesPath, p.error);
    families = buildFamilies(p.data, problems);
  }
  for (const { id, channel } of manifest.categories) {
    if (!channel) continue;
    if (!Object.hasOwn(families, channel.family)) {
      problems.push(`category "${id}" uses unknown family "${channel.family}"`);
    } else if (channel.default && !Object.hasOwn(families[channel.family]!.variants, channel.default)) {
      problems.push(`category "${id}" uses unknown default variant "${channel.default}" in family "${channel.family}"`);
    }
  }

  const creditsPath = join(dir, "assets", "credits.json");
  let creditsFile: z.infer<typeof CreditsFileSchema> | null = null;
  if (existsSync(creditsPath)) {
    const r = CreditsFileSchema.safeParse(readJson(creditsPath));
    if (!r.success) throw formatZodError(creditsPath, r.error);
    creditsFile = r.data;
  }

  const props: Record<string, Prop> = Object.create(null);
  const credits: Record<string, Credit> = Object.create(null);
  for (const c of manifest.categories) {
    const folder = join(resolve(dir, manifest.propsDir), c.folder);
    if (!existsSync(folder)) continue;
    for (const file of readdirSync(folder).filter((f) => f.endsWith(".png")).sort(byCodeUnit)) {
      const id = file.slice(0, -4);
      if (!SAFE_NAME.test(id)) {
        problems.push(`invalid prop id "${id}" in category "${c.id}"`);
        continue;
      }
      if (props[id]) problems.push(`prop "${id}" exists in both "${props[id]!.category}" and "${c.id}"`);
      const path = join(folder, file);
      props[id] = { id, category: c.id, path, ...pngSize(path) };
      const credit = creditsFile?.parts[`${c.id}/${id}`] ?? creditsFile?.default;
      if (credit) credits[id] = credit;
    }
  }
  if (problems.length) throw new Error(`Invalid props library at ${dir}:\n  - ${problems.join("\n  - ")}`);
  return { id: library, root: dir, manifest, families, props, credits };
}

function channelOf(lib: PropsLibrary, prop: Prop): Omit<Channel, "id" | "follow"> | null {
  return lib.manifest.categories.find((c) => c.id === prop.category)?.channel ?? null;
}

export function listSceneProps(lib: PropsLibrary) {
  return {
    library: lib.id,
    kind: "props",
    pixelArt: lib.manifest.pixelArt,
    categories: lib.manifest.categories.map((c) => ({
      id: c.id,
      description: c.description ?? null,
      recolor: c.channel ? { family: c.channel.family, mode: c.channel.mode, variants: Object.keys(lib.families[c.channel.family]!.variants) } : null,
      props: Object.values(lib.props)
        .filter((p) => p.category === c.id)
        .map((p) => ({ id: p.id, width: p.width, height: p.height })),
    })),
    licenses: [...new Set(Object.values(lib.credits).flatMap((c) => c.licenses))],
  };
}

const SAFE_NAME = /^[A-Za-z0-9_-]+$/;
const hexColor = z.string().trim().regex(/^#?[0-9a-fA-F]{6}$/);
const propPosition = {
  prop: z.string().regex(SAFE_NAME),
  y: z.int().describe("Y coordinate of the prop's bottom edge"),
  palette: z.string().min(1).optional(),
};

/** Largest scene side: a 4096² scene with normals peaks around 0.8 GB of RAM. */
export const MAX_SCENE_SIDE = 4096;

export const SceneInputSchema = z.object({
  name: z.string().regex(SAFE_NAME),
  outputDir: z.string().min(1),
  width: z.int().min(1).max(MAX_SCENE_SIDE),
  height: z.int().min(1).max(MAX_SCENE_SIDE),
  sky: z.union([hexColor, z.object({ top: hexColor, bottom: hexColor })]).optional(),
  ground: z.object({
    tiles: z.array(z.string().regex(SAFE_NAME)).min(1),
    weights: z.array(z.int().nonnegative()).optional(),
    y: z.int().nonnegative().optional().describe("Top edge of the tiled ground, default 0"),
  }).optional(),
  layers: z.array(z.object({
    ...propPosition,
    x: z.int().optional(),
    repeat: z.enum(["none", "x"]).optional(),
  })).optional(),
  placements: z.array(z.object({
    ...propPosition,
    x: z.int().describe("X coordinate of the prop's bottom-center anchor"),
    flip: z.boolean().optional(),
    z: z.int().min(-4094).max(4096).optional().describe("Draw order override. Placements with equal z are sorted by y."),
  })).optional(),
  normalMap: z.boolean().optional(),
});

export type SceneInput = z.infer<typeof SceneInputSchema>;

/** Same integer hash as the procedural art: reproducible "random" tile variation. */
function hash(x: number, y: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

function flipH(img: RgbaImage): RgbaImage {
  const out = createImage(img.width, img.height);
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const s = (y * img.width + x) * 4;
      out.data.set(img.data.subarray(s, s + 4), (y * img.width + (img.width - 1 - x)) * 4);
    }
  return out;
}

/** Draws `src` onto `dst` at (dx, dy) with source-over blending, clipped to `dst`. */
function drawAt(dst: RgbaImage, src: RgbaImage, dx: number, dy: number) {
  const x0 = Math.max(0, dx);
  const y0 = Math.max(0, dy);
  const x1 = Math.min(dst.width, dx + src.width);
  const y1 = Math.min(dst.height, dy + src.height);
  if (x1 <= x0 || y1 <= y0) return;
  const patch = createImage(x1 - x0, y1 - y0);
  const under = createImage(x1 - x0, y1 - y0);
  for (let y = y0; y < y1; y++) {
    const row = dst.data.subarray((y * dst.width + x0) * 4, (y * dst.width + x1) * 4);
    under.data.set(row, (y - y0) * under.width * 4);
    const from = ((y - dy) * src.width + (x0 - dx)) * 4;
    patch.data.set(src.data.subarray(from, from + (x1 - x0) * 4), (y - y0) * patch.width * 4);
  }
  compositeOver(under, patch);
  for (let y = y0; y < y1; y++) dst.data.set(under.data.subarray((y - y0) * under.width * 4, (y - y0 + 1) * under.width * 4), (y * dst.width + x0) * 4);
}

/** Copies normals of opaque source pixels (alpha >= 128) into `dst` at (dx, dy). */
function stampNormals(dst: RgbaImage, normals: RgbaImage, dx: number, dy: number) {
  for (let y = 0; y < normals.height; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < normals.width; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= dst.width) continue;
      const s = (y * normals.width + x) * 4;
      if (normals.data[s + 3]! >= 128) dst.data.set([normals.data[s]!, normals.data[s + 1]!, normals.data[s + 2]!, 255], (ty * dst.width + tx) * 4);
    }
  }
}

export function composeScene(lib: PropsLibrary, input: SceneInput) {
  input = SceneInputSchema.parse(input);
  const { width: W, height: H } = input;

  const used = new Set<string>();
  const getProp = (id: string) => {
    const p = own(lib.props, id);
    if (!p) throw new Error(`Unknown prop "${id}". Use list_scene_props to see available props.`);
    used.add(id);
    return p;
  };
  // Decoded + recolored prop images, cached per (prop, palette).
  const cache = new Map<string, RgbaImage>();
  const image = (id: string, palette?: string): RgbaImage => {
    const key = JSON.stringify([id, palette]);
    if (cache.has(key)) return cache.get(key)!;
    const prop = getProp(id);
    let img = readPng(prop.path);
    const ch = channelOf(lib, prop);
    const variant = palette ?? ch?.default;
    if (palette && !ch) throw new Error(`Prop "${id}" (${prop.category}) cannot be recolored`);
    if (ch && variant) {
      const family = lib.families[ch.family]!;
      const target = Object.hasOwn(family.variants, variant) ? family.variants[variant] : undefined;
      if (!target) throw new Error(`Unknown palette "${variant}" for prop "${id}". Available: ${Object.keys(family.variants).join(", ")}`);
      img = ch.mode === "gradient" ? gradientMap(img, family.source, target) : swapPalette(img, family.source, target);
    }
    cache.set(key, img);
    return img;
  };
  const assetNames = new Map<string, string>();
  const assetName = (role: "layer" | "object", id: string, palette?: string) => {
    const ch = channelOf(lib, getProp(id));
    const variant = palette ?? ch?.default;
    const key = JSON.stringify([role, id, variant]);
    let name = assetNames.get(key);
    if (!name) {
      name = `${role}_${assetNames.size + 1}_${id}`;
      assetNames.set(key, name);
    }
    return name;
  };

  // 1. Background: sky + ground tiles (baked into one image).
  const tiles = input.ground?.tiles.map((id) => image(id)) ?? [];
  const weights = input.ground?.weights ?? tiles.map(() => 1);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const tile = tiles[0];
  if (tile) {
    if (weights.length !== tiles.length || totalWeight < 1 || totalWeight > 0x100000000) {
      throw new Error("ground.weights must give one weight per tile, with a total between 1 and 4294967296");
    }
    if (tiles.some((img) => img.width !== tile.width || img.height !== tile.height)) {
      throw new Error("All ground tiles must have the same dimensions");
    }
  }
  const background = createImage(W, H);
  if (input.sky) {
    const [top, bottom] = typeof input.sky === "string" ? [input.sky, input.sky] : [input.sky.top, input.sky.bottom];
    const a = parseHex(top);
    const b = parseHex(bottom);
    for (let y = 0; y < H; y++) {
      const t = H > 1 ? y : 0;
      const d = Math.max(H - 1, 1);
      const c: Rgb = [0, 1, 2].map((i) => ((a[i]! * (d - t) + b[i]! * t + (d >> 1)) / d) | 0) as unknown as Rgb;
      for (let x = 0; x < W; x++) background.data.set([c[0], c[1], c[2], 255], (y * W + x) * 4);
    }
  }
  if (tile) {
    const { width: tw, height: th } = tile;
    const groundY = input.ground?.y ?? 0;
    for (let cy = 0; groundY + cy * th < H; cy++)
      for (let cx = 0; cx * tw < W; cx++) {
        let pick = hash(cx, cy) % totalWeight;
        let i = 0;
        while (pick >= weights[i]!) pick -= weights[i++]!;
        drawAt(background, tiles[i]!, cx * tw, groundY + cy * th);
      }
  }

  // Encode the background now and draw the scene into the same buffer (saves a full W×H copy).
  const backgroundPng = encodePng(background);
  const scene = background;
  const normals = input.normalMap ? createImage(W, H) : null;
  if (normals) {
    const flat = [128, 128, 255, 255];
    for (let i = 0; i < normals.data.length; i += 4) normals.data.set(flat, i);
  }

  // 2. Backdrop layers in the given order.
  const layerNodes: TscnSpec["layers"] = [];
  for (const l of input.layers ?? []) {
    const img = image(l.prop, l.palette);
    const x = l.x ?? 0;
    const top = l.y - img.height;
    const repeat = l.repeat === "x";
    const phase = ((-x % img.width) + img.width) % img.width;
    if (repeat) {
      for (let px = -phase; px < W; px += img.width) drawAt(scene, img, px, top);
    } else drawAt(scene, img, x, top);
    layerNodes.push({ asset: assetName("layer", l.prop, l.palette), x: repeat ? 0 : x, y: top, w: W, h: img.height, repeat, phase });
  }

  // 3. Objects, depth-sorted: z, then baseline y, then x, then input order.
  const placements = (input.placements ?? []).map((p, i) => ({ ...p, i })).sort((a, b) => (a.z ?? 0) - (b.z ?? 0) || a.y - b.y || a.x - b.x || a.i - b.i);
  const normalCache = new Map<string, RgbaImage>();
  const normalOf = (id: string, palette?: string) => {
    const key = JSON.stringify([id, palette]);
    if (!normalCache.has(key)) {
      const img = image(id, palette);
      normalCache.set(key, generateNormalMap(img, { frameWidth: img.width, frameHeight: img.height }));
    }
    return normalCache.get(key)!;
  };
  // Contact shadows go on the ground first, so no shadow ever darkens another object.
  const shadowNodes: TscnSpec["shadows"] = [];
  const shadowImages = new Map<string, RgbaImage>();
  for (const p of placements) {
    const prop = getProp(p.prop);
    if (!lib.manifest.categories.find((c) => c.id === prop.category)?.contactShadow) continue;
    const shadow = contactShadow(prop.width);
    const asset = `shadow_w${prop.width}`;
    shadowImages.set(asset, shadow.image);
    drawAt(scene, shadow.image, p.x + shadow.ox, p.y + shadow.oy);
    shadowNodes.push({ asset, x: p.x, y: p.y, ox: shadow.ox, oy: shadow.oy });
  }

  const objectNodes: { asset: string; x: number; y: number; ox: number; oy: number; flip: boolean; z: number }[] = [];
  for (const p of placements) {
    const base = image(p.prop, p.palette);
    const img = p.flip ? flipH(base) : base;
    const ox = -Math.floor(img.width / 2);
    const oy = -img.height;
    drawAt(scene, img, p.x + ox, p.y + oy);
    if (normals) {
      const n = normalOf(p.prop, p.palette);
      stampNormals(normals, p.flip ? flipNormals(n) : n, p.x + ox, p.y + oy);
    }
    objectNodes.push({ asset: assetName("object", p.prop, p.palette), x: p.x, y: p.y, ox, oy, flip: !!p.flip, z: p.z ?? 0 });
  }

  // 4. Files: baked scene, Godot scene + its assets, credits.
  const outputDir = resolve(input.outputDir);
  const assetsDir = join(outputDir, `${input.name}_assets`);
  mkdirSync(assetsDir, { recursive: true });
  const pngPath = join(outputDir, `${input.name}.png`);
  const pngBytes = encodePng(scene);
  writeFileSync(pngPath, pngBytes);
  let normalPath: string | null = null;
  if (normals) {
    normalPath = join(outputDir, `${input.name}_normal.png`);
    writeFileSync(normalPath, encodePng(normals));
  }

  const assetFiles = new Map<string, { png: string; normal: string | null }>();
  const writeAsset = (asset: string, img: RgbaImage | Uint8Array, withNormal: RgbaImage | null) => {
    if (assetFiles.has(asset)) return;
    const png = join(assetsDir, `${asset}.png`);
    writeFileSync(png, img instanceof Uint8Array ? img : encodePng(img));
    let normal: string | null = null;
    if (withNormal) {
      normal = join(assetsDir, `${asset}_normal.png`);
      writeFileSync(normal, encodePng(withNormal));
    }
    assetFiles.set(asset, { png, normal });
  };
  writeAsset("background", backgroundPng, null);
  for (const l of input.layers ?? []) writeAsset(assetName("layer", l.prop, l.palette), image(l.prop, l.palette), null);
  for (const p of placements) writeAsset(assetName("object", p.prop, p.palette), image(p.prop, p.palette), normals ? normalOf(p.prop, p.palette) : null);
  for (const [asset, img] of shadowImages) writeAsset(asset, img, null);

  const tscnPath = join(outputDir, `${input.name}.tscn`);
  writeFileSync(
    tscnPath,
    buildSceneTscn({
      name: input.name,
      pixelArt: lib.manifest.pixelArt,
      res: (path) => godotResourcePath(path, outputDir),
      assets: assetFiles,
      layers: layerNodes,
      shadows: shadowNodes,
      objects: objectNodes,
    }),
  );

  // Palette variants each prop was drawn with (explicit or the category default), for the "Changes" note.
  const variantsUsed = new Map<string, Set<string>>();
  for (const use of [...(input.layers ?? []), ...(input.placements ?? []), ...(input.ground?.tiles ?? []).map((prop) => ({ prop, palette: undefined }))]) {
    const variant = use.palette ?? channelOf(lib, lib.props[use.prop]!)?.default;
    if (!variant) continue;
    if (!variantsUsed.has(use.prop)) variantsUsed.set(use.prop, new Set());
    variantsUsed.get(use.prop)!.add(variant);
  }
  // Parts sharing one attribution (packs usually have a single default credit) are listed together.
  const credits = groupCredits(
    [...used]
      .sort(byCodeUnit)
      .filter((id) => lib.credits[id])
      .map((id) => {
        const variants = [...(variantsUsed.get(id) ?? [])].sort(byCodeUnit);
        return {
          part: `${lib.props[id]!.category}/${id}`,
          credit: lib.credits[id]!,
          modified: `${variants.length ? `recolored (${variants.join(", ")}) and ` : ""}placed into ${input.name}.png by godot-sprite-mcp`,
        };
      }),
  );
  let creditsPath: string | null = null;
  if (credits.length) {
    creditsPath = join(outputDir, `${input.name}_CREDITS.md`);
    writeFileSync(creditsPath, buildCreditsMarkdown(input.name, `${input.name}.png`, credits));
  }

  return {
    library: lib.id,
    pngPath,
    tscnPath,
    normalPath,
    creditsPath,
    assetsDir,
    width: W,
    height: H,
    layers: layerNodes.length,
    objects: objectNodes.length,
    propsUsed: [...used].sort(byCodeUnit),
    licenses: [...new Set(credits.flatMap((c) => c.licenses))],
    sha256: createHash("sha256").update(pngBytes).digest("hex"),
  };
}

/** Mirrors a normal map horizontally (pixels and the X component). */
function flipNormals(n: RgbaImage): RgbaImage {
  const out = flipH(n);
  for (let i = 0; i < out.data.length; i += 4) out.data[i] = 255 - out.data[i]!;
  return out;
}

/** Peak opacity and tint of contact shadows (cool, dark green so they read as shade on grass). */
const SHADOW_ALPHA = 120;
const SHADOW_RGB: Rgb = [24, 36, 30];

/**
 * Soft elliptical ground shadow for a prop of the given width, centred slightly
 * behind its bottom-centre anchor. Falloff is (1 - d²)², multiplication only, so the
 * image is identical on every platform.
 */
export function contactShadow(propWidth: number) {
  const rx = Math.max(4, Math.round(propWidth * 0.46));
  const ry = Math.max(2, Math.round(propWidth * 0.13));
  const image = createImage(rx * 2 + 1, ry * 2 + 1);
  for (let y = -ry; y <= ry; y++)
    for (let x = -rx; x <= rx; x++) {
      const d2 = (x * x) / (rx * rx) + (y * y) / (ry * ry);
      if (d2 >= 1) continue;
      const q = 1 - d2;
      image.data.set([SHADOW_RGB[0], SHADOW_RGB[1], SHADOW_RGB[2], Math.round(SHADOW_ALPHA * q * q)], ((y + ry) * image.width + x + rx) * 4);
    }
  // Centre sits 40% of the shadow's height above the anchor: mostly under the prop, peeking out in front.
  return { image, ox: -rx, oy: -ry - Math.round(ry * 0.4) };
}

interface TscnSpec {
  name: string;
  pixelArt: boolean;
  res: (path: string) => string;
  assets: Map<string, { png: string; normal: string | null }>;
  layers: { asset: string; x: number; y: number; w: number; h: number; repeat: boolean; phase: number }[];
  shadows: { asset: string; x: number; y: number; ox: number; oy: number }[];
  objects: { asset: string; x: number; y: number; ox: number; oy: number; flip: boolean; z: number }[];
}

const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * Godot 4 scene: a baked Background sprite, a Backdrop node with one Sprite2D per
 * layer (repeating layers use texture_repeat + region), and a y-sorted Objects
 * node with one Sprite2D per placement, anchored at its bottom-centre. With
 * normal maps, objects use CanvasTextures so Light2D nodes shade them.
 */
export function buildSceneTscn(spec: TscnSpec): string {
  const ext: string[] = [];
  const sub: string[] = [];
  const texRef = new Map<string, string>();
  let n = 0;
  for (const [asset, files] of spec.assets) {
    const id = `${++n}_${asset}`;
    ext.push(`[ext_resource type="Texture2D" path=${q(spec.res(files.png))} id=${q(id)}]`);
    if (files.normal) {
      const nid = `${++n}_${asset}_normal`;
      ext.push(`[ext_resource type="Texture2D" path=${q(spec.res(files.normal))} id=${q(nid)}]`);
      const cid = `CanvasTexture_${asset}`;
      sub.push(
        `[sub_resource type="CanvasTexture" id=${q(cid)}]`,
        `diffuse_texture = ExtResource(${q(id)})`,
        `normal_texture = ExtResource(${q(nid)})`,
        "",
      );
      texRef.set(asset, `SubResource(${q(cid)})`);
    } else texRef.set(asset, `ExtResource(${q(id)})`);
  }
  const subCount = sub.filter((l) => l.startsWith("[sub_resource")).length;
  const out: string[] = [`[gd_scene load_steps=${ext.length + subCount + 1} format=3]`, "", ...ext, ""];
  out.push(...sub);
  out.push(`[node name=${q(spec.name)} type="Node2D"]`);
  out.push(`texture_filter = ${spec.pixelArt ? 1 : 2}`);
  out.push("");
  out.push(`[node name="Background" type="Sprite2D" parent="."]`, "z_index = -4096", `texture = ${texRef.get("background")}`, "centered = false", "");
  out.push(`[node name="Backdrop" type="Node2D" parent="."]`, "z_index = -4095", "");
  spec.layers.forEach((l, i) => {
    out.push(`[node name=${q(`Layer${i + 1}_${l.asset}`)} type="Sprite2D" parent="Backdrop"]`);
    if (l.repeat) out.push("texture_repeat = 2");
    out.push(`position = Vector2(${l.x}, ${l.y})`, `texture = ${texRef.get(l.asset)}`, "centered = false");
    if (l.repeat) out.push("region_enabled = true", `region_rect = Rect2(${l.phase}, 0, ${l.w}, ${l.h})`);
    out.push("");
  });
  if (spec.shadows.length) {
    out.push(`[node name="Shadows" type="Node2D" parent="."]`, "z_index = -4094", "");
    spec.shadows.forEach((sh, i) => {
      out.push(`[node name=${q(`Shadow${i + 1}`)} type="Sprite2D" parent="Shadows"]`, `position = Vector2(${sh.x}, ${sh.y})`, `texture = ${texRef.get(sh.asset)}`, "centered = false", `offset = Vector2(${sh.ox}, ${sh.oy})`, "");
    });
  }
  out.push(`[node name="Objects" type="Node2D" parent="."]`, "y_sort_enabled = true", "");
  spec.objects.forEach((o, i) => {
    out.push(`[node name=${q(`${o.asset}_${i + 1}`)} type="Sprite2D" parent="Objects"]`);
    if (o.z) out.push(`z_index = ${o.z}`);
    out.push(`position = Vector2(${o.x}, ${o.y})`, `texture = ${texRef.get(o.asset)}`, "centered = false", `offset = Vector2(${o.ox}, ${o.oy})`);
    if (o.flip) out.push("flip_h = true");
    out.push("");
  });
  return out.join("\n");
}
