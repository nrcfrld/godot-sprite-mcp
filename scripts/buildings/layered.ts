import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createImage, readPng, writePng, type RgbaImage } from "../../src/image.ts";
import { generateNormalMap } from "../../src/normal.ts";
import { godotResourcePath } from "../../src/tres.ts";
import { GeometrySchema, prepareGeometry, type GeometryScene } from "./geometry_export.ts";

const id = z.string().regex(/^[a-z][a-z0-9_]*$/);
const coordinate = z.tuple([z.number(), z.number()]);
const renderLayout = z.looseObject({
  screenMarkers: z.record(id, coordinate),
  geometry: GeometrySchema.optional(),
  layers: z.array(z.object({
    id,
    layer: z.enum(["shell", "floor", "ysort"]),
    anchor: coordinate,
  })).min(1),
});

type Layer = z.infer<typeof renderLayout>["layers"][number] & {
  png: string;
  normal: string | null;
  offset: [number, number];
};

export function cropLayer(image: RgbaImage) {
  let left = image.width;
  let top = image.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (!image.data[(y * image.width + x) * 4 + 3]) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left) throw new Error("Sprite layer has no visible pixels");
  const cropped = createImage(right - left + 1, bottom - top + 1);
  for (let y = 0; y < cropped.height; y++) {
    const start = ((top + y) * image.width + left) * 4;
    cropped.data.set(image.data.subarray(start, start + cropped.width * 4), y * cropped.width * 4);
  }
  return { image: cropped, left, top };
}

function vector([x, y]: [number, number]) {
  return `Vector2(${x}, ${y})`;
}

export function buildLayeredScene(
  name: string, layers: Layer[], markers: Record<string, [number, number]>, resourcePath: (file: string) => string,
  geometry?: GeometryScene,
) {
  const resources: string[] = [];
  const textures: string[] = [];
  const nodes: string[] = [];
  for (const layer of layers) {
    const albedoId = `${layer.id}_albedo`;
    resources.push(`[ext_resource type="Texture2D" path=${JSON.stringify(resourcePath(layer.png))} id="${albedoId}"]`);
    let texture = `ExtResource("${albedoId}")`;
    if (layer.normal) {
      const normalId = `${layer.id}_normal`;
      const canvasId = `${layer.id}_canvas`;
      resources.push(`[ext_resource type="Texture2D" path=${JSON.stringify(resourcePath(layer.normal))} id="${normalId}"]`);
      textures.push(
        `[sub_resource type="CanvasTexture" id="${canvasId}"]`,
        `diffuse_texture = ExtResource("${albedoId}")`,
        `normal_texture = ExtResource("${normalId}")`,
        "",
      );
      texture = `SubResource("${canvasId}")`;
    }
    nodes.push(
      `[node name="${layer.id}" type="Sprite2D" parent="${layer.layer === "ysort" ? "YSort" : "."}"]`,
      `position = ${vector(layer.anchor)}`,
      ...(layer.layer === "shell" ? ["z_index = -2"] : layer.layer === "floor" ? ["z_index = -1"] : []),
      `texture = ${texture}`,
      "centered = false",
      `offset = ${vector(layer.offset)}`,
      "",
    );
  }
  for (const [marker, position] of Object.entries(markers)) {
    nodes.push(`[node name="${marker}" type="Marker2D" parent="Markers"]`, `position = ${vector(position)}`, "");
  }
  if (geometry) resources.push(geometry.resource);
  const count = resources.length + layers.filter((layer) => layer.normal).length + 1;
  return [
    `[gd_scene load_steps=${count} format=3]`, "", ...resources, "", ...textures,
    `[node name="${name}" type="Node2D"]`, "texture_filter = 2", "",
    '[node name="YSort" type="Node2D" parent="."]', "y_sort_enabled = true", "",
    '[node name="Markers" type="Node2D" parent="."]', "", ...nodes, ...(geometry?.nodes ?? []),
  ].join("\n");
}

export function exportLayeredInterior({
  name, renderDir, outputDir, report, normalMap, resourceDir = outputDir,
}: {
  name: string;
  renderDir: string;
  outputDir: string;
  report: unknown;
  normalMap?: boolean;
  resourceDir?: string;
}) {
  const layout = renderLayout.parse(report);
  const layerDir = join(outputDir, `${name}_layers`);
  const layers: Layer[] = layout.layers.map((entry) => {
    const png = `${entry.id}.png`;
    const full = readPng(join(renderDir, png));
    const { image, left, top } = entry.layer === "shell" ? { image: full, left: 0, top: 0 } : cropLayer(full);
    writePng(join(layerDir, png), image);
    const normal = normalMap ? `${entry.id}_normal.png` : null;
    if (normal) {
      writePng(join(layerDir, normal), generateNormalMap(image, { frameWidth: image.width, frameHeight: image.height }));
    }
    const offset: [number, number] = [
      Number((left - entry.anchor[0]).toFixed(4)),
      Number((top - entry.anchor[1]).toFixed(4)),
    ];
    return { ...entry, png, normal, offset };
  });

  const layeredLayoutPath = join(layerDir, "layout.json");
  writeFileSync(layeredLayoutPath, JSON.stringify({ ...layout, layers }, null, 2) + "\n");
  const geometry = layout.geometry
    ? prepareGeometry(outputDir, `${name}_layers/layout.json`, layout.geometry, resourceDir)
    : undefined;
  const scenePath = join(outputDir, `${name}.tscn`);
  writeFileSync(scenePath, buildLayeredScene(
    name, layers, layout.screenMarkers,
    (file) => godotResourcePath(join(resourceDir, `${name}_layers`, file), resourceDir), geometry,
  ));
  return { scenePath, layeredLayoutPath };
}
