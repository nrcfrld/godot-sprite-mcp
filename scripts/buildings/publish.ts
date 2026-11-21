import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, extname, join } from "node:path";

export function fileDigest(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function files(directory: string, prefix = ""): string[] {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = join(prefix, entry.name);
    return entry.isDirectory() ? files(directory, path) : [path];
  });
}

/** Publish validated artifacts individually, keeping source paths and Godot sidecars stable. */
export function publishArtifacts(staged: string, output: string, backups: string) {
  const order = (path: string) => ({ ".tres": 1, ".tscn": 2 })[extname(path) as ".tres" | ".tscn"] ?? 0;
  const completed: { target: string; backup?: string }[] = [];
  const artifacts: Record<string, string> = {};
  try {
    for (const file of files(staged).sort((a, b) => order(a) - order(b) || (a < b ? -1 : 1))) {
      const source = join(staged, file);
      const target = join(output, file);
      const digest = fileDigest(source);
      artifacts[file.replaceAll("\\", "/")] = digest;
      const exists = existsSync(target);
      if (exists && fileDigest(target) === digest) continue;
      let backup: string | undefined;
      if (exists) {
        backup = join(backups, file);
        mkdirSync(dirname(backup), { recursive: true });
        copyFileSync(target, backup);
      }
      mkdirSync(dirname(target), { recursive: true });
      renameSync(source, target);
      completed.push({ target, backup });
    }
  } catch (error) {
    for (const { target, backup } of completed.reverse()) {
      if (backup) renameSync(backup, target);
      else rmSync(target);
    }
    throw error;
  }
  return artifacts;
}
