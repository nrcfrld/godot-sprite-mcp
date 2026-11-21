import { parseArgs } from "node:util";
import { blenderExecutable, buildBuilding, BuildingInput } from "./builder.ts";

const usage = "bun run generate:building --out <dir> [--building church|inn|house|kegs] [--interior ground|upper] [--name <id>] [--tower left|right|none] [--normal-map] [--glb] [--blender <path>]";

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      out: { type: "string" },
      building: { type: "string" },
      interior: { type: "string" },
      name: { type: "string" },
      tower: { type: "string" },
      blender: { type: "string" },
      "normal-map": { type: "boolean" },
      glb: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  if (!values.out) throw new Error(usage);
  const request = BuildingInput.parse({
    building: values.building, interior: values.interior, name: values.name, tower: values.tower,
    outputDir: values.out, normalMap: values["normal-map"], glb: values.glb,
  });
  console.log(JSON.stringify(await buildBuilding(request, blenderExecutable(values.blender)), null, 2));
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
