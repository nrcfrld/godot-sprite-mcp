import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync } from "node:fs";
import { createServer } from "../src/server.ts";
import { tempDir } from "./helpers.ts";

async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("MCP server", () => {
  test("exposes the three tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["compose_character_sprite", "list_sprite_parts", "normalize_pixel_art"]);
  });

  test("list_sprite_parts and compose_character_sprite round-trip", async () => {
    const client = await connect();
    const list = await client.callTool({ name: "list_sprite_parts", arguments: {} });
    expect((list.structuredContent as { layers: unknown[] }).layers).toHaveLength(5);

    const outputDir = tempDir();
    const res = await client.callTool({
      name: "compose_character_sprite",
      arguments: { name: "npc", parts: { body: "base", hair: "long" }, palettes: { hair: "hair_blonde" }, outputDir },
    });
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent as { pngPath: string; tresPath: string; grid: { frameWidth: number } };
    expect(existsSync(out.pngPath) && existsSync(out.tresPath)).toBe(true);
    expect(out.grid.frameWidth).toBe(48);
  });

  test("reports invalid input as a tool error", async () => {
    const client = await connect();
    const res = await client.callTool({
      name: "compose_character_sprite",
      arguments: { name: "x", parts: { hair: "mohawk" }, outputDir: tempDir() },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("mohawk");
  });
});
