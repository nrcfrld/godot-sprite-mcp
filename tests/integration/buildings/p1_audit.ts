import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileDigest } from "../../../scripts/buildings/publish.ts";

const root = process.cwd();
const out = resolve(process.argv[2] ?? "out/building-p1-audit");
const godot = process.argv[3] ?? "godot";
const project = join(out, "godot");
const buildings = join(project, "buildings");
const manifest = JSON.parse(readFileSync(join(root, "scripts/buildings/village-batch.json"), "utf8"));
const sandbox = mkdtempSync(join(tmpdir(), "building-p1-audit-"));
mkdirSync(project, { recursive: true });
writeFileSync(join(project, "project.godot"), "config_version=5\n");

async function withMcp<T>(run: (client: Client) => Promise<T>) {
  const client = new Client({ name: "building-p1-integration", version: "1" });
  const transport = new StdioClientTransport({ command: "bun", args: ["src/cli.ts", "serve"], cwd: sandbox, stderr: "pipe" });
  await client.connect(transport);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

type Entry = { id: string; status: "built" | "cached" | "failed"; artifacts?: Record<string, string>; code?: string; message?: string };
async function runBatch(batch = manifest) {
  return withMcp(async (client) => {
    const result = await client.callTool({
      name: "generate_building_batch",
      arguments: { manifest: batch, outputDir: buildings, jobs: 2 },
    }, undefined, { timeout: 180_000 });
    const content = result.structuredContent as { seconds: number; assets: Entry[] } | undefined;
    assert(content?.assets, JSON.stringify(result.content));
    console.log(content.seconds, content.assets.map(({ id, status, code, message }) => [id, status, code, message?.slice(-200)]));
    return content;
  });
}

function importProject() {
  const result = Bun.spawnSync([godot, "--headless", "--path", project, "--import"], { stdout: "pipe", stderr: "pipe" });
  assert.equal(result.exitCode, 0, result.stderr.toString());
  assert(!result.stderr.toString().includes("ERROR"), result.stderr.toString());
  const uids: Record<string, string> = {};
  for (const entry of readdirSync(buildings, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(glb|png)\.import$/.test(entry.name)) continue;
    const file = join(entry.parentPath, entry.name);
    const uid = readFileSync(file, "utf8").match(/^uid="([^"]+)"/m)?.[1];
    assert(uid, file);
    uids[file] = uid;
  }
  return Object.fromEntries(Object.entries(uids).sort());
}

function verifyScenes() {
  const checks = Bun.spawnSync([godot, "--headless", "--path", project, "--script", "res://verify_p1.gd"], { stdout: "pipe", stderr: "pipe" });
  assert.equal(checks.exitCode, 0, checks.stderr.toString());
  assert(!checks.stderr.toString().includes("ERROR"), checks.stderr.toString());
  writeFileSync(join(out, "godot.log"), checks.stdout + checks.stderr.toString());
}

