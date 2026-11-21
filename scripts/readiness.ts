#!/usr/bin/env bun
/**
 * End-to-end readiness check. Calls every MCP tool over real stdio for each library
 * and the main option combinations, writes everything into one Godot project, then
 * (when Godot is available) imports it headless and loads every generated resource
 * with scripts/readiness_verify.gd.
 *
 *   bun run readiness [--out out/readiness] [--godot <path>] [--skip-buildings]
 *
 * Writes <out>/report.json and <out>/preview.png; exits non-zero if anything failed.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createImage, readPng, writePng, type RgbaImage } from "../src/image.ts";

const ROOT = resolve(import.meta.dir, "..");
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { out: { type: "string" }, godot: { type: "string" }, "skip-buildings": { type: "boolean" } },
});
const OUT = resolve(values.out ?? join(ROOT, "out", "readiness"));
const PROJECT = join(OUT, "godot");
const GODOT = values.godot ?? process.env.GODOT_BIN ?? (existsSync("/Applications/Godot.app/Contents/MacOS/Godot") ? "/Applications/Godot.app/Contents/MacOS/Godot" : Bun.which("godot"));

type Case = { id: string; tool: string; args: Record<string, unknown>; preview?: (r: any) => string | undefined };
const at = (dir: string) => join(PROJECT, dir);

const CASES: Case[] = [
  // Sprite libraries: layered parts, palette channels, normal maps.
  { id: "characters_default", tool: "compose_character_sprite", args: { name: "placeholder", parts: { hair: "short", shirt: "tshirt", pants: "trousers" }, outputDir: at("characters") }, preview: (r) => r.pngPath },
  {
    id: "lpc_male_knight_normal", tool: "compose_character_sprite",
    args: { library: "lpc_male", name: "knight", parts: { feet: "boots", legs: "pants", torso: "longsleeve", hair: "plain" }, palettes: { body: "light", torso: "navy", legs: "charcoal", "head.eyes": "blue" }, outputDir: at("characters"), normalMap: true },
    preview: (r) => r.pngPath,
  },
  {
    id: "lpc_female_mage", tool: "compose_character_sprite",
    args: { library: "lpc_female", name: "mage", parts: { feet: "shoes", legs: "skirt", torso: "longsleeve", hair: "long_straight" }, palettes: { body: "amber", torso: "lavender", hair: "platinum", "head.eyes": "purple" }, outputDir: at("characters") },
    preview: (r) => r.pngPath,
  },
  {
    id: "hd_imp_normal", tool: "compose_character_sprite",
    args: { library: "hd_creatures", name: "imp", parts: { horns: "horn1", wing_back: "wing1", wing_front: "wing1", hair: "hair3" }, palettes: { body: "demon", horns: "obsidian", wing_back: "bat" }, outputDir: at("characters"), normalMap: true },
    preview: (r) => r.pngPath,
  },
  { id: "hd_hero", tool: "compose_character_sprite", args: { library: "hd_creatures", name: "hero", parts: { hair: "hair1", weapon: "weapon1" }, palettes: { hair: "blonde" }, outputDir: at("characters") }, preview: (r) => r.pngPath },
  { id: "procedural_building", tool: "compose_character_sprite", args: { library: "buildings", name: "proc_house", parts: { chimney: "brick", windows: "square" }, outputDir: at("characters") } },
  // Scene composition with tiles, backdrop, depth sorting, shadows and normals.
  {
    id: "village_scene", tool: "compose_scene",
    args: {
      name: "village_square", outputDir: at("scenes"), width: 1280, height: 720,
      sky: { top: "#8fc3e8", bottom: "#dcefd8" },
      ground: { tiles: ["grass", "grass_flowers"], weights: [4, 1], y: 170 },
      layers: [{ prop: "hills", y: 200, x: 0, repeat: "x" }],
      placements: [
        { prop: "church", x: 330, y: 470 }, { prop: "tavern", x: 760, y: 560 }, { prop: "cottage", x: 1110, y: 430 },
        { prop: "pine_tree", x: 70, y: 330 }, { prop: "apple_tree", x: 150, y: 660, flip: true }, { prop: "autumn_oak", x: 1210, y: 600 },
        { prop: "bush", x: 480, y: 610 }, { prop: "rocks", x: 260, y: 690 }, { prop: "snowy_pine", x: 1240, y: 300 },
      ],
      normalMap: true,
    },
    preview: (r) => r.pngPath,
  },
  // Image utilities on generated output.
  { id: "normal_map_tool", tool: "generate_normal_map", args: { inputPath: at("characters/knight.png"), outputPath: at("tools/knight_normal_tool.png"), frameWidth: 64, frameHeight: 64 } },
  { id: "normalize_tool", tool: "normalize_pixel_art", args: { library: "lpc_male", inputPath: at("characters/imp.png"), targetWidth: 512, targetHeight: 384, paletteId: "all", outputPath: at("tools/imp_normalized.png") }, preview: (r) => r.outputPath },
];

const BUILDINGS: Case[] = [
  { id: "house_glb_normal", tool: "generate_building_asset", args: { building: "house", name: "house", normalMap: true, glb: true, outputDir: at("buildings") }, preview: (r) => pngOf(r) },
  { id: "inn", tool: "generate_building_asset", args: { building: "inn", name: "inn", outputDir: at("buildings") }, preview: (r) => pngOf(r) },
  { id: "church_left", tool: "generate_building_asset", args: { building: "church", tower: "left", name: "church_left", outputDir: at("buildings") }, preview: (r) => pngOf(r) },
  { id: "church_right", tool: "generate_building_asset", args: { building: "church", tower: "right", name: "church_right", outputDir: at("buildings") } },
  { id: "chapel_no_tower", tool: "generate_building_asset", args: { building: "church", tower: "none", name: "chapel", outputDir: at("buildings") }, preview: (r) => pngOf(r) },
  { id: "kegs", tool: "generate_building_asset", args: { building: "kegs", name: "kegs", outputDir: at("buildings") } },
  { id: "inn_ground_interior", tool: "generate_building_asset", args: { building: "inn", interior: "ground", name: "inn_ground", normalMap: true, outputDir: at("buildings") }, preview: (r) => pngOf(r) },
  { id: "inn_upper_interior", tool: "generate_building_asset", args: { building: "inn", interior: "upper", name: "inn_upper", outputDir: at("buildings") }, preview: (r) => pngOf(r) },
];

function pngOf(result: any): string | undefined {
  const files: string[] = Object.values(result?.artifacts ?? result?.files ?? {}).flatMap((v: any) => (typeof v === "string" ? [v] : []));
  return files.find((f) => f.endsWith(".png") && !/normal|layer/.test(f)) ?? (typeof result?.pngPath === "string" ? result.pngPath : undefined);
}

function parse(result: any) {
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find((c: any) => c.type === "text")?.text;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(PROJECT, { recursive: true });
  writeFileSync(join(PROJECT, "project.godot"), 'config_version=5\n\n[application]\nconfig/name="godot-sprite-mcp readiness"\n');
  copyFileSync(join(import.meta.dir, "readiness_verify.gd"), join(PROJECT, "readiness_verify.gd"));

  const client = new Client({ name: "readiness", version: "1" });
  await client.connect(new StdioClientTransport({ command: "bun", args: [join(ROOT, "src", "cli.ts"), "serve"], stderr: "pipe" }));
  const { tools } = await client.listTools();
  const results: { id: string; tool: string; ok: boolean; ms: number; message?: string; preview?: string }[] = [];
  const cases = [...CASES, ...(values["skip-buildings"] ? [] : BUILDINGS)];
  for (const c of cases) {
    const started = performance.now();
    let entry: (typeof results)[number];
    try {
      const raw = await client.callTool({ name: c.tool, arguments: c.args }, undefined, { timeout: 600_000 });
      const data = parse(raw);
      entry = { id: c.id, tool: c.tool, ok: !raw.isError, ms: 0, ...(raw.isError ? { message: String(data.message ?? JSON.stringify(data)).slice(0, 400) } : {}), preview: raw.isError ? undefined : c.preview?.(data) };
    } catch (e) {
      entry = { id: c.id, tool: c.tool, ok: false, ms: 0, message: e instanceof Error ? e.message : String(e) };
    }
    entry.ms = Math.round(performance.now() - started);
    results.push(entry);
    console.log(`${entry.ok ? "PASS" : "FAIL"} ${c.id.padEnd(24)} ${String(entry.ms).padStart(6)} ms${entry.message ? `  ${entry.message}` : ""}`);
  }
  await client.close();

  let godot: { ran: boolean; ok?: boolean; summary?: unknown; log?: string } = { ran: false };
  if (GODOT && existsSync(GODOT)) {
    const imported = Bun.spawnSync([GODOT, "--headless", "--path", PROJECT, "--import"], { stdout: "pipe", stderr: "pipe" });
    const verify = Bun.spawnSync([GODOT, "--headless", "--path", PROJECT, "--script", "res://readiness_verify.gd"], { stdout: "pipe", stderr: "pipe" });
    const log = `${imported.stdout}${imported.stderr}\n----- verify -----\n${verify.stdout}${verify.stderr}`;
    writeFileSync(join(OUT, "godot.log"), log);
    const line = log.split("\n").find((l) => l.startsWith("READINESS_RESULT "));
    const summary = line ? JSON.parse(line.slice("READINESS_RESULT ".length)) : null;
    godot = { ran: true, ok: verify.exitCode === 0 && !!summary && summary.failed.length === 0, summary };
    console.log(`Godot import exit ${imported.exitCode}, verify exit ${verify.exitCode}: ${summary ? `${summary.loaded} resources loaded, ${summary.failed.length} failed` : "no result line (see godot.log)"}`);
    for (const f of summary?.failed ?? []) console.log(`  GODOT FAIL ${f}`);
  } else console.log("Godot not found: skipped engine verification (pass --godot or set GODOT_BIN)");

  writePreview(results.flatMap((r) => (r.preview && existsSync(r.preview) ? [r.preview] : [])));
  const report = { tools: tools.map((t) => t.name), cases: results, godot };
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2) + "\n");
  const failed = results.filter((r) => !r.ok).length + (godot.ran && !godot.ok ? 1 : 0);
  console.log(`\n${results.length - results.filter((r) => !r.ok).length}/${results.length} tool calls passed; report: ${join(OUT, "report.json")}`);
  process.exit(failed ? 1 : 0);
}

/** Contact sheet of the first frame/region of each generated image (fitted into 256px cells). */
function writePreview(files: string[]) {
  const CELL = 256;
  const cols = 4;
  const sheet = createImage(cols * CELL, Math.ceil(files.length / cols) * CELL || CELL);
  for (let i = 0; i < sheet.data.length; i += 4) sheet.data.set([232, 234, 228, 255], i);
  files.forEach((file, n) => {
    const img: RgbaImage = readPng(file);
    // Character sheets: show the first frame (the sheet's top-left cell) if the image is a grid.
    const frame = /characters\//.test(file) ? Math.min(img.width, img.height, file.includes("imp") || file.includes("hero") ? 256 : 64) : Math.max(img.width, img.height);
    const w = /characters\//.test(file) ? frame : img.width;
    const h = /characters\//.test(file) ? (file.includes("imp") || file.includes("hero") ? Math.min(368, img.height) : frame) : img.height;
    const scale = Math.min(CELL / w, CELL / h);
    const ox = (n % cols) * CELL + Math.floor((CELL - w * scale) / 2);
    const oy = Math.floor(n / cols) * CELL + Math.floor((CELL - h * scale) / 2);
    for (let y = 0; y < Math.floor(h * scale); y++)
      for (let x = 0; x < Math.floor(w * scale); x++) {
        const si = (Math.floor(y / scale) * img.width + Math.floor(x / scale)) * 4;
        const a = img.data[si + 3]! / 255;
        const di = ((oy + y) * sheet.width + ox + x) * 4;
        for (let c = 0; c < 3; c++) sheet.data[di + c] = Math.round(img.data[si + c]! * a + sheet.data[di + c]! * (1 - a));
      }
  });
  writePng(join(OUT, "preview.png"), sheet);
}

await main();
