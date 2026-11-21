import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { godotResourcePath } from "../../src/tres.ts";
import { blenderExecutable, buildBuilding, BuildingError, BuildingOptions } from "./builder.ts";
import { fileDigest } from "./publish.ts";

export const BatchManifestSchema = z.strictObject({
  version: z.literal(1),
  assets: z.array(BuildingOptions.omit({ name: true }).extend({
    id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  })).min(1),
}).check((ctx) => {
  const ids = new Set<string>();
  for (const [index, asset] of ctx.value.assets.entries()) {
    if (ids.has(asset.id)) ctx.issues.push({ code: "custom", input: asset.id, path: ["assets", index, "id"], message: "Duplicate asset ID" });
    ids.add(asset.id);
  }
});

const CacheSchema = z.object({
  signature: z.string().regex(/^[a-f0-9]{64}$/),
  artifacts: z.record(z.string().regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/), z.string().regex(/^[a-f0-9]{64}$/)),
});
const WorkCount = z.number().int().min(1).max(8);
export const BatchInput = z.strictObject({
  manifest: BatchManifestSchema,
  outputDir: z.string().min(1),
  jobs: WorkCount.default(2),
});

function loadCache(path: string) {
  try {
    const parsed = CacheSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function intact(output: string, files: Record<string, string>) {
  const paths = Object.entries(files);
  return paths.length > 0 && paths.every(([file, digest]) =>
    file.split("/").every((part) => part !== "." && part !== "..") &&
    existsSync(join(output, file)) && fileDigest(join(output, file)) === digest,
  );
}

function saveCache(path: string, value: z.infer<typeof CacheSchema>) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n");
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function sources(root: string) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(py|ts|gd)$/.test(entry.name) && !entry.name.startsWith("test_"))
    .map((entry) => join(entry.parentPath, entry.name)).sort();
}

function engineSignature(blender: string) {
  const version = Bun.spawnSync([blender, "--version"]);
  if (version.exitCode !== 0) throw new BuildingError("BLENDER_START_FAILED", "Could not read Blender version");
  const code = [
    ...sources(import.meta.dir),
    ...["config.ts", "image.ts", "normal.ts", "palette.ts", "sprite.ts", "tres.ts"].map((file) =>
      join(import.meta.dir, "../../src", file)),
    join(import.meta.dir, "../../bun.lock"),
  ];
  const hash = createHash("sha256").update(version.stdout).update(`${process.platform}/${process.arch}/${process.versions.bun}`);
  for (const path of code) hash.update(fileDigest(path));
  return hash.digest("hex");
}

export async function buildBatch(
  manifest: z.input<typeof BatchManifestSchema>, outputDir: string, jobs: number, blender = blenderExecutable(), signal?: AbortSignal,
) {
  WorkCount.parse(jobs);
  const { assets } = BatchManifestSchema.parse(manifest);
  const output = resolve(outputDir);
  const engine = engineSignature(blender);
  const started = performance.now();
  const reports = await Promise.all(Array.from({ length: jobs }, async (_, worker) => {
    const results = [];
    for (let index = worker; index < assets.length; index += jobs) {
      signal?.throwIfAborted();
      const { id, ...options } = assets[index]!;
      const assetDir = join(output, id);
      const path = join(output, ".building-cache", `${id}.json`);
      try {
        const signature = createHash("sha256").update(JSON.stringify([
          engine, options, godotResourcePath(join(assetDir, `${id}.png`), assetDir),
        ])).digest("hex");
        const cache = loadCache(path);
        if (cache?.signature === signature && intact(assetDir, cache.artifacts)) {
          results.push({ id, status: "cached" as const, outputDir: assetDir, artifacts: cache.artifacts });
          continue;
        }
        const built = await buildBuilding({ ...options, name: id, outputDir: assetDir }, blender, signal);
        saveCache(path, { signature, artifacts: built.artifacts });
        results.push({ id, status: "built" as const, outputDir: assetDir, artifacts: built.artifacts });
      } catch (error) {
        signal?.throwIfAborted();
        results.push({
          id, status: "failed" as const, outputDir: assetDir,
          code: error instanceof BuildingError ? error.code : "BUILD_FAILED",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }));
  const byId = new Map(reports.flat().map((entry) => [entry.id, entry]));
  return { outputDir: output, seconds: Math.round(performance.now() - started) / 1000, assets: assets.map(({ id }) => byId.get(id)!) };
}

async function main() {
  const { values } = parseArgs({ args: process.argv.slice(2), options: {
    manifest: { type: "string" }, out: { type: "string" }, jobs: { type: "string", default: "2" },
    blender: { type: "string" }, help: { type: "boolean", short: "h" },
  } });
  const usage = "bun run generate:buildings --manifest <file.json> --out <dir> [--jobs 2] [--blender <path>]";
  if (values.help) {
    console.log(usage);
    return;
  }
  if (!values.manifest || !values.out) throw new Error(usage);
  const jobs = z.coerce.number().int().min(1).max(8).parse(values.jobs);
  const input = BatchManifestSchema.parse(JSON.parse(readFileSync(values.manifest, "utf8")));
  const result = await buildBatch(input, values.out, jobs, blenderExecutable(values.blender));
  console.log(JSON.stringify(result, null, 2));
  if (result.assets.some((asset) => asset.status === "failed")) process.exitCode = 1;
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
