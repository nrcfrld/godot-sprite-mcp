import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { godotResourcePath } from "../../src/tres.ts";

const point = z.tuple([z.number(), z.number()]);
export const GeometrySchema = z.object({
  version: z.literal(1),
  collision: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/),
    polygon: z.array(point).min(3),
  })),
  navigation: z.object({
    clearanceWorldUnits: z.number().nonnegative(),
    vertices: z.array(point).min(3),
    polygons: z.array(z.array(z.number().int().nonnegative()).min(3)).min(1),
  }).nullable(),
});
type Geometry = z.infer<typeof GeometrySchema>;

export function prepareGeometry(outputDir: string, layoutPath: string, geometry: Geometry, resourceDir = outputDir) {
  const target = join(outputDir, "_building_footprints.gd");
  const source = join(import.meta.dir, "footprint_importer.gd");
  if (!existsSync(target) || !readFileSync(target).equals(readFileSync(source))) {
    const staging = join(outputDir, `._building_footprints_${randomUUID()}.tmp`);
    try {
      copyFileSync(source, staging);
      renameSync(staging, target);
    } finally {
      rmSync(staging, { force: true });
    }
  }
  return {
    resource: `[ext_resource type="Script" path=${JSON.stringify(godotResourcePath(join(resourceDir, basename(target)), resourceDir))} id="building_footprints"]`,
    nodes: [
      '[node name="Geometry" type="Node2D" parent="."]',
      'script = ExtResource("building_footprints")',
      `layout_path = ${JSON.stringify(layoutPath)}`,
      `embedded_geometry = ${JSON.stringify(JSON.stringify(geometry))}`,
      "",
    ],
  };
}
export type GeometryScene = ReturnType<typeof prepareGeometry>;

export function exportExteriorScene({
  name, outputDir, framesPath, layoutPath, report, resourceDir = outputDir,
}: { name: string; outputDir: string; framesPath: string; layoutPath: string; report: unknown; resourceDir?: string }) {
  const { geometry } = z.object({ geometry: GeometrySchema }).parse(report);
  const importer = prepareGeometry(outputDir, basename(layoutPath), geometry, resourceDir);
  const scenePath = join(outputDir, `${name}.tscn`);
  writeFileSync(scenePath, [
    "[gd_scene load_steps=3 format=3]", "",
    `[ext_resource type="SpriteFrames" path=${JSON.stringify(godotResourcePath(join(resourceDir, basename(framesPath)), resourceDir))} id="exterior_frames"]`,
    importer.resource, "",
    `[node name="${name}" type="Node2D"]`, "texture_filter = 2", "",
    '[node name="Exterior" type="AnimatedSprite2D" parent="."]',
    'sprite_frames = ExtResource("exterior_frames")', 'animation = &"still"', "centered = false", "",
    ...importer.nodes,
  ].join("\n"));
  return { scenePath };
}
