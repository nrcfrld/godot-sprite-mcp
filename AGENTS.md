
Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## 1. Core Architecture & Determinism

- **No External Generative AI:** Never call image generation APIs. All assets must be generated deterministically via headless Blender Python (`bpy`) scripts or local pixel/mesh compositors.
- **Immutable Camera & Lighting:** Do not alter the global isometric camera angle, orthographic scale, or primary `Sun` light direction/color defined in `scripts/buildings/core/scene_setup.py`. Every rendered asset must share identical perspective and shadow angles.

## 2. Mandatory Architectural Constraints (Blender Scripts)

- **Use Global Constants:** Always import dimensions from `scripts/buildings/core/constants.py` (`GLOBAL_PLINTH_HEIGHT`, `GLOBAL_WALL_HEIGHT`, `GLOBAL_DOOR_HEIGHT`, `TOWER_HEIGHT_MULTIPLIER`). Never hardcode arbitrary foundation heights or door scales per building.
- **Ground Pivot Snapping:** Every ground-standing module (main building, wings, towers, stairs, props, scenery) is built through `assemble.capture()`, which calls `snap_to_ground()` so its lowest bounding box vertex rests at `Z = 0.0` and rejects floating parts. Connectors that bridge two modules above the ground (e.g. the tower's masonry wall connection) cannot rest at `Z = 0`; they must instead pass `reject_unsupported()` together with the modules they join, proving a contact chain to the ground.
- **Socket-Based Attachment:** Attach secondary exterior structures (towers, porches, chimneys, entry stairs) strictly via bounding-box exterior sockets: the final placement goes through `attach_to_side()`, never through raw `(x, y, z)` coordinates. Helpers may search for the socket (e.g. `attach_tower()` slides the wing socket along the wall and pushes it past the roof overhang) but must return the `attach_to_side()` result. Interior fixtures are the exception: they are placed from the authored floor plan (`inn_interior.floor_plan`) and must sit inside the floor footprint, avoid every other volume and keep door/stair clearances free — all checked in `assemble.inn_interior_layout()`.
- **Conflict Exclusion:** Before rendering, run bounding-box intersection checks (`reject_intersections()`). Ornaments are relocated, then disabled: the roof cross tries each roof apex (tower first, then the main roof) and is removed only when every apex is blocked. Attached modules avoid windows by searching other sockets along the wall; if no clear socket exists the layout is rejected (`LAYOUT_REJECTED`) rather than silently deleting windows.
- **Symmetrical Roof Overhangs:** Ensure left and right gable roof overhangs use identical extrusion values unless explicitly specified as an asymmetric L-shaped structure. Explicit exception: a church with a docked bell tower uses a flush verge on the tower side only (`church.py` → `nave`); with `tower: none` both sides are identical.
- **Pinned Renderer:** Renders are reproducible only on the Blender version pinned in `scripts/buildings/core/scene_setup.py` (`PINNED_BLENDER_VERSION`), with Cycles on CPU, a fixed seed and the CPU denoiser. Do not change these without re-baselining every reference render.

## 3. Render Quality (no clay/plastic look)

Flat single-color materials, a big soft low-contrast light rig and heavy denoising at 12 samples made the
first Blender sprites look like clay/plastic renders. These rules keep every building, prop and scenery
asset textured and readable. `tests/render-quality.test.ts` enforces them; a failing check is a bug in the
asset, not in the test.

- **Painted materials only:** Every visible surface uses `painted_material(name, color, PRESET)` from
  `scripts/buildings/core/painted_materials.py` with a Paint preset (`PLASTER`, `TIMBER`, `POST`,
  `FLOORBOARD`, `STONE`, `ROOF`, `BARK`, `FOLIAGE`, `TEXTILE`, `PIGMENT`). Never create materials with
  `bpy.data.materials.new` or a flat Principled BSDF elsewhere. Glass, metal and fruit pass `glossy=True`
  instead of a separate flat material. Add a new preset rather than a flat color when nothing fits.
- **Keep surface relief:** `painted_material` keeps its brush-relief bump node and self-illumination
  (`Emission Strength`) at or below 0.1. Higher emission flattens form shading.
- **Crisp, contrasted light:** In `scene_setup.py`, keep `RENDER_SAMPLES >= 48`, `SUN_ANGLE <= 0.08`,
  `SUN_ENERGY >= 2.5`, `FILL_ENERGY <= 150`, `WORLD_STRENGTH <= 0.32` and a contrast `VIEW_LOOK`
  (`AgX - … Contrast` or `Punchy`). These constants must drive the scene (no inline overrides).
- **Surface-detail floor:** Rendered building sprites must score at least `MIN_SURFACE_DETAIL` (2.5) on the
  local-detail metric in `tests/render-quality.test.ts` (flat renders score about 1.9–2.1). Check new
  buildings with it before publishing.
- **Grounded props:** Props libraries with rendered (non-pixel-art) `buildings` or `foliage` categories set
  `"contactShadow": true`, so `compose_scene` draws a soft ground shadow under each placement and exports it
  as a `Shadows` node in the `.tscn`.
- **Re-render after rule changes:** After changing materials or the light rig, re-run
  `bun run generate:village` and any published building batches so committed assets match the rules.
