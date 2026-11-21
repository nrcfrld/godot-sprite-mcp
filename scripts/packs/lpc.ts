#!/usr/bin/env bun
/**
 * Imports a curated subset of the Universal LPC Spritesheet Character Generator
 * into libraries/lpc_male and libraries/lpc_female (64x64 pixel art, 4 directions).
 *
 * - Licensing: an item is imported only if every credit entry covering its files
 *   offers a non-copyleft license (CC0, OGA-BY or CC-BY, not CC-BY-SA/GPL). The
 *   licenses we use it under are written to assets/credits.json.
 * - Colors: LPC parts are drawn in a base palette per material (skin "light",
 *   hair "orange", cloth "white", eyes "blue"); those become indexed swap
 *   families with the official ULPC variants.
 * - Only items with a single layer and palette-based recoloring are used.
 */
import { join } from "node:path";
import { createImage, decodePng, writePng, type RgbaImage } from "../../src/image.ts";
import { blit, CACHE, download, downloadText, resetDir, ROOT, writeJson } from "./common.ts";

const REPO = "https://raw.githubusercontent.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator/master";
const CELL = 64;
const DIRECTIONS = ["up", "left", "down", "right"];
const ANIMATIONS = [
  { src: "idle", fps: 3, loop: true },
  { src: "walk", fps: 10, loop: true },
  { src: "run", fps: 12, loop: true },
  { src: "slash", fps: 12, loop: false },
  { src: "spellcast", fps: 10, loop: false },
  { src: "hurt", fps: 8, loop: false },
];
const MATERIALS: Record<string, { family: string; label: string }> = {
  body: { family: "skin", label: "Skin" },
  hair: { family: "hair", label: "Hair" },
  cloth: { family: "cloth", label: "Cloth" },
  eye: { family: "eye", label: "Eyes" },
  metal: { family: "metal", label: "Metal" },
};

type Item = [part: string, definition: string];
interface LayerSpec {
  id: string;
  required?: boolean;
  defaultPart?: string;
  items: Item[];
}

function layersFor(body: "male" | "female"): LayerSpec[] {
  const hair: Item[] = [
    "short/hair_plain", "short/hair_bangs", "short/hair_messy1", "short/hair_parted", "short/hair_pixie",
    "short/hair_swoop", "short/hair_unkempt", "short/hair_bedhead", "spiky/hair_spiked", "curly/hair_curly_short",
    "bob/hair_bob", "braids/hair_ponytail", "braids/hair_high_ponytail", "braids/hair_braid", "long/hair_long_straight",
    "long/hair_loose", "long/hair_wavy", "xlong/hair_xlong", "pigtails/hair_pigtails", "afro/hair_afro",
  ].map((p) => [p.split("/")[1]!.replace(/^hair_/, ""), `hair/${p}.json`]);
  return [
    { id: "body", required: true, defaultPart: "human", items: [["human", "body/body.json"]] },
    { id: "feet", items: [["shoes", "feet/shoes/feet_shoes_basic.json"], ["boots", "feet/boots/feet_boots_basic.json"]] },
    {
      id: "legs",
      items: [
        ["pants", "legs/pants/legs_pants.json"],
        ["formal_pants", "legs/pants/legs_formal.json"],
        ["shorts", "legs/shorts/legs_shorts.json"],
        ...(body === "female" ? ([["skirt", "legs/skirts/legs_skirts_plain.json"]] as Item[]) : []),
      ],
    },
    {
      id: "torso",
      items: [
        ["longsleeve", "torso/shirts/longsleeve/torso_clothes_longsleeve.json"],
        ["formal_shirt", "torso/shirts/longsleeve/torso_clothes_longsleeve_formal.json"],
        ["tshirt", "torso/shirts/shortsleeve/torso_clothes_tshirt.json"],
        ["sleeveless", "torso/shirts/sleeveless/torso_clothes_sleeveless.json"],
        ["vest", "torso/vest/torso_clothes_vest.json"],
      ],
    },
    { id: "jacket", items: [["collared", "torso/jacket/torso_jacket_collared.json"], ["trench", "torso/jacket/torso_jacket_trench.json"]] },
    {
      id: "head",
      required: true,
      defaultPart: `human_${body}`,
      items: [[`human_${body}`, `head/heads/human/heads_human_${body}.json`]],
    },
    { id: "beard", items: [["beard", "hair/beards/beards_beard.json"], ["trimmed", "hair/beards/beards_trimmed.json"]] },
    { id: "hair", items: hair },
  ];
}

