import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/worker.js";

/** Well past the bundled snapshot's `asOf`, so the data always looks stale. */
const LATER = new Date("2099-01-01T00:00:00Z");

function setup(environment: string) {
  const put = vi.fn(async () => ({}));
  // Env pairs a string-valued index signature with the bucket binding, which no
  // object literal satisfies; the Workers runtime assembles it the same way.
  const env = {
    SNAPSHOTS: { get: async () => null, put },
    SGG_API_KEY: "sgg-key",
    SYNC_SECRET: "sync-secret",
    ENVIRONMENT: environment,
  } as unknown as Env;
  const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
  return { env, ctx: { waitUntil }, put, waitUntil };
}

function adminSync(token: string): Request {
  return new Request("https://api.test/admin/sync", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("worker on a preview", () => {
  it("refuses POST /admin/sync even with the right secret", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const { env, ctx, put } = setup("preview");
    const res = await worker.fetch(adminSync("sync-secret"), env, ctx);
    expect(res.status).toBe(403);
    expect(put).not.toHaveBeenCalled();
  });

  it("still answers a wrong secret with 401", async () => {
    const { env, ctx } = setup("preview");
    const res = await worker.fetch(adminSync("wrong"), env, ctx);
    expect(res.status).toBe(401);
  });

  it("serves stale data without starting a background refresh", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LATER);
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const { env, ctx, waitUntil } = setup("preview");

    const res = await worker.fetch(new Request("https://api.test/health"), env, ctx);

    expect(res.status).toBe(200);
    expect(waitUntil).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });

  it("skips the scheduled refresh", async () => {
    const { env, ctx, waitUntil } = setup("preview");
    await worker.scheduled(undefined, env, ctx);
    expect(waitUntil).not.toHaveBeenCalled();
  });
});

describe("worker in production", () => {
  it("starts a background refresh when the data is stale", async () => {
    // The contrast for the preview test above: same request, same stale data.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LATER);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { env, ctx, waitUntil } = setup("production");

    await worker.fetch(new Request("https://api.test/health"), env, ctx);

    expect(waitUntil).toHaveBeenCalledOnce();
    // Let the failed refresh settle so it does not leak into other tests.
    await waitUntil.mock.calls[0]![0];
  });
});
