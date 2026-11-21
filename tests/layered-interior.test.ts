import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { exportLayeredInterior } from "../scripts/buildings/layered.ts";
import { createImage, readPng, writePng } from "../src/image.ts";
import { tempDir } from "./helpers.ts";

test("exports cropped furniture at its original position and assigns it to the player Y-sort group", () => {
  const renderDir = tempDir();
  const outputDir = tempDir();
  const image = createImage(12, 12);
  image.data.set([30, 70, 90, 255], (4 * image.width + 2) * 4);
  for (const id of ["shell", "rug", "table"]) writePng(join(renderDir, `${id}.png`), image);

  const result = exportLayeredInterior({
    name: "inn",
    renderDir,
    outputDir,
    normalMap: true,
    report: {
      screenMarkers: { entry: [3, 9] },
      geometry: {
        version: 1,
        collision: [{ id: "table", polygon: [[5, 7], [7, 7], [7, 9], [5, 9]] }],
        navigation: null,
      },
      layers: [
        { id: "shell", layer: "shell", anchor: [0, 0] },
        { id: "rug", layer: "floor", anchor: [2, 6] },
        { id: "table", layer: "ysort", anchor: [6.25, 8.5] },
      ],
    },
  });

  const layout = JSON.parse(readFileSync(result.layeredLayoutPath, "utf8"));
  const table = readPng(join(outputDir, "inn_layers", "table.png"));
  expect([table.width, table.height, ...table.data]).toEqual([1, 1, 30, 70, 90, 255]);
  expect(layout.layers[2]).toMatchObject({ anchor: [6.25, 8.5], offset: [-4.25, -4.5], normal: "table_normal.png" });

  const scene = readFileSync(result.scenePath, "utf8");
  expect(scene).toContain('[node name="YSort" type="Node2D" parent="."]\ny_sort_enabled = true');
  expect(scene).toContain('[node name="table" type="Sprite2D" parent="YSort"]\nposition = Vector2(6.25, 8.5)');
  expect(scene).toContain('[node name="rug" type="Sprite2D" parent="."]\nposition = Vector2(2, 6)\nz_index = -1');
  expect(scene).toContain('[node name="entry" type="Marker2D" parent="Markers"]\nposition = Vector2(3, 9)');
  expect(scene).toContain('[node name="Geometry" type="Node2D" parent="."]\nscript = ExtResource("building_footprints")');
  expect(scene).toContain('layout_path = "inn_layers/layout.json"');
  expect(layout.geometry.collision[0].id).toBe("table");
});
