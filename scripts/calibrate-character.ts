import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { frameRect, openLibrary } from "../src/config.ts";
import { createImage, readPng, writePng, type RgbaImage } from "../src/image.ts";
import { composeCharacterSprite } from "../src/sprite.ts";
import { godotResourcePath } from "../src/tres.ts";

const contract = z.object({
  scale: z.object({
    version: z.literal(1),
    verticalPixelsPerMeter: z.number().positive(),
    referenceActorHeightMeters: z.number().positive(),
  }),
});

function measureFeet(frame: RgbaImage) {
  let top = frame.height;
  let bottom = -1;
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      if (frame.data[(y * frame.width + x) * 4 + 3]! < 128) continue;
      top = Math.min(top, y);
      bottom = y;
    }
  }
  if (bottom < top) throw new Error("Cannot calibrate an empty actor frame");
  // LPC directions share a centered frame. Keep that horizontal origin when
  // the shape or position of the planted feet changes between animations.
  return { anchor: [frame.width / 2, bottom + 1], visibleHeight: bottom - top + 1 };
}

function main() {
  const { values } = parseArgs({ args: process.argv.slice(2), options: {
    layout: { type: "string" }, out: { type: "string" }, name: { type: "string", default: "village_actor" },
  } });
  if (!values.layout || !values.out) throw new Error("Usage: bun scripts/calibrate-character.ts --layout <building.layout.json> --out <dir>");
  const { scale } = contract.parse(JSON.parse(readFileSync(values.layout, "utf8")));
  const outputDir = resolve(values.out);
  const lib = openLibrary(undefined, "lpc_male");
  const parts = { feet: "boots", legs: "pants", torso: "longsleeve", hair: "plain" };
  const sprite = composeCharacterSprite(lib, { name: values.name, outputDir, parts });
  const sheet = readPng(sprite.pngPath);
  const animation = lib.manifest.animations.find((item) => item.name === "idle_down");
  if (!animation) throw new Error("The LPC reference library has no idle_down animation");
  const region = frameRect(lib, animation.frames[0]!);
  const frame = createImage(region.w, region.h);
  for (let y = 0; y < frame.height; y++) {
    const start = ((region.y + y) * sheet.width + region.x) * 4;
    frame.data.set(sheet.data.subarray(start, start + frame.width * 4), y * frame.width * 4);
  }
  const { anchor, visibleHeight } = measureFeet(frame);
  const expectedHeight = scale.verticalPixelsPerMeter * scale.referenceActorHeightMeters;
  const spriteScale = expectedHeight / visibleHeight;
  const referencePath = join(outputDir, `${values.name}_reference.png`);
  const calibrationPath = join(outputDir, `${values.name}.scale.json`);
  const scenePath = join(outputDir, `${values.name}.tscn`);
  writePng(referencePath, frame);
  writeFileSync(calibrationPath, JSON.stringify({
    version: 1, library: lib.id, animation: animation.name, anchor, spriteScale,
    heightMeters: scale.referenceActorHeightMeters, nativeHeightPixels: visibleHeight,
    projectedHeightPixels: expectedHeight,
  }, null, 2) + "\n");
  writeFileSync(scenePath, [
    "[gd_scene load_steps=2 format=3]", "",
    `[ext_resource type="SpriteFrames" path=${JSON.stringify(godotResourcePath(sprite.tresPath, outputDir))} id="actor_frames"]`, "",
    '[node name="CalibratedActor" type="Node2D"]', "",
    '[node name="Visual" type="AnimatedSprite2D" parent="."]',
    'sprite_frames = ExtResource("actor_frames")',
    'animation = &"idle_down"',
    "texture_filter = 1",
    "centered = false",
    `offset = Vector2(${-anchor[0]!}, ${-anchor[1]!})`,
    `scale = Vector2(${spriteScale}, ${spriteScale})`, "",
  ].join("\n"));
  console.log(JSON.stringify({ scenePath, calibrationPath, referencePath, sheet: basename(sprite.pngPath) }, null, 2));
}
try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
