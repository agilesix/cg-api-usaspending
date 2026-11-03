/**
 * The Workflow's ordering of the steps, with a fake `step` that runs each
 * callback once and skips the sleeps.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowStep } from "cloudflare:workers";
import { SyncWorkflow, type SyncEnv } from "../src/sync/workflow.js";
import { latestRun } from "../src/sync/steps.js";
import { createTestBucket, createTestD1 } from "./d1.js";
import { baseline, stub } from "./upstream.js";

function fakeStep() {
  const names: string[] = [];
  const step = {
    async do<T>(name: string, ...rest: unknown[]): Promise<T> {
      names.push(name);
      const callback = rest.at(-1) as () => Promise<T>;
      return callback();
    },
    async sleep(name: string) {
      names.push(name);
    },
  } as WorkflowStep;
  return { step, names };
}

function env(): SyncEnv {
  return {
    DB: createTestD1(),
    SNAPSHOTS: createTestBucket(),
    SGG_API_KEY: "k",
    SGG_BASE_URL: "https://sgg.test",
    USASPENDING_BASE_URL: "https://usaspending.test",
  } as unknown as SyncEnv;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the sync Workflow", () => {
  it("runs a whole refresh and records it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    stub(baseline());
    const e = env();
    const { step, names } = fakeStep();
    const workflow = new SyncWorkflow({}, e);

    await workflow.run(
      { payload: { runId: "wf-1" }, timestamp: new Date(), instanceId: "wf-1" },
      step
    );

    expect(names[0]).toBe("start");
    expect(names).toContain("prune");
    expect(names.at(-1)).toBe("finish");
    const run = await latestRun(e.DB);
    expect(run?.id).toBe("wf-1");
    expect(run?.report.served).toMatchObject({ opportunities: 2, awards: 2 });
  });

  it("requests a download again when USAspending fails to build it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const upstream = baseline();
    const slices = 3; // FY25, FY26 and FY27 to date
    upstream.failBuilds = slices;
    const { calls } = stub(upstream);
    const e = env();
    const { step } = fakeStep();
    await new SyncWorkflow({}, e).run(
      { payload: { runId: "wf-3" }, timestamp: new Date(), instanceId: "wf-3" },
      step
    );
    expect(calls.filter(url => url.endsWith("/api/v2/download/awards/"))).toHaveLength(slices * 2);
    expect((await latestRun(e.DB))?.id).toBe("wf-3");
  });

  it("gives up on a download that keeps failing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const upstream = baseline();
    upstream.failBuilds = 1000;
    stub(upstream);
    const e = env();
    const { step } = fakeStep();
    await expect(
      new SyncWorkflow({}, e).run(
        { payload: { runId: "wf-4" }, timestamp: new Date(), instanceId: "wf-4" },
        step
      )
    ).rejects.toThrow(/failed to build it 3 times/);
  });

  it("records a failed run before failing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 503 }))
    );
    const e = env();
    const { step, names } = fakeStep();
    const workflow = new SyncWorkflow({}, e);

    await expect(
      workflow.run({ payload: { runId: "wf-2" }, timestamp: new Date(), instanceId: "wf-2" }, step)
    ).rejects.toThrow(/503/);
    expect(names.at(-1)).toBe("record failure");
    const row = await e.DB.prepare("SELECT status FROM sync_runs WHERE id = 'wf-2'").first<{
      status: string;
    }>();
    expect(row?.status).toBe("failed");
  });
});
