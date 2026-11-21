import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";

/**
 * Where MCP tools may write. Tools are called by an AI client on the user's behalf,
 * so writes are constrained more than in the CLI:
 * - paths must be absolute (a relative path would silently resolve against the
 *   server's working directory, which the client cannot see);
 * - when GODOT_SPRITE_OUTPUT_ROOTS is set (paths separated by ":" on macOS/Linux,
 *   ";" on Windows), every write must land inside one of those roots, after
 *   resolving symlinks, so a link cannot redirect output elsewhere.
 */
export function outputRoots(env: Record<string, string | undefined> = process.env): string[] | null {
  const raw = env.GODOT_SPRITE_OUTPUT_ROOTS?.trim();
  if (!raw) return null;
  return raw
    .split(delimiter)
    .filter(Boolean)
    .map((root) => realpathOrSelf(resolve(root)));
}

/** realpath of the nearest existing ancestor, with the not-yet-existing tail re-appended. */
function realpathOrSelf(path: string): string {
  let existing = path;
  const tail: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return path;
    tail.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync(existing), ...tail);
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

export function checkOutputDir(dir: string, field = "outputDir", env = process.env): string {
  if (dir.includes("\0")) throw new Error(`${field} contains a NUL byte`);
  if (!isAbsolute(dir)) {
    throw new Error(`${field} must be an absolute path; "${dir}" would resolve against the MCP server's working directory (${process.cwd()})`);
  }
  const real = realpathOrSelf(resolve(dir));
  const roots = outputRoots(env);
  if (roots && !roots.some((root) => within(real, root))) {
    throw new Error(`${field} "${dir}" is outside the allowed output roots (GODOT_SPRITE_OUTPUT_ROOTS): ${roots.join(", ")}`);
  }
  return resolve(dir);
}

const PNG_SIGNATURE = "89504e470d0a1a0a";

/** An output PNG path: allowed directory, ".png" extension, and never overwrites a non-PNG file. */
export function checkOutputPng(file: string, field = "outputPath", env = process.env): string {
  if (!file.toLowerCase().endsWith(".png")) throw new Error(`${field} must end with .png`);
  const path = join(checkOutputDir(dirname(file), field, env), basename(file));
  if (existsSync(path)) {
    if (!statSync(path).isFile()) throw new Error(`${field} "${path}" exists and is not a file`);
    const head = Buffer.alloc(8);
    const fd = openSync(path, "r");
    try {
      readSync(fd, head, 0, 8, 0);
    } finally {
      closeSync(fd);
    }
    if (head.toString("hex") !== PNG_SIGNATURE) throw new Error(`Refusing to overwrite "${path}": it is not a PNG file`);
  }
  return path;
}