try {
  cpSync(join(root, "src"), join(sandbox, "src"), { recursive: true });
  cpSync(join(root, "scripts/buildings"), join(sandbox, "scripts/buildings"), { recursive: true });
  for (const file of ["package.json", "bun.lock", "manifest.json"]) cpSync(join(root, file), join(sandbox, file));
  for (const directory of ["assets", "libraries", "node_modules"]) symlinkSync(join(root, directory), join(sandbox, directory));

  const first = await runBatch();
  assert(first.assets.every((a) => a.status === "built"));
  const files = Object.fromEntries(first.assets.flatMap(({ id, artifacts }) =>
    Object.entries(artifacts ?? {}).map(([file, digest]) => [`${id}/${file}`, digest])));
  const references = manifest.assets.flatMap(({ id }: { id: string }) =>
    [`res://buildings/${id}/${id}.tscn`, `res://buildings/${id}/${id}.glb`]);
  const external = references.map((path: string, i: number) => `[ext_resource type="PackedScene" path="${path}" id="r${i}"]`);
  const instances = references.map((_: string, i: number) => `[node name="Asset${i}" parent="." instance=ExtResource("r${i}")]`);
  const referencePath = join(project, "references.tscn");
  writeFileSync(referencePath, [
    `[gd_scene load_steps=${references.length + 1} format=3]`, "", ...external, "",
    '[node name="References" type="Node"]', "", ...instances, "",
  ].join("\n"));
  writeFileSync(join(project, "verify_p1.gd"), [
    "extends SceneTree", "",
    "func _initialize() -> void:",
    '	var packed := load("res://references.tscn") as PackedScene',
    "	if packed == null:",
    "		quit(1)",
    "		return",
    "	var root := packed.instantiate()",
    `	if root.get_child_count() != ${references.length}:`,
    "		root.free()",
    "		quit(1)",
    "		return",
    '	print("Loaded retained TSCN references and eight imported GLBs")',
    "	root.free()",
    "	quit()",
  ].join("\n") + "\n");
  const referenceDigest = fileDigest(referencePath);
  const uids = importProject();
  verifyScenes();

  const cached = await runBatch();
  assert(cached.assets.every((a) => a.status === "cached"));

  renameSync(join(buildings, ".building-cache"), join(buildings, ".building-audit-old-cache"));
  const regenerated = await runBatch();
  assert(regenerated.assets.every((a) => a.status === "built"));
  for (const [file, digest] of Object.entries(files)) assert.equal(fileDigest(join(buildings, file)), digest, file);

  const constants = join(sandbox, "scripts/buildings/core/constants.py");
  const before = readFileSync(constants, "utf8");
  const after = before.replace(/^INN_ROOF_PITCH = .+$/m, "INN_ROOF_PITCH = 0.29");
  assert.notEqual(before, after);
  writeFileSync(constants, after);
  const edited = await runBatch();
  assert(edited.assets.every((a) => a.status === "built"));
  const changed = Object.entries(files).filter(([file, digest]) => fileDigest(join(buildings, file)) !== digest).map(([file]) => file);
  for (const ext of [".png", ".glb", ".layout.json"]) assert(changed.includes(`village_inn/village_inn${ext}`), changed.join(", "));
  assert.equal(fileDigest(referencePath), referenceDigest);
  const updatedUids = importProject();
  assert.deepEqual(updatedUids, uids);
  verifyScenes();

  const retry = { id: "retry_kegs", building: "house", interior: "upper", glb: true };
  const failure = await runBatch({ ...manifest, assets: [...manifest.assets, retry] });
  assert(failure.assets.slice(0, -1).every((a) => a.status === "cached"));
  assert.equal(failure.assets.at(-1)?.code, "INVALID_INPUT");
  const repaired = await runBatch({ ...manifest, assets: [...manifest.assets, { id: retry.id, building: "kegs", glb: true }] });
  assert(repaired.assets.slice(0, -1).every((a) => a.status === "cached"));
  assert.equal(repaired.assets.at(-1)?.status, "built");

  const twoAssets = { ...manifest, assets: manifest.assets.filter(({ id }: { id: string }) => ["village_house", "village_kegs"].includes(id)) };
  const houseSource = join(sandbox, "scripts/buildings/house.py");
  const originalHouse = readFileSync(houseSource, "utf8");
  writeFileSync(houseSource, originalHouse.replace("def house():", 'def house():\n    raise ValueError("Pilot roof geometry rejected")'));
  const intentionallyRejected = await runBatch(twoAssets);
  assert.equal(intentionallyRejected.assets[0]?.code, "LAYOUT_REJECTED");
  assert.equal(intentionallyRejected.assets[1]?.status, "built");
  for (const [file, hash] of Object.entries(files)) {
    if (file.startsWith("village_house/")) assert.equal(fileDigest(join(buildings, file)), hash);
  }
  writeFileSync(houseSource, originalHouse);
  const retained = await runBatch(twoAssets);
  assert(retained.assets.every((asset) => asset.status !== "failed"));

  const restored = join(buildings, "village_kegs", "village_kegs.glb");
  const digest = fileDigest(restored);
  renameSync(restored, join(out, "expected-kegs.glb"));
  const repairMissing = await runBatch();
  assert(repairMissing.assets.every((asset) => asset.status === (asset.id === "village_kegs" ? "built" : "cached")));
  assert.equal(fileDigest(restored), digest);

  const single = await withMcp((client) => client.callTool({
    name: "generate_building_asset",
    arguments: { building: "house", name: "mcp_house", glb: true, outputDir: join(project, "single") },
  }, undefined, { timeout: 60_000 }));
  const artifact = single.structuredContent as { glbPath?: string } | undefined;
  assert(!single.isError && artifact?.glbPath, JSON.stringify(single.content));

  const summary = {
    mcpAssets: first.assets.length,
    seconds: { first: first.seconds, cached: cached.seconds, regenerated: regenerated.seconds, changedPitch: edited.seconds },
    stableArtifacts: Object.keys(files).length,
    unchangedPngUids: Object.keys(uids).filter((file) => file.endsWith(".png.import")).length,
    unchangedGlbUids: Object.keys(uids).filter((file) => file.endsWith(".glb.import")).length,
    unchangedReferenceScene: true, changed, recoveryPassed: true, missingArtifactRepairPassed: true,
    singleToolPassed: true, rejectedLayoutPreservedPriorArtifacts: true,
  };
  writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(summary);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
