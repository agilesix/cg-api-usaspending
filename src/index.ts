/**
 * The Node entrypoint.
 *
 * This is the only file that knows the app runs on Node: it composes the
 * bundled fixtures with {@link createApp} and hands the resulting `fetch`
 * handler to `@hono/node-server`. Swapping in another runtime means writing
 * another file like this one, not touching the app.
 */

import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { fixtureRepository } from "./data/fixtures.js";

/** The documented local default. Override with `PORT` for another port. */
export const DEFAULT_PORT = 3000;

// `||`, not `??`: an empty PORT would coerce to 0 and bind a random port.
const port = Number(process.env.PORT || DEFAULT_PORT);

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`PORT must be an integer between 0 and 65535, received "${process.env.PORT}"`);
  process.exit(1);
}

const app = createApp({ repository: fixtureRepository });

serve({ fetch: app.fetch, port }, info => {
  console.log(`CommonGrants API listening on http://localhost:${info.port}`);
  console.log(`  Opportunities  http://localhost:${info.port}/common-grants/opportunities`);
  console.log(`  OpenAPI        http://localhost:${info.port}/openapi.json`);
  console.log(`  Docs           http://localhost:${info.port}/docs`);
  console.log(`  Health         http://localhost:${info.port}/health`);
});
