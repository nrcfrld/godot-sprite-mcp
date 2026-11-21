import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export interface TresFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TresAnimation {
  name: string;
  fps: number;
  loop: boolean;
  /** Indices into `frames`. */
  frames: number[];
}

export interface SpriteFramesSpec {
  /** Path written into ext_resource (res://... or relative to the .tres file). */
  texturePath: string;
  /** Optional normal map; frames then use a CanvasTexture so 2D lights shade the sprite. */
  normalPath?: string;
  /** Texture filter baked into the CanvasTexture (only used with a normal map). */
  filter?: "nearest" | "linear";
  /** Unique atlas regions; animations reference them by index. */
  frames: TresFrame[];
  animations: TresAnimation[];
}

/** Godot always prints floats with a decimal point (1.0, 7.5). */
function godotFloat(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : String(n);
}

function godotString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Serialises a Godot 4 (format=3) SpriteFrames text resource where each frame is
 * an AtlasTexture sub-resource cut from a single sprite sheet texture.
 * Output depends only on the spec, so it is byte-for-byte reproducible.
 */
export function buildSpriteFramesTres(spec: SpriteFramesSpec): string {
  const usedFrames = [...new Set(spec.animations.flatMap((a) => a.frames))].sort((a, b) => a - b);
  for (const f of usedFrames) {
    if (!spec.frames[f]) throw new Error(`Animation references unknown frame index ${f}`);
  }
  const texId = "1_sheet";
  const normalId = "2_normal";
  const subId = (f: number) => `AtlasTexture_f${f}`;
  const extCount = spec.normalPath ? 2 : 1;
  const loadSteps = extCount + (spec.normalPath ? 1 : 0) + usedFrames.length + 1;

  const out: string[] = [];
  out.push(`[gd_resource type="SpriteFrames" load_steps=${loadSteps} format=3]`, "");
  out.push(`[ext_resource type="Texture2D" path=${godotString(spec.texturePath)} id="${texId}"]`);
  if (spec.normalPath) out.push(`[ext_resource type="Texture2D" path=${godotString(spec.normalPath)} id="${normalId}"]`);
  out.push("");
  let atlasRef = `ExtResource("${texId}")`;
  if (spec.normalPath) {
    out.push(
      `[sub_resource type="CanvasTexture" id="CanvasTexture_sheet"]`,
      `diffuse_texture = ExtResource("${texId}")`,
      `normal_texture = ExtResource("${normalId}")`,
      // CanvasItem.TextureFilter: 1 = nearest, 2 = linear.
      ...(spec.filter ? [`texture_filter = ${spec.filter === "nearest" ? 1 : 2}`] : []),
      "",
    );
    atlasRef = `SubResource("CanvasTexture_sheet")`;
  }
  for (const f of usedFrames) {
    const r = spec.frames[f]!;
    out.push(
      `[sub_resource type="AtlasTexture" id="${subId(f)}"]`,
      `atlas = ${atlasRef}`,
      `region = Rect2(${r.x}, ${r.y}, ${r.w}, ${r.h})`,
      "",
    );
  }
  const anims = spec.animations.map((a) => {
    const frames = a.frames
      .map((f) => `{\n"duration": 1.0,\n"texture": SubResource("${subId(f)}")\n}`)
      .join(", ");
    return `{\n"frames": [${frames}],\n"loop": ${a.loop},\n"name": &${godotString(a.name)},\n"speed": ${godotFloat(a.fps)}\n}`;
  });
  out.push("[resource]", `animations = [${anims.join(", ")}]`, "");
  return out.join("\n");
}

/** Walks up from `dir` looking for the Godot project root (folder containing project.godot). */
export function findGodotProjectRoot(dir: string): string | null {
  let current = resolve(dir);
  while (true) {
    if (existsSync(join(current, "project.godot"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * res:// path when the file lives inside a Godot project, otherwise a path
 * relative to the .tres (Godot 4 resolves those against the resource's folder).
 */
export function godotResourcePath(filePath: string, tresDir: string): string {
  const root = findGodotProjectRoot(tresDir);
  if (root) return "res://" + relative(root, resolve(filePath)).split(sep).join("/");
  return relative(resolve(tresDir), resolve(filePath)).split(sep).join("/");
}
