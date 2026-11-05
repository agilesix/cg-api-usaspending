import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/worker.js";
import { createTestBucket, createTestD1 } from "./d1.js";

/** The Worker keeps per-isolate caches, so each test loads a fresh copy. */
async function load() {
  vi.resetModules();
  return (await import("../src/worker.js")).default;
}

function setup(environment: string, { empty = false } = {}) {
  const create = vi.fn(async ({ id }: { id: string }) => ({ id }));
  const db = createTestD1({ empty });
  // Env pairs a string-valued index signature with the bindings, which no
  // object literal satisfies; the Workers runtime assembles it the same way.
  const env = {
    DB: db,
    SNAPSHOTS: createTestBucket(),
    SYNC: { create },
    SGG_API_KEY: "sgg-key",
    SYNC_SECRET: "sync-secret",
    ENVIRONMENT: environment,
  } as unknown as Env;
  const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
  return { env, db, ctx: { waitUntil }, create, waitUntil };
}

function adminSync(token: string): Request {
  return new Request("https://api.test/admin/sync", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function totalAwards(res: Response): Promise<number> {
  return ((await res.json()) as { paginationInfo: { totalItems: number } }).paginationInfo
    .totalItems;
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("worker on a preview", () => {
  it("refuses POST /admin/sync even with the right secret", async () => {
    const worker = await load();
    const { env, create } = setup("preview");
    const res = await worker.fetch(adminSync("sync-secret"), env);
    expect(res.status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  it("still answers a wrong secret with 401", async () => {
    const worker = await load();
    const { env } = setup("preview");
    const res = await worker.fetch(adminSync("wrong"), env);
    expect(res.status).toBe(401);
  });

  it("skips the scheduled refresh", async () => {
    const worker = await load();
    const { env, ctx, waitUntil } = setup("preview");
    await worker.scheduled(undefined, env, ctx);
    expect(waitUntil).not.toHaveBeenCalled();
  });
});

describe("worker in production", () => {
  it("starts one refresh a day from the Cron", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2099-01-01T08:00:00Z"));
    const worker = await load();
    const { env, ctx, waitUntil, create } = setup("production");
    await worker.scheduled(undefined, env, ctx);
    await waitUntil.mock.calls[0]![0];
    expect(create).toHaveBeenCalledWith({
      id: "daily-2099-01-01",
      params: { runId: "daily-2099-01-01" },
    });
  });

  it("starts a refresh from POST /admin/sync and answers 202", async () => {
    const worker = await load();
    const { env, create } = setup("production");
    const res = await worker.fetch(adminSync("sync-secret"), env);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { data: { runId: string } };
    expect(body.data.runId).toMatch(/^manual-/);
    expect(create).toHaveBeenCalledOnce();
  });

  it("never starts a refresh from an ordinary request", async () => {
    const worker = await load();
    const { env, create } = setup("production");
    await worker.fetch(new Request("https://api.test/health"), env);
    expect(create).not.toHaveBeenCalled();
  });

  it("serves the bundled sample until a refresh has finished", async () => {
    const worker = await load();
    const { env } = setup("production");
    const res = await worker.fetch(
      new Request("https://api.test/common-grants/awards?pageSize=1"),
      env
    );
    expect(await totalAwards(res)).toBeGreaterThan(0);
    expect((await worker.fetch(new Request("https://api.test/snapshot"), env)).status).toBe(200);
  });

  it("serves the bundled sample when the database has no tables yet", async () => {
    const worker = await load();
    const { env } = setup("production", { empty: true });
    const res = await worker.fetch(
      new Request("https://api.test/common-grants/awards?pageSize=1"),
      env
    );
    expect(await totalAwards(res)).toBeGreaterThan(0);
  });

  it("serves the database once a refresh has finished", async () => {
    const { env, db } = setup("production");
    db.sqlite.exec(
      `INSERT INTO sync_runs (id, started_at, finished_at, status, report_json)
       VALUES ('r', '2099-01-01', '2099-01-01T01:00:00Z', 'succeeded', '{"served":{"awards":0}}')`
    );
    const worker = await load();
    const res = await worker.fetch(
      new Request("https://api.test/common-grants/awards?pageSize=1"),
      env
    );
    expect(await totalAwards(res)).toBe(0);

    const snapshot = await worker.fetch(new Request("https://api.test/snapshot"), env);
    const info = (await snapshot.json()) as { data: { asOf: string } };
    expect(info.data.asOf).toBe("2099-01-01T01:00:00Z");
  });
});
