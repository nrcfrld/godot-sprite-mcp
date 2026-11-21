
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
- **Immutable Camera & Lighting:** Do not alter the global isometric camera angle, orthographic scale, or primary `Sun` light direction/color defined in `core/scene_setup.py`. Every rendered asset must share identical perspective and shadow angles.

## 2. Mandatory Architectural Constraints (Blender Scripts)

- **Use Global Constants:** Always import dimensions from `core/constants.py` (`GLOBAL_PLINTH_HEIGHT`, `GLOBAL_WALL_HEIGHT`, `GLOBAL_DOOR_HEIGHT`, `TOWER_HEIGHT_MULTIPLIER`). Never hardcode arbitrary foundation heights or door scales per building.
- **Ground Pivot Snapping:** Every structural module (main building, wings, towers, stairs, props) MUST call `snap_to_ground(obj)` so its lowest bounding box vertex rests at `Z = 0.0`.
- **Socket-Based Attachment:** Attach secondary structures (towers, porches, chimneys) strictly via bounding-box exterior sockets (`attach_to_side()`), never by guessing raw `(x, y, z)` coordinates.
- **Conflict Exclusion:** Before rendering, run bounding-box intersection checks. If an attached module overlaps a roof ornament or window, automatically disable or relocate the conflicting ornament.
- **Symmetrical Roof Overhangs:** Ensure left and right gable roof overhangs use identical extrusion values unless explicitly specified as an asymmetric L-shaped structure.
