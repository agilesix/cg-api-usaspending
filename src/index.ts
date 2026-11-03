/**
 * The Node entrypoint.
 *
 * Serves the snapshot bundled at `src/data/snapshot.json`, so a local run needs
 * no API key and no network. `pnpm refresh` rewrites that file from the live
 * APIs. The deployed service runs `src/worker.ts` instead, which refreshes on a
 * schedule. Swapping in another runtime means writing another file like this
 * one, not touching the app.
 */

import { serve } from "@hono/node-server";
import { createAppFromSnapshot } from "./app.js";
import { SnapshotSchema } from "./data/snapshot.js";
// A plain import, so `tsc` emits the JSON into `dist` alongside this file. No
// copy step in the build.
import rawSnapshot from "./data/snapshot.json" with { type: "json" };

/** The documented local default. Override with `PORT` for another port. */
export const DEFAULT_PORT = 3000;

// `||`, not `??`: an empty PORT would coerce to 0 and bind a random port.
const port = Number(process.env.PORT || DEFAULT_PORT);

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`PORT must be an integer between 0 and 65535, received "${process.env.PORT}"`);
  process.exit(1);
}

// Parsed at startup, so a snapshot that no longer matches the published
// schemas fails on boot instead of leaking a half-valid response later.
const snapshot = SnapshotSchema.parse(rawSnapshot);
const app = createAppFromSnapshot(snapshot);

serve({ fetch: app.fetch, port }, info => {
  console.log(`CommonGrants API listening on http://localhost:${info.port}`);
  console.log(`  Data as of     ${snapshot.asOf}`);
  console.log(`  Awards         http://localhost:${info.port}/common-grants/awards`);
  console.log(`  Opportunities  http://localhost:${info.port}/common-grants/opportunities`);
  console.log(`  OpenAPI        http://localhost:${info.port}/openapi.json`);
  console.log(`  Docs           http://localhost:${info.port}/docs`);
  console.log(`  Health         http://localhost:${info.port}/health`);
});
