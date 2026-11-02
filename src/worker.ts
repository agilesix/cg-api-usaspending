/**
 * The Cloudflare Workers entrypoint.
 *
 * Like `src/index.ts` for Node, this is the only file that knows the runtime.
 * The deployment follows the state APIs (cg-api-ca and its siblings): a Cron
 * trigger refreshes the data on a schedule, a Bearer-protected
 * `POST /admin/sync` runs the same refresh on demand, and an R2 bucket holds
 * the results. Unlike the state APIs there is no D1 database: a refresh
 * produces one small snapshot file, written to `latest.json` and to a dated
 * copy, and the API serves whatever `latest.json` holds.
 *
 * Until the first refresh has run, the API serves the snapshot bundled with
 * the code (`src/data/snapshot.json`).
 */

import { createAppFromSnapshot } from "./app.js";
import { errorBody } from "./http.js";
import { SnapshotSchema, parseSnapshot, type Snapshot } from "./data/snapshot.js";
import { loadConfig, type PipelineEnv } from "./pipeline/config.js";
import { runRefresh } from "./pipeline/run.js";
import bundledSnapshot from "./data/snapshot.json" with { type: "json" };

/** The parts of an R2 bucket this Worker uses. */
interface SnapshotBucket {
  get(key: string): Promise<{ etag: string; text(): Promise<string> } | null>;
  put(
    key: string,
    value: string,
    options?: { httpMetadata?: { contentType?: string } }
  ): Promise<unknown>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** Bindings: the bucket, the `SGG_API_KEY` and `SYNC_SECRET` secrets, and any refresh settings. */
export type Env = PipelineEnv & {
  SNAPSHOTS: SnapshotBucket;
};

const LATEST_KEY = "latest.json";

/** Matches the Cron in wrangler.jsonc (daily), with an hour of slack. */
const STALE_AFTER_MS = 25 * 60 * 60 * 1000;

/** How long an isolate trusts its cached snapshot before checking R2 again. */
const RECHECK_AFTER_MS = 60 * 1000;

/**
 * PR previews are uploaded as versions of the production Worker (see
 * `.github/workflows/cd-preview.yml`), so they share its bucket and secrets.
 * They read `latest.json` like production does, but must never refresh it.
 */
function isPreview(env: Env): boolean {
  return env.ENVIRONMENT === "preview";
}

// ############################################################################
// Snapshot loading, cached per isolate
// ############################################################################

interface Loaded {
  etag: string;
  checkedAt: number;
  snapshot: Snapshot;
  app: ReturnType<typeof createAppFromSnapshot>;
}

let loaded: Loaded | null = null;

function fromSnapshot(etag: string, snapshot: Snapshot): Loaded {
  return { etag, checkedAt: Date.now(), snapshot, app: createAppFromSnapshot(snapshot) };
}

async function current(env: Env): Promise<Loaded> {
  if (loaded !== null && Date.now() - loaded.checkedAt < RECHECK_AFTER_MS) return loaded;

  const object = await env.SNAPSHOTS.get(LATEST_KEY);
  if (object === null) {
    loaded = loaded?.etag === "bundled" ? loaded : fromSnapshot("bundled", bundled());
  } else if (object.etag !== loaded?.etag) {
    loaded = fromSnapshot(object.etag, parseSnapshot(await object.text()));
  }
  loaded.checkedAt = Date.now();
  return loaded;
}

function bundled(): Snapshot {
  return SnapshotSchema.parse(bundledSnapshot);
}

// ############################################################################
// Refresh
// ############################################################################

/**
 * Runs one refresh and stores it. A refresh that matched no awards is not
 * stored, so a bad upstream day leaves the last good snapshot in place.
 */
async function refresh(env: Env): Promise<Snapshot> {
  const snapshot = await runRefresh(loadConfig(env as PipelineEnv), {
    log: message => console.log(message),
  });
  if (snapshot.awards.length === 0) {
    throw new Error("Refresh matched no awards; keeping the previous snapshot");
  }

  const body = `${JSON.stringify(snapshot)}\n`;
  const options = { httpMetadata: { contentType: "application/json" } };
  await env.SNAPSHOTS.put(`snapshots/${snapshot.asOf.slice(0, 10)}.json`, body, options);
  await env.SNAPSHOTS.put(LATEST_KEY, body, options);
  loaded = null;
  return snapshot;
}

/**
 * Per-isolate guard against concurrent refreshes when a burst of requests all
 * see stale data. Cleared when the refresh settles.
 */
let inFlight: Promise<unknown> | null = null;

/**
 * Refreshes in the background when the data is older than the Cron interval:
 * a missed Cron, a fresh deploy, a local `wrangler dev`. The triggering request
 * still gets whatever is currently stored.
 */
function refreshIfStale(env: Env, ctx: ExecutionContext, snapshot: Snapshot): void {
  if (inFlight !== null || !env.SGG_API_KEY || isPreview(env)) return;
  if (Date.now() - Date.parse(snapshot.asOf) < STALE_AFTER_MS) return;
  inFlight = refresh(env)
    .catch(error => console.error("Background refresh failed", error))
    .finally(() => {
      inFlight = null;
    });
  ctx.waitUntil(inFlight);
}

// ############################################################################
// Admin
// ############################################################################

/** `POST /admin/sync`: the scheduled refresh, run on demand. */
async function adminSync(request: Request, env: Env): Promise<Response> {
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!env.SYNC_SECRET || token !== env.SYNC_SECRET) {
    return Response.json(errorBody(401, "Unauthorized"), { status: 401 });
  }
  if (isPreview(env)) {
    return Response.json(errorBody(403, "Refreshes are disabled on previews"), { status: 403 });
  }
  try {
    const { asOf, report } = await refresh(env);
    return Response.json({ status: 200, message: "Refresh complete", data: { asOf, report } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(errorBody(500, "Refresh failed", [message]), { status: 500 });
  }
}

// ############################################################################
// Handlers
// ############################################################################

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname === "/admin/sync" && request.method === "POST") {
      return adminSync(request, env);
    }
    const { app, snapshot } = await current(env);
    refreshIfStale(env, ctx, snapshot);
    return app.fetch(request);
  },

  async scheduled(_controller: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    // An uploaded version never runs the Cron, but a preview must not write if it ever did.
    if (isPreview(env)) return;
    ctx.waitUntil(refresh(env));
  },
};