interface Recolor {
  material: string;
}
interface Definition {
  name: string;
  layer_1?: Record<string, string | number>;
  layer_2?: unknown;
  recolors?: Recolor | Record<string, Recolor>;
  credits?: { file: string; authors: string[]; licenses: string[]; urls: string[]; notes?: string }[];
}

// Attribution-only licenses: plain CC0, OGA-BY or CC-BY followed by a version (rejects -SA, -NC, -ND).
const PERMISSIVE = /^(CC0|OGA-BY|CC-BY)( \d|$)/;
// When an entry offers several permissive options, the one we use it under (most permissive first).
const PREFERENCE = ["CC0", "CC-BY 4.0", "CC-BY 3.0", "OGA-BY 4.0", "OGA-BY 3.0"];

/**
 * Every credit entry that overlaps `path`: entries for the folder itself, any parent
 * folder (shared base art) and any sub-folder (per-file contributions). All of them
 * must allow non-copyleft use, and all their authors are credited.
 */
function creditsFor(def: Definition, path: string) {
  return (def.credits ?? []).filter((c) => {
    const f = c.file.replace(/\/$/, "");
    return path === f || path.startsWith(`${f}/`) || f.startsWith(`${path}/`);
  });
}

function chosenLicense(licenses: string[]): string {
  const ok = licenses.filter((l) => PERMISSIVE.test(l));
  return [...ok].sort((a, b) => (PREFERENCE.indexOf(a) + 1 || 99) - (PREFERENCE.indexOf(b) + 1 || 99))[0]!;
}

const defCache = new Map<string, Definition>();
async function definition(path: string): Promise<Definition> {
  if (!defCache.has(path)) {
    const text = await downloadText(`${REPO}/sheet_definitions/${path}`, join(CACHE, "lpc", "sheet_definitions", path));
    defCache.set(path, JSON.parse(text));
  }
  return defCache.get(path)!;
}

async function sheet(path: string): Promise<RgbaImage | null> {
  const dest = join(CACHE, "lpc", "spritesheets", path);
  try {
    await download(`${REPO}/spritesheets/${path}`, dest);
  } catch {
    return null;
  }
  return decodePng(new Uint8Array(await Bun.file(dest).arrayBuffer()));
}

async function palette(material: string) {
  const meta = JSON.parse(await downloadText(`${REPO}/palette_definitions/${material}/meta_${material}.json`, join(CACHE, "lpc", "palettes", `meta_${material}.json`)));
  const variants: Record<string, string[]> = JSON.parse(
    await downloadText(`${REPO}/palette_definitions/${material}/${material}_ulpc.json`, join(CACHE, "lpc", "palettes", `${material}_ulpc.json`)),
  );
  const lower = Object.fromEntries(Object.entries(variants).map(([k, v]) => [k.toLowerCase().replace(/[^a-z0-9_]/g, "_"), v.map((c) => c.toLowerCase())]));
  return { source: lower[meta.base]!, variants: lower, base: meta.base as string };
}

