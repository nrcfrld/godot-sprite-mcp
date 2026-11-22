/**
 * render_oblique_asset: render a caller-owned Blender asset script in an oblique
 * (three-quarter, front-facade) projection, split into components and lighting passes.
 *
 * Unlike the building templates (fixed isometric camera, see scripts/buildings), the asset
 * geometry lives in the caller's project; this module only runs Blender with a fixed,
 * deterministic rig and publishes the PNGs plus a metadata file.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { readPng, writePng } from "../../src/image.ts";
import { blenderExecutable, blenderTimeoutMs, BuildingError } from "../buildings/builder.ts";
import { fileDigest, publishArtifacts } from "../buildings/publish.ts";

// Fixed-length arrays, not z.tuple: tuple schemas ("items": [...]) are rejected by Gemini-based
// MCP clients such as Antigravity, which then disable the whole tool.
const Vec3 = z.array(z.number()).length(3);

export const ObliqueOptions = z.strictObject({
  scene: z.string().min(1).describe("Absolute path to the asset script (.py) that defines build(kit); see scripts/oblique/oblique_kit.py"),
  name: z.string().regex(/^[A-Za-z0-9_-]+$/).describe("Base name of the published files, e.g. 'general_store'"),
  unitsPerMeter: z.number().positive().max(1000).default(36).describe("Game world units per Blender meter"),
  pxPerUnit: z.number().positive().max(16).default(3).describe("Texture pixels per world unit (source density)"),
  depth: z.array(z.number().min(0).max(4)).length(2).default([0.8, 0.4])
    .describe("Oblique depth axis: meters right and up per meter of depth (+Y). [0, 1] gives a classic top-down 3/4 ground"),
  passes: z.array(z.enum(["color", "normal", "emission", "shadow"])).default(["color", "normal", "emission", "shadow"]),
  padding: z.number().int().min(0).max(256).default(4).describe("Transparent pixels around the asset"),
  sunDirection: Vec3.default([0.45, 0.6, -0.65]).describe("Direction the key light travels in render space (x right, y into the image, z up); default from front-left above"),
  sunEnergy: z.number().min(0).max(20).default(3.0),
  sunAngle: z.number().min(0).max(1).default(0.06).describe("Sun disc angle in radians: small = crisp shadows"),
  sunColor: Vec3.default([1, 0.86, 0.67]),
  fillEnergy: z.number().min(0).max(10).default(0.6),
  worldStrength: z.number().min(0).max(5).default(0.3),
  samples: z.number().int().min(1).max(4096).default(48),
});

export const ObliqueInput = ObliqueOptions.extend({ outputDir: z.string().min(1) });
export type ObliqueRequest = z.input<typeof ObliqueInput>;

interface Frame { angle: number | null; color: string; normal?: string; emission?: string; emissionStrength?: number }
interface RenderReport {
  width: number;
  height: number;
  anchor: [number, number];
  components: Record<string, { frames: Frame[]; sortOffset: number; hinge?: unknown }>;
  shadow: string | null;
  [key: string]: unknown;
}

export async function renderObliqueAsset(input: ObliqueRequest, blender = blenderExecutable(), signal?: AbortSignal) {
  const parsed = ObliqueInput.safeParse(input);
  if (!parsed.success) throw new BuildingError("INVALID_INPUT", z.prettifyError(parsed.error));
  const { outputDir, scene, name, ...options } = parsed.data;
  if (!isAbsolute(scene)) throw new BuildingError("INVALID_INPUT", "scene must be an absolute path");
  if (extname(scene) !== ".py" || !existsSync(scene) || !statSync(scene).isFile()) {
    throw new BuildingError("INVALID_INPUT", `scene must be an existing .py file: ${scene}`);
  }
  const output = resolve(outputDir);
  const work = mkdtempSync(join(tmpdir(), "godot-oblique-"));
  let publishing: string | undefined;
  try {
    const config = {
      ...options,
      maxSide: 4096,
      normalSamples: 16,
      emissionSamples: 16,
    };
    const configPath = join(work, "config.json");
    writeFileSync(configPath, JSON.stringify(config));
    const renderDir = join(work, "render");
    let proc;
    try {
      proc = Bun.spawn([
        blender, "--background", "--factory-startup", "--python-exit-code", "1",
        "--python", join(import.meta.dir, "render_oblique.py"), "--",
        "--scene", scene, "--out", renderDir, "--config", configPath,
      ], { stdout: "pipe", stderr: "pipe", signal, timeout: blenderTimeoutMs(), killSignal: "SIGKILL" });
    } catch (error) {
      throw new BuildingError("BLENDER_START_FAILED", error instanceof Error ? error.message : String(error));
    }
    const streams = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    signal?.throwIfAborted();
    if (proc.signalCode === "SIGKILL") {
      streams.catch(() => {});
      throw new BuildingError("BLENDER_TIMEOUT", `Blender did not finish within ${blenderTimeoutMs()} ms (set BLENDER_TIMEOUT_MS to change the limit)`);
    }
    const [stdout, stderr] = await streams;
    if (code !== 0) {
      const text = stderr + stdout;
      const version = text.match(/BLENDER_VERSION_MISMATCH: (.+)$/m)?.[1];
      if (version) throw new BuildingError("BLENDER_VERSION_MISMATCH", version);
      const known = text.match(/(OBLIQUE_[A-Z_]+): (.+)$/m);
      if (known) throw new BuildingError(known[1]!, known[2]!);
      throw new BuildingError("BLENDER_FAILED", (stderr || stdout).trim().slice(-4000) || `Blender exited with status ${code}`);
    }

    const report = JSON.parse(readFileSync(join(renderDir, "render.json"), "utf8")) as RenderReport;
    mkdirSync(output, { recursive: true });
    publishing = mkdtempSync(join(output, ".oblique-stage-"));
    const staged = join(publishing, "files");
    mkdirSync(staged, { recursive: true });
    // Blender's PNG writer can encode identical pixels into different bytes between runs;
    // re-encoding from the decoded pixels makes the published files byte-reproducible.
    const publish = (file: string) => {
      const target = `${name}-${file}`;
      writePng(join(staged, target), readPng(join(renderDir, file)));
      return target;
    };
    for (const component of Object.values(report.components)) {
      for (const frame of component.frames) {
        frame.color = publish(frame.color);
        if (frame.normal) frame.normal = publish(frame.normal);
        if (frame.emission) frame.emission = publish(frame.emission);
      }
    }
    if (report.shadow) {
      // The shadow catcher leaves faint colour in premultiplied pixels; keep only the alpha.
      const image = readPng(join(renderDir, report.shadow));
      for (let i = 0; i < image.data.length; i += 4) image.data[i] = image.data[i + 1] = image.data[i + 2] = 0;
      const target = `${name}-shadow.png`;
      writePng(join(staged, target), image);
      report.shadow = target;
    }
    const metadataPath = join(staged, `${name}.oblique.json`);
    const metadata = {
      version: 1,
      name,
      scene: { path: scene, sha256: fileDigest(scene) },
      options: config,
      ...report,
    };
    writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + "\n");
    signal?.throwIfAborted();
    const artifacts = publishArtifacts(staged, output, join(publishing, "backup"));
    return {
      metadataPath: join(output, `${name}.oblique.json`),
      width: report.width,
      height: report.height,
      anchor: report.anchor,
      components: Object.fromEntries(Object.entries(report.components).map(([key, value]) => [key, value.frames.length])),
      artifacts,
    };
  } finally {
    if (publishing) rmSync(publishing, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
}
