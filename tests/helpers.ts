import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tempDir(prefix = "gsm-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface ParsedTres {
  header: { type: string; loadSteps: number; format: number };
  extResources: { type: string; path: string; id: string }[];
  atlases: Map<string, { atlas: string; region: [number, number, number, number] }>;
  animations: { name: string; loop: boolean; speed: number; frames: { duration: number; texture: string }[] }[];
}

/** Minimal parser for the subset of Godot's text resource format we emit. */
export function parseSpriteFramesTres(text: string): ParsedTres {
  const headerMatch = /^\[gd_resource type="(\w+)" load_steps=(\d+) format=(\d+)\]/.exec(text);
  if (!headerMatch) throw new Error("missing gd_resource header");
  const extResources = [...text.matchAll(/^\[ext_resource type="(\w+)" path="([^"]+)" id="([^"]+)"\]$/gm)].map((m) => ({
    type: m[1]!,
    path: m[2]!,
    id: m[3]!,
  }));
  const atlases = new Map<string, { atlas: string; region: [number, number, number, number] }>();
  for (const m of text.matchAll(
    /^\[sub_resource type="AtlasTexture" id="([^"]+)"\]\natlas = (?:ExtResource|SubResource)\("([^"]+)"\)\nregion = Rect2\(([^)]+)\)$/gm,
  )) {
    const region = m[3]!.split(",").map((v) => Number(v.trim())) as [number, number, number, number];
    atlases.set(m[1]!, { atlas: m[2]!, region });
  }
  const resIdx = text.indexOf("[resource]\nanimations = ");
  if (resIdx < 0) throw new Error("missing [resource] animations");
  const body = text
    .slice(resIdx + "[resource]\nanimations = ".length)
    .replace(/SubResource\("([^"]+)"\)/g, '"$1"')
    .replace(/&"/g, '"');
  return {
    header: { type: headerMatch[1]!, loadSteps: Number(headerMatch[2]), format: Number(headerMatch[3]) },
    extResources,
    atlases,
    animations: JSON.parse(body),
  };
}