async function importLibrary(body: "male" | "female") {
  const id = `lpc_${body}`;
  const lib = join(ROOT, "libraries", id);
  resetDir(join(lib, "assets", "parts"));
  console.log(`== ${id}`);

  // Grid layout comes from the body sheets: one row per (animation, direction).
  const rows: { anim: string; dir: string | null; row: number; frames: number }[] = [];
  let columns = 0;
  for (const a of ANIMATIONS) {
    const img = await sheet(`body/bodies/${body}/${a.src}.png`);
    if (!img) throw new Error(`body sheet ${a.src} missing`);
    const dirs = img.height / CELL === 4 ? DIRECTIONS : [null];
    columns = Math.max(columns, img.width / CELL);
    dirs.forEach((dir, r) => rows.push({ anim: a.src, dir, row: r, frames: img.width / CELL }));
  }
  const W = columns * CELL;
  const H = rows.length * CELL;

  const families: Record<string, { label: string; source: string[]; variants: Record<string, string[]> }> = {};
  const credits: Record<string, unknown> = {};
  const layers = [];
  for (const [z, spec] of layersFor(body).entries()) {
    const folder = `${String(z + 1).padStart(2, "0")}_${spec.id}`;
    let zPos: number | null = null;
    let channels: { id: string; family: string; mode: "swap"; default?: string; follow?: string }[] | null = null;
    const imported: string[] = [];
    for (const [part, defPath] of spec.items) {
      const def = await definition(defPath);
      const path = String(def.layer_1?.[body] ?? "").replace(/\/$/, "");
      const skip = (why: string) => console.log(`  skip ${spec.id}/${part}: ${why}`);
      if (!path) { skip(`no ${body} variant`); continue; }
      if (def.layer_2) { skip("multi-layer item"); continue; }
      if (!def.recolors) { skip("no palette recoloring"); continue; }
      const covering = creditsFor(def, path);
      const blocked = covering.length === 0 || covering.some((c) => !c.licenses.some((l) => PERMISSIVE.test(l)));
      if (blocked) { skip(`license ${covering.map((c) => c.licenses.join("/")).join("; ") || "unknown"}`); continue; }

      const recolors: [string, Recolor][] =
        "material" in def.recolors ? [["main", def.recolors as Recolor]] : Object.entries(def.recolors as Record<string, Recolor>);
      const partChannels = [];
      for (const [i, [key, rc]] of recolors.entries()) {
        const m = MATERIALS[rc.material];
        if (!m) throw new Error(`unknown material ${rc.material} in ${defPath}`);
        if (!families[m.family]) {
          const p = await palette(rc.material);
          families[m.family] = { label: m.label, source: p.source, variants: p.variants };
        }
        const isSkin = m.family === "skin";
        const chId = i === 0 ? "main" : m.family === "eye" ? "eyes" : key;
        partChannels.push({
          id: chId,
          family: m.family,
          mode: "swap" as const,
          ...(isSkin && spec.id !== "body" ? { follow: "body" } : { default: defaultVariant(m.family) }),
        });
      }
      if (channels && JSON.stringify(channels) !== JSON.stringify(partChannels)) { skip("recolor channels differ from layer"); continue; }
      channels = partChannels;

      const out = createImage(W, H);
      const missing: string[] = [];
      let lastAnim = "";
      let img: RgbaImage | null = null;
      for (const [r, row] of rows.entries()) {
        if (row.anim !== lastAnim) {
          img = await sheet(`${path}/${row.anim}.png`);
          lastAnim = row.anim;
          if (!img) missing.push(row.anim);
          else if (img.width !== row.frames * CELL) { missing.push(`${row.anim}(size)`); img = null; }
        }
        if (img) blit(out, img, 0, r * CELL, 0, row.row * CELL, img.width, CELL);
      }
      if (missing.length === ANIMATIONS.length) { skip("no usable sheets"); continue; }
      writePng(join(lib, "assets", "parts", folder, `${part}.png`), out);
      zPos ??= Number(def.layer_1?.zPos ?? z * 10);
      imported.push(part);
      credits[`${spec.id}/${part}`] = {
        title: `LPC ${def.name}`,
        authors: [...new Set(covering.flatMap((c) => c.authors))],
        licenses: [...new Set(covering.map((c) => chosenLicense(c.licenses)))],
        urls: [...new Set(covering.flatMap((c) => c.urls))],
        changes: "animation sheets repacked into one 64px grid (one row per animation and direction) by godot-sprite-mcp",
        notes: [
          `Universal LPC Spritesheet Character Generator: spritesheets/${path}`,
          `original license options: ${[...new Set(covering.flatMap((c) => c.licenses))].join(", ")}`,
          ...covering.map((c) => c.notes).filter(Boolean),
          ...(missing.length ? [`animations not available: ${missing.join(", ")}`] : []),
        ].join("; "),
      };
      console.log(`  ${folder}/${part}.png${missing.length ? ` (missing ${missing.join(", ")})` : ""}`);
    }
    if (!imported.length) continue;
    layers.push({
      id: spec.id,
      folder,
      zIndex: zPos!,
      required: spec.required ?? false,
      ...(spec.defaultPart && imported.includes(spec.defaultPart) ? { defaultPart: spec.defaultPart } : {}),
      channels: channels ?? [],
    });
  }

  writeJson(join(lib, "manifest.json"), {
    frameWidth: CELL,
    frameHeight: CELL,
    columns,
    frameCount: columns * rows.length,
    pixelArt: true,
    layers,
    animations: rows.map((row, r) => {
      const a = ANIMATIONS.find((x) => x.src === row.anim)!;
      return {
        name: row.dir ? `${row.anim}_${row.dir}` : row.anim,
        frames: Array.from({ length: row.frames }, (_, i) => r * columns + i),
        fps: a.fps,
        loop: a.loop,
      };
    }),
  });
  writeJson(join(lib, "assets", "palettes.json"), {
    families,
    sets: { all: Object.keys(families) },
  });
  writeJson(join(lib, "assets", "credits.json"), { parts: credits });
}

function defaultVariant(family: string): string {
  return { skin: "light", hair: "dark_brown", cloth: "white", eye: "blue", metal: "steel" }[family] ?? "light";
}

await importLibrary("male");
await importLibrary("female");
