/**
 * The runtime-neutral application factory.
 *
 * `createApp()` builds the whole API from its repositories and never touches
 * a socket. That is what lets the test suite drive it with `app.request()` in
 * process, and lets `src/index.ts` (Node) and `src/worker.ts` (Cloudflare) be
 * the only files that know which runtime they are on.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { swaggerUI } from "@hono/swagger-ui";
import { ErrorSchema, SuccessSchema } from "@common-grants/sdk/schemas";
import type { AwardRepository, OpportunityRepository } from "./data/repository.js";
import { createAwardRepository, createOpportunityRepository } from "./data/memory.js";
import type { Snapshot, SnapshotReport } from "./data/snapshot.js";
import { createAwardRoutes } from "./routes/awards.js";
import { createOpportunityRoutes } from "./routes/opportunities.js";
import { errorBody, validationErrorHook } from "./http.js";

/** Where the opportunities router is mounted, per the CommonGrants base API. */
export const OPPORTUNITIES_BASE_PATH = "/common-grants/opportunities";

/** Where the awards router is mounted, per the CommonGrants base API. */
export const AWARDS_BASE_PATH = "/common-grants/awards";

/** What the data is and when it was pulled, served at `/snapshot`. */
export interface SnapshotInfo {
  asOf: string;
  report: SnapshotReport;
}

export interface CreateAppOptions {
  opportunities: OpportunityRepository;
  awards: AwardRepository;
  snapshot?: SnapshotInfo;
}

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["Operations"],
  summary: "Health check",
  description: "Returns 200 while the service is able to handle requests.",
  responses: {
    200: {
      description: "The service is healthy",
      content: { "application/json": { schema: SuccessSchema } },
    },
  },
});

const SnapshotInfoSchema = SuccessSchema.extend({
  data: z.object({
    asOf: z.string().openapi({ description: "When the data was pulled from USAspending" }),
    report: z.record(z.string(), z.unknown()),
  }),
});

const snapshotRoute = createRoute({
  method: "get",
  path: "/snapshot",
  tags: ["Operations"],
  summary: "Data as of",
  description:
    "When the served data was last refreshed from USAspending and Simpler.Grants.gov, " +
    "which agencies and dates it covers, and how many records made it through each step.",
  responses: {
    200: {
      description: "Details of the current data snapshot",
      content: { "application/json": { schema: SnapshotInfoSchema } },
    },
    404: {
      description: "This instance was started without snapshot details",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export function createApp({ opportunities, awards, snapshot }: CreateAppOptions) {
  const app = new OpenAPIHono({ defaultHook: validationErrorHook });

  app.openapi(healthRoute, c => c.json({ status: 200, message: "ok" }, 200));

  app.openapi(snapshotRoute, c =>
    snapshot === undefined
      ? c.json(errorBody(404, "No snapshot details"), 404)
      : c.json({ status: 200, message: "Snapshot details", data: snapshot }, 200)
  );

  app.route(OPPORTUNITIES_BASE_PATH, createOpportunityRoutes(opportunities));
  app.route(AWARDS_BASE_PATH, createAwardRoutes(awards));

  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "CommonGrants USAspending awards API",
      version: "0.1.0",
      description:
        "Federal assistance awards from USAspending, linked to the Simpler.Grants.gov " +
        "opportunities they resulted from, served through the CommonGrants award and " +
        "opportunity routes. A reference implementation built from the CommonGrants Hono " +
        "template: requests and responses are validated with the published CommonGrants " +
        "TypeScript SDK schemas. See `/snapshot` for when the data was last refreshed.",
    },
    tags: [
      { name: "Opportunities", description: "Endpoints related to funding opportunities" },
      { name: "Awards", description: "Endpoints related to awards" },
      { name: "Operations", description: "Endpoints for operating the service" },
    ],
  });

  app.get("/docs", swaggerUI({ url: "./openapi.json", version: "5" }));

  // An unrouted path still answers with a body a CommonGrants client can parse.
  app.notFound(c => c.json(errorBody(404, "Not found"), 404));

  app.onError((err, c) => {
    // Hono raises HTTPException for transport-level problems it detects before
    // a handler runs — a malformed JSON body, most commonly. Left alone it
    // answers with a plain-text body; re-shaping it here keeps every error
    // response valid against the SDK's ErrorSchema.
    if (err instanceof HTTPException) {
      return c.json(errorBody(err.status, err.message), err.status);
    }
    console.error("Unhandled error while serving a request", err);
    return c.json(errorBody(500, "Internal server error"), 500);
  });

  return app;
}

/** Builds the API over one parsed snapshot: the shape both entrypoints use. */
export function createAppFromSnapshot(snapshot: Snapshot) {
  return createApp({
    opportunities: createOpportunityRepository(snapshot),
    awards: createAwardRepository(snapshot),
    snapshot: { asOf: snapshot.asOf, report: snapshot.report },
  });
}
