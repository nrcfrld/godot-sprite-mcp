import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import { loadAssetLibrary } from "../../src/config.ts";
import { readPng } from "../../src/image.ts";
import { composeCharacterSprite } from "../../src/sprite.ts";
import { exportExteriorScene } from "./geometry_export.ts";
import { exportLayeredInterior } from "./layered.ts";
import { publishArtifacts } from "./publish.ts";

export const BuildingOptions = z.strictObject({
  building: z.enum(["church", "inn", "house", "shop", "kegs"]).default("church"),
  interior: z.enum(["ground", "upper"]).optional(),
  tower: z.enum(["left", "right", "none"]).optional(),
  name: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
  normalMap: z.boolean().default(false),
  glb: z.boolean().default(false),
});

export const BuildingInput = BuildingOptions.extend({ outputDir: z.string().min(1) });
export type BuildingRequest = z.input<typeof BuildingInput>;

export class BuildingError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function normalizeBuilding(input: BuildingRequest) {
  const parsed = BuildingInput.safeParse(input);
  if (!parsed.success) throw new BuildingError("INVALID_INPUT", z.prettifyError(parsed.error));
  const args = parsed.data;
  if (args.interior && args.building !== "inn") throw new BuildingError("INVALID_INPUT", "Interior requires the inn template");
  if (args.tower && args.building !== "church") throw new BuildingError("INVALID_INPUT", "Tower applies to the church template");
  return {
    ...args,
    outputDir: resolve(args.outputDir),
    name: args.name ?? `village_${args.building}${args.interior ? `_${args.interior}` : ""}`,
  };
}

/**
 * Upper bound for a single Blender run (BLENDER_TIMEOUT_MS, default 10 minutes; the slowest
 * template renders in ~15 s). A hung Blender is killed instead of blocking the MCP call forever.
 */
export function blenderTimeoutMs(): number {
  const value = Number(process.env.BLENDER_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 600_000;
}

export function blenderExecutable(override?: string) {
  const app = "/Applications/Blender.app/Contents/MacOS/Blender";
  return override ?? process.env.BLENDER_BIN ?? Bun.which("blender") ?? (existsSync(app) ? app : "blender");
}

export async function buildBuilding(input: BuildingRequest, blender = blenderExecutable(), signal?: AbortSignal) {
  const { building, interior, tower, name, outputDir, normalMap, glb } = normalizeBuilding(input);
  const work = mkdtempSync(join(tmpdir(), "godot-building-"));
  let publishing: string | undefined;
  try {
    const renderPath = join(work, "assembly.png");
    const mesh = join(work, "assembly.glb");
    const metadata = join(work, "assembly.layout.json");
    let proc;
    try {
      proc = Bun.spawn([
        blender, "--background", "--factory-startup", "--python-exit-code", "1",
        "--python", join(import.meta.dir, "assemble.py"), "--",
        "--building", building, "--tower", tower ?? "left", "--output", renderPath,
        ...(interior ? ["--interior", interior] : []),
        ...(glb ? ["--glb", mesh] : []),
      ], { stdout: "pipe", stderr: "pipe", signal, timeout: blenderTimeoutMs(), killSignal: "SIGKILL" });
    } catch (error) {
      throw new BuildingError("BLENDER_START_FAILED", error instanceof Error ? error.message : String(error));
    }
    // Wait for the process itself, not its pipes: after a timeout kill, a surviving child
    // process can keep stdout/stderr open long after Blender is gone.
    const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    signal?.throwIfAborted();
    if (proc.signalCode === "SIGKILL") {
      output.catch(() => {});
      throw new BuildingError("BLENDER_TIMEOUT", `Blender did not finish within ${blenderTimeoutMs()} ms (set BLENDER_TIMEOUT_MS to change the limit)`);
    }
    const [stdout, stderr] = await output;
    if (code !== 0) {
      const output = stderr + stdout;
      const version = output.match(/BLENDER_VERSION_MISMATCH: (.+)$/m)?.[1];
      if (version) throw new BuildingError("BLENDER_VERSION_MISMATCH", version);
      const reason = output.match(/^BUILDING_LAYOUT_REJECTED: (.+)$/m)?.[1];
      throw new BuildingError(reason ? "LAYOUT_REJECTED" : "BLENDER_FAILED",
        reason ?? ((stderr || stdout).trim().slice(-4000) || `Blender exited with status ${code}`));
    }

    const report: unknown = JSON.parse(readFileSync(metadata, "utf8"));
    const { width, height, data } = readPng(renderPath);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if ((x === 0 || x === width - 1 || y === 0 || y === height - 1) && data[(y * width + x) * 4 + 3]) {
          throw new BuildingError("FRAME_OVERFLOW", "Building exceeds the orthographic sprite frame");
        }
      }
    }
    const libraryPath = join(work, "library");
    const partDir = join(libraryPath, "assets", "parts", "01_assembly");
    mkdirSync(partDir, { recursive: true });
    copyFileSync(renderPath, join(partDir, `${building}.png`));
    writeFileSync(join(libraryPath, "assets", "palettes.json"), "{}\n");
    writeFileSync(join(libraryPath, "manifest.json"), JSON.stringify({
      frameWidth: width, frameHeight: height, columns: 1, frameCount: 1, pixelArt: false,
      layers: [{ id: "assembly", folder: "01_assembly", zIndex: 0, required: true, defaultPart: building, swappable: false }],
      animations: [{ name: "still", frames: [0], fps: 1, loop: false }],
    }));

    mkdirSync(outputDir, { recursive: true });
    publishing = mkdtempSync(join(outputDir, ".building-stage-"));
    const staged = join(publishing, "files");
    const exported = composeCharacterSprite(loadAssetLibrary(libraryPath, `village_${building}`), {
      name, outputDir: staged, parts: {}, normalMap,
    }, outputDir);
    const layoutPath = join(staged, `${name}.layout.json`);
    writeFileSync(layoutPath, JSON.stringify(report, null, 2) + "\n");
    const scene = interior ? exportLayeredInterior({
      name, renderDir: join(work, "layers"), outputDir: staged, resourceDir: outputDir, report, normalMap,
    }) : exportExteriorScene({
      name, outputDir: staged, resourceDir: outputDir, framesPath: exported.tresPath, layoutPath, report,
    });
    const glbPath = glb ? join(staged, `${name}.glb`) : null;
    if (glbPath) copyFileSync(mesh, glbPath);

    signal?.throwIfAborted();
    const artifacts = publishArtifacts(staged, outputDir, join(publishing, "backup"));
    const final = (file: string) => join(outputDir, relative(staged, file));
    return {
      ...exported,
      pngPath: final(exported.pngPath),
      tresPath: final(exported.tresPath),
      creditsPath: exported.creditsPath && final(exported.creditsPath),
      normalPath: exported.normalPath && final(exported.normalPath),
      layoutPath: final(layoutPath),
      scenePath: final(scene.scenePath),
      ...("layeredLayoutPath" in scene ? { layeredLayoutPath: final(scene.layeredLayoutPath as string) } : {}),
      glbPath: glbPath && final(glbPath),
      artifacts,
    };
  } finally {
    if (publishing) rmSync(publishing, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
}
