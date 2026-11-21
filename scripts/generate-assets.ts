#!/usr/bin/env bun
/**
 * Programmatically draws the dummy part sprite sheets of every asset library
 * (assets/parts/ and libraries/<id>/assets/parts/). Parts are painted with the
 * 4 source-ramp key colors so compose_character_sprite can palette-swap them.
 * Output is deterministic: re-running produces byte-identical PNGs.
 */
import { defaultAssetRoot, listLibraries, openLibrary } from "../src/config.ts";
import { buildings } from "./art/buildings.ts";
import { renderArtSet, type ArtSet } from "./art/canvas.ts";
import { characters } from "./art/characters.ts";
import { scenery } from "./art/scenery.ts";
import { renderVillage } from "./art/village.ts";

const ART: Record<string, ArtSet<any>> = { characters, buildings, scenery };

const root = defaultAssetRoot();
for (const id of listLibraries(root)) {
  const art = ART[id];
  if (id === "village") {
    for (const file of renderVillage(root)) console.log(`wrote ${file}`);
  } else if (!art) {
    console.log(`skip ${id}: no generator`);
  } else {
    for (const file of renderArtSet(openLibrary(root, id), art)) console.log(`wrote ${file}`);
  }
}
