/**
 * The Cloudflare Workers entrypoint.
 *
 * Like `src/index.ts` for Node, this is the only file that knows the runtime.
 * The deployment follows the state APIs (cg-api-ca and its siblings): the API
 * serves from a D1 database, a Cron trigger refreshes it daily, a
 * Bearer-protected `POST /admin/sync` starts the same refresh on demand, and
 * an R2 bucket archives the raw upstream records.
 *
 * A refresh runs as a Cloudflare Workflow (`src/sync/workflow.ts`), since it
 * outlasts one invocation. Until the first refresh has finished, the API
 * serves the sample bundled with the code (`src/data/snapshot.json`), so a new
 * deployment never serves an empty API.
 */

import { createApp, createAppFromSnapshot, type SnapshotInfo } from "./app.js";
import { errorBody } from "./http.js";
import { SnapshotSchema } from "./data/snapshot.js";
import type { PipelineEnv } from "./pipeline/config.js";
import { createD1AwardRepository, createD1OpportunityRepository } from "./storage/d1.js";
import type { D1Database, R2Bucket } from "./storage/types.js";
import { latestRun } from "./sync/steps.js";
import bundledSnapshot from "./data/snapshot.json" with { type: "json" };

export { SyncWorkflow } from "./sync/workflow.js";

/** The parts of a Workflow binding this Worker uses. */
interface WorkflowBinding {
  create(options: { id: string; params: { runId: string } }): Promise<{ id: string }>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** Bindings: database, bucket, Workflow, the secrets, and any refresh settings. */
export type Env = PipelineEnv & {
  DB: D1Database;
  SNAPSHOTS: R2Bucket;
  SYNC: WorkflowBinding;
};

/** How long an isolate trusts what it knows about the latest refresh. */
const RECHECK_AFTER_MS = 60 * 1000;

/**
 * PR previews are uploaded as versions of the production Worker (see
 * `.github/workflows/cd-preview.yml`), so they share its database, bucket and
 * secrets. They read like production does, but must never start a refresh.
 */
function isPreview(env: Env): boolean {
  return env.ENVIRONMENT === "preview";
}

// ############################################################################
// Serving
// ############################################################################

let bundledApp: ReturnType<typeof createAppFromSnapshot> | null = null;
let databaseApp: ReturnType<typeof createApp> | null = null;
let known: { checkedAt: number; latest: SnapshotInfo | undefined } | null = null;

/** The latest successful refresh, or undefined before the first one. */
async function latest(env: Env): Promise<SnapshotInfo | undefined> {
  if (known !== null && Date.now() - known.checkedAt < RECHECK_AFTER_MS) return known.latest;
  let info: SnapshotInfo | undefined;
  try {
    const run = await latestRun(env.DB);
    info = run === null ? undefined : { asOf: run.finishedAt, report: { ...run.report } };
  } catch (error) {
    // No tables yet (migrations not applied): serve the bundled sample.
    console.log(`No refresh to serve: ${error instanceof Error ? error.message : error}`);
  }
  known = { checkedAt: Date.now(), latest: info };
  return info;
}

/** The database once a refresh has finished; the bundled sample until then. */
async function appFor(env: Env) {
  if ((await latest(env)) === undefined) {
    bundledApp ??= createAppFromSnapshot(SnapshotSchema.parse(bundledSnapshot));
    return bundledApp;
  }
  databaseApp ??= createApp({
    opportunities: createD1OpportunityRepository(env.DB),
    awards: createD1AwardRepository(env.DB),
    snapshot: () => latest(env),
  });
  return databaseApp;
}

// ############################################################################
// Refresh
// ############################################################################

/**
 * Starts a refresh. Creating an instance whose id already exists fails, so a
 * repeated Cron starts only one run a day; the run itself also refuses to
 * start while another is going (see `startRun`).
 */
async function startRefresh(env: Env, runId: string): Promise<boolean> {
  try {
    await env.SYNC.create({ id: runId, params: { runId } });
    return true;
  } catch (error) {
    console.log(`Refresh ${runId} not started: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

/** `POST /admin/sync`: starts a refresh now. It runs in the background. */
async function adminSync(request: Request, env: Env): Promise<Response> {
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!env.SYNC_SECRET || token !== env.SYNC_SECRET) {
    return Response.json(errorBody(401, "Unauthorized"), { status: 401 });
  }
  if (isPreview(env)) {
    return Response.json(errorBody(403, "Refreshes are disabled on previews"), { status: 403 });
  }
  const runId = `manual-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  if (!(await startRefresh(env, runId))) {
    return Response.json(errorBody(500, "Refresh could not be started"), { status: 500 });
  }
  return Response.json(
    {
      status: 202,
      message: "Refresh started. It runs in the background; /snapshot shows it once it finishes.",
      data: { runId },
    },
    { status: 202 }
  );
}

// ############################################################################
// Handlers
// ############################################################################

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === "/admin/sync" && request.method === "POST") {
      return adminSync(request, env);
    }
    return (await appFor(env)).fetch(request);
  },

  async scheduled(_controller: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    // An uploaded version never runs the Cron, but a preview must not write if it ever did.
    if (isPreview(env)) return;
    ctx.waitUntil(startRefresh(env, `daily-${new Date().toISOString().slice(0, 10)}`));
  },
};
