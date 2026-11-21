import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openLibrary } from "../src/config.ts";
import { createImage, encodePng, MAX_IMAGE_SIDE, readPngChecked, writePng } from "../src/image.ts";
import { createServer } from "../src/server.ts";
import { composeCharacterSprite, licenseWithUrl, normalMapFile } from "../src/sprite.ts";
import { tempDir } from "./helpers.ts";

async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("tool annotations", () => {
  test("every tool that writes files is marked destructive; listings are read-only", async () => {
    const { tools } = await (await connect()).listTools();
    for (const tool of tools) {
      if (tool.name.startsWith("list_")) expect(tool.annotations?.readOnlyHint).toBe(true);
      else expect({ tool: tool.name, destructive: tool.annotations?.destructiveHint }).toEqual({ tool: tool.name, destructive: true });
    }
  });
});

describe("size limits", () => {
  test("oversized targets and scenes are rejected before anything is written", async () => {
    const client = await connect();
    const dir = tempDir();
    const input = join(dir, "in.png");
    writePng(input, createImage(4, 4));
    const normalize = await client.callTool({
      name: "normalize_pixel_art",
      arguments: { inputPath: input, targetWidth: MAX_IMAGE_SIDE + 1, targetHeight: 8, paletteId: "skin_light", outputPath: join(dir, "n.png") },
    });
    expect(normalize.isError).toBe(true);
    const scene = await client.callTool({ name: "compose_scene", arguments: { name: "big", outputDir: dir, width: 4097, height: 16 } });
    expect(scene.isError).toBe(true);
    expect(existsSync(join(dir, "n.png")) || existsSync(join(dir, "big.png"))).toBe(false);
  });

  test("a PNG whose header claims a huge size is refused without decoding it", () => {
    const dir = tempDir();
    const bytes = Buffer.from(encodePng(createImage(1, 1)));
    bytes.writeUInt32BE(100_000, 16); // IHDR width
    bytes.writeUInt32BE(100_000, 20); // IHDR height
    const path = join(dir, "bomb.png");
    writeFileSync(path, bytes);
    expect(() => readPngChecked(path)).toThrow(/exceeds the 4096px limit/);
    expect(() => normalMapFile({ inputPath: path, outputPath: join(dir, "out.png") })).toThrow(/exceeds/);
  });
});

describe("attribution", () => {
  test("credits link the license text and state the modifications", () => {
    expect(licenseWithUrl("OGA-BY 3.0")).toBe("OGA-BY 3.0 (https://static.opengameart.org/OGA-BY-3.0.txt)");
    expect(licenseWithUrl("CC-BY 4.0")).toContain("creativecommons.org/licenses/by/4.0/");
    const res = composeCharacterSprite(openLibrary(undefined, "lpc_male"), {
      name: "hero",
      parts: { legs: "pants", torso: "longsleeve" },
      palettes: { torso: "navy" },
      outputDir: tempDir(),
    });
    const credits = readFileSync(res.creditsPath!, "utf8");
    expect(credits).toContain("https://static.opengameart.org/OGA-BY-3.0.txt");
    expect(credits).toContain("- Changes: animation sheets repacked into one 64px grid");
    expect(credits).toContain("recolored (navy) and layered into hero.png");
  });
});
