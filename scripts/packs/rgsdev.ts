#!/usr/bin/env bun
/**
 * Imports rgsdev's "Free CC0 Modular Animated Vector Characters 2D" into
 * libraries/hd_creatures: every 2048x2048 part frame is cropped around the
 * character and box-filtered to a 256px-wide HD frame. The parts are greyscale line
 * art, so colors come from gradient-map palettes (outline, shadow, base, highlight).
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createImage, readPng, writePng } from "../../src/image.ts";
import { blit, CACHE, cropDownscale, download, resetDir, ROOT, writeJson } from "./common.ts";

const URL = "https://opengameart.org/sites/default/files/free_2d_animated_vector_game_character_sprites.zip";
const LIB = join(ROOT, "libraries", "hd_creatures");
const FRAME_W = 256;
const COLUMNS = 8;

const ANIMATIONS = [
  { src: "idle", name: "idle", frames: 6, fps: 8, loop: true },
  { src: "walk", name: "walk", frames: 8, fps: 12, loop: true },
  { src: "roll", name: "roll", frames: 5, fps: 12, loop: false },
  { src: "jumpStart", name: "jump_start", frames: 2, fps: 10, loop: false },
  { src: "jumpEnd", name: "jump_end", frames: 3, fps: 10, loop: false },
  { src: "fall", name: "fall", frames: 5, fps: 10, loop: true },
  { src: "hit", name: "hit", frames: 3, fps: 10, loop: false },
  { src: "death", name: "death", frames: 10, fps: 10, loop: false },
];

// Back to front. `channel` gives the palette family; `follow` keeps paired layers matched.
const LAYERS = [
  { id: "wing_back", src: "Right wings", channel: { family: "wing" } },
  { id: "hand_back", src: "Right hands", required: true },
  { id: "foot_back", src: "Right feet", required: true },
  { id: "body", src: "Bodies", required: true, channel: { family: "skin", default: "peach" } },
  { id: "foot_front", src: "Left feet", required: true },
  { id: "head", src: "Heads", required: true, channel: { family: "skin", default: "peach", follow: "body" } },
  { id: "eyes", src: "Eyes", required: true },
  { id: "mouth", src: "Mouths", required: true },
  { id: "hair", src: "Hairs", channel: { family: "hair", default: "brown" } },
  { id: "horns", src: "Horns", channel: { family: "horn", default: "bone" } },
  { id: "wing_front", src: "Left wings", channel: { family: "wing", follow: "wing_back" } },
  { id: "weapon", src: "Right weapons", channel: { family: "metal", default: "steel" } },
  { id: "hand_front", src: "Left hands", required: true },
] as const;

// Gradient stops measured from the art: black ink, then light greys for shading.
const SOURCE = ["#000000", "#aaaaaa", "#d2d2d2", "#ffffff"];
const ramps = (o: Record<string, string[]>) => o;
const FAMILIES = {
  skin: ramps({
    peach: ["#1c100c", "#d98e6a", "#f3b48e", "#ffdcc4"],
    tan: ["#1a0f0a", "#a8643c", "#c98551", "#e6a978"],
    brown: ["#140a06", "#6b3e25", "#8b5634", "#ab764d"],
    goblin: ["#0c160a", "#4e8a39", "#6cae4b", "#9bd870"],
    frost: ["#0a1222", "#3f72c4", "#5f93e4", "#9cc4ff"],
    arcane: ["#170a20", "#7a4bb0", "#9c6bd2", "#c9a2f4"],
    demon: ["#1f0808", "#b2382f", "#d6564a", "#f48f7c"],
    ghost: ["#141820", "#b4c2d6", "#dbe4f0", "#ffffff"],
  }),
  hair: ramps({
    black: ["#08080c", "#262836", "#3a3d52", "#5a5f7c"],
    brown: ["#140a04", "#5e3416", "#7e4a22", "#a8703c"],
    blonde: ["#2a1c06", "#c99a30", "#e8c050", "#fbe68e"],
    ginger: ["#200a04", "#b0461a", "#d86426", "#f49248"],
    pink: ["#22081a", "#d0508c", "#ee78ac", "#ffb0d4"],
    blue: ["#06102a", "#3050c8", "#4c74ec", "#88aaff"],
    white: ["#18181e", "#b8bccc", "#dde0ea", "#ffffff"],
    green: ["#061808", "#2f9a48", "#4cbc5e", "#8ee48e"],
  }),
  horn: ramps({
    bone: ["#1a160e", "#c4b490", "#e2d6b4", "#fff8e4"],
    obsidian: ["#060608", "#26232e", "#3a3646", "#5e5872"],
    gold: ["#241806", "#c08a1e", "#e6b232", "#ffe27a"],
    ruby: ["#200408", "#a0182e", "#d02c44", "#ff6e82"],
  }),
  wing: ramps({
    bat: ["#0e0612", "#4a2c5a", "#66407a", "#8c62a4"],
    angel: ["#16181e", "#c8d0e0", "#e6ecf6", "#ffffff"],
    dragon: ["#1a0604", "#9a2a18", "#c64226", "#ec7440"],
    fairy: ["#04161c", "#38b4c8", "#5cd6e4", "#a8f4fa"],
  }),
  metal: ramps({
    steel: ["#0c0e12", "#7c8698", "#a8b2c2", "#e4eaf2"],
    gold: ["#241806", "#c08a1e", "#e6b232", "#ffe27a"],
    bronze: ["#1c0e06", "#93592a", "#b87a3e", "#e2a866"],
    obsidian: ["#060608", "#26232e", "#3a3646", "#5e5872"],
  }),
};

async function main() {
  const zip = await download(URL, join(CACHE, "rgsdev.zip"));
  const src = join(CACHE, "rgsdev");
  if (!existsSync(src)) await Bun.$`unzip -q -o ${zip} -d ${src}`;
  const parts = join(src, "Free 2D Animated Vector Game Character Sprites", "Animated body parts");

  // Pass 1: union bounding box of every part in every frame, so no pose is clipped.
  const files = (layer: (typeof LAYERS)[number]) =>
    readdirSync(join(parts, layer.src))
      .filter((d) => !d.startsWith("."))
      .sort()
      .flatMap((dir) => ANIMATIONS.flatMap((a) => Array.from({ length: a.frames }, (_, f) => join(parts, layer.src, dir, `${a.src}_${f}.png`))));
  let [x0, y0, x1, y1] = [Infinity, Infinity, -1, -1];
  for (const layer of LAYERS) {
    for (const file of files(layer)) {
      const img = readPng(file);
      for (let y = 0; y < img.height; y++)
        for (let x = 0; x < img.width; x++)
          if (img.data[(y * img.width + x) * 4 + 3]! >= 8) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
    }
  }
  // Integer downscale chosen from the width; frames grow taller instead of shrinking the
  // character when a pose (e.g. death) flies high. Centred horizontally, bottom-aligned.
  const FACTOR = Math.ceil((x1 - x0 + 1) / FRAME_W);
  const FRAME_H = Math.ceil((y1 - y0 + 1) / FACTOR / 16) * 16;
  const CROP = { x: Math.floor((x0 + x1 + 1 - FACTOR * FRAME_W) / 2), y: y1 + 1 - FACTOR * FRAME_H };
  console.log(`bbox ${x0},${y0}-${x1},${y1} -> ${FRAME_W}x${FRAME_H} frames at 1/${FACTOR}, window origin ${CROP.x},${CROP.y}`);

  const frameCount = ANIMATIONS.reduce((n, a) => n + a.frames, 0);
  const rows = Math.ceil(frameCount / COLUMNS);
  resetDir(join(LIB, "assets", "parts"));

  const layers = [];
  for (const [z, layer] of LAYERS.entries()) {
    const folder = `${String(z + 1).padStart(2, "0")}_${layer.id}`;
    const dirs = readdirSync(join(parts, layer.src)).filter((d) => !d.startsWith(".")).sort();
    // "handR1" -> "hand1": paired back/front layers share part ids.
    const partId = (dir: string) => dir.replace(/[LR](?=\d+$)/, "").toLowerCase();
    const ids = dirs.map(partId);
    for (const dir of dirs) {
      const id = partId(dir);
      const sheet = createImage(COLUMNS * FRAME_W, rows * FRAME_H);
      let index = 0;
      for (const anim of ANIMATIONS) {
        for (let f = 0; f < anim.frames; f++, index++) {
          const file = join(parts, layer.src, dir, `${anim.src}_${f}.png`);
          const frame = cropDownscale(readPng(file), CROP.x, CROP.y, FRAME_W, FRAME_H, FACTOR);
          blit(sheet, frame, (index % COLUMNS) * FRAME_W, Math.floor(index / COLUMNS) * FRAME_H);
        }
      }
      writePng(join(LIB, "assets", "parts", folder, `${id}.png`), sheet);
      console.log(`  ${folder}/${id}.png`);
    }
    const ch = "channel" in layer ? layer.channel : null;
    layers.push({
      id: layer.id,
      folder,
      zIndex: z * 10,
      required: "required" in layer ? layer.required : false,
      ...(layer.id === "body" || "required" in layer ? { defaultPart: ids[0] } : {}),
      channels: ch
        ? [{ id: "main", family: ch.family, mode: "gradient", ...("default" in ch ? { default: ch.default } : {}), ...("follow" in ch ? { follow: ch.follow } : {}) }]
        : [],
    });
  }

  let start = 0;
  writeJson(join(LIB, "manifest.json"), {
    frameWidth: FRAME_W,
    frameHeight: FRAME_H,
    columns: COLUMNS,
    frameCount,
    pixelArt: false,
    layers,
    animations: ANIMATIONS.map((a) => {
      const frames = Array.from({ length: a.frames }, (_, i) => start + i);
      start += a.frames;
      return { name: a.name, frames, fps: a.fps, loop: a.loop };
    }),
  });
  writeJson(join(LIB, "assets", "palettes.json"), {
    families: Object.fromEntries(Object.entries(FAMILIES).map(([id, variants]) => [id, { source: SOURCE, variants }])),
    sets: { all: Object.keys(FAMILIES) },
  });
  writeJson(join(LIB, "assets", "credits.json"), {
    default: {
      title: "Free CC0 Modular Animated Vector Characters 2D",
      authors: ["Raphael Gonçalves (rgsdev)"],
      licenses: ["CC0"],
      urls: ["https://opengameart.org/content/free-cc0-modular-animated-vector-characters-2d"],
      changes: "frames cropped, box-filtered from 2048px to 1/5 scale and repacked into sprite sheets by godot-sprite-mcp",
    },
  });
  console.log(`hd_creatures: ${frameCount} frames, ${rows} rows`);
}

await main();
