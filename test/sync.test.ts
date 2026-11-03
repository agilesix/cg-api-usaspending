/**
 * The full-coverage refresh, offline.
 *
 * Simpler.Grants.gov and USAspending are replaced by a stubbed `fetch`: a
 * listing and CommonGrants records for two opportunities, a zipped award
 * download, and three real USAspending award records
 * (`test/fixtures/usaspending-awards.json`). The steps run in order against
 * `node:sqlite`, as the Workflow runs them against D1.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createD1AwardRepository, createD1OpportunityRepository } from "../src/storage/d1.js";
import {
  fetchAwardsStep,
  fetchOpportunitiesStep,
  failRun,
  finishRun,
  latestRun,
  listOpportunitiesStep,
  pruneStep,
  readDownloadStep,
  startRun,
  type SyncDeps,
} from "../src/sync/steps.js";
import {
  checkDownload,
  createCsvParser,
  fiscalYearSlices,
  requestDownload,
  streamDownload,
} from "../src/sync/usaspending-download.js";
import { createFonMatcher, normalizeFon } from "../src/sync/fon.js";
import { normalizeAttachmentDates } from "../src/sync/sgg.js";
import { upsertAward } from "../src/storage/rows.js";
import { createTestBucket, createTestD1 } from "./d1.js";
import { baseline, OPP_A, OPP_B, opportunity, stub } from "./upstream.js";

function deps(
  db = createTestD1(),
  bucket = createTestBucket()
): SyncDeps & {
  bucket: ReturnType<typeof createTestBucket>;
} {
  return {
    db,
    bucket,
    sgg: { baseUrl: "https://sgg.test", apiKey: "k", authHeader: "X-API-Key" },
    usaSpendingBaseUrl: "https://usaspending.test",
    concurrency: 2,
    awardRequestIntervalMs: 0,
    now: () => new Date("2026-11-03T12:00:00Z"),
    log: () => {},
  };
}

/** One whole refresh, step by step, as the Workflow runs it. */
async function refresh(d: SyncDeps, runId: string) {
  await startRun(d, runId);
  const listing = await listOpportunitiesStep(d, runId);
  const opp = await fetchOpportunitiesStep(d, runId, listing.toFetch);
  const job = await requestDownload(d.usaSpendingBaseUrl, {
    startDate: "2024-10-01",
    endDate: "2025-09-30",
  });
  const status = await checkDownload(job);
  if (status.state !== "finished") throw new Error("download did not finish");
  const read = await readDownloadStep(d, runId, job, status.totalRows);
  const fetched = await fetchAwardsStep(d, runId, "", 100);
  const removed = await pruneStep(d, runId);
  const report = await finishRun(d, runId, {
    scope: { postedSince: "2024-10-01", awardTypeCodes: [] },
    opportunities: { listed: listing.listed, ...opp },
    downloads: { slices: 1, rows: read.rows, withOpportunityNumber: read.withOpportunityNumber },
    matching: { exact: read.matchedExact, suffix: read.matchedSuffix, ambiguous: read.ambiguous },
    awards: { ...fetched, stoppedEarly: false },
    removed,
  });
  return { listing, opp, read, fetched, removed, report };
}

/** Adds opportunities with no awards, so removing one is a small share. */
function withExtraOpportunities(upstream: ReturnType<typeof baseline>, count: number) {
  for (let n = 0; n < count; n += 1) {
    const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    upstream.listing.push({ id, fon: `EXTRA-26-${n}`, title: `Extra ${n}`, version: "v1" });
    upstream.records.set(id, opportunity(id, `EXTRA-26-${n}`, `Extra ${n}`));
  }
  return upstream;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a first refresh", () => {
  it("stores every opportunity and every award that links to one", async () => {
    stub(baseline());
    const d = deps();
    const { report, read } = await refresh(d, "run-1");

    expect(read).toMatchObject({ rows: 3, withOpportunityNumber: 2, matchedExact: 2 });
    expect(report.served).toEqual({ opportunities: 2, opportunitiesWithAwards: 2, awards: 2 });

    const opportunities = createD1OpportunityRepository(d.db, d.now);
    const details = await opportunities.get(OPP_A);
    expect(details?.awards).toHaveLength(1);

    const awards = createD1AwardRepository(d.db, d.now);
    const page = await awards.search(
      undefined,
      { opportunityId: { operator: "in", value: [OPP_B] } },
      { sortBy: "title", sortOrder: "asc" },
      { page: 1, pageSize: 10 }
    );
    expect(page.items[0]?.opportunity?.id).toBe(OPP_B);

    expect((await latestRun(d.db))?.report.served.awards).toBe(2);
  });

  it("archives the newest raw copy of each record, plus a dated version", async () => {
    stub(baseline());
    const d = deps();
    await refresh(d, "run-1");
    const keys = [...d.bucket.objects.keys()].sort();
    expect(keys).toContain("records/awards/ASST_NON_SIWCM248002_075.json");
    expect(keys).toContain("history/awards/ASST_NON_SIWCM248002_075/run-1.json");
    expect(keys).toContain(`records/opportunities/${OPP_A}.json`);
  });
});

describe("a second refresh", () => {
  it("refetches nothing that did not change", async () => {
    const upstream = baseline();
    stub(upstream);
    const d = deps();
    await refresh(d, "run-1");

    const { calls } = stub(upstream);
    const { opp, fetched } = await refresh(d, "run-2");
    expect(opp.fetched).toBe(0);
    expect(fetched.fetched).toBe(0);
    expect(calls.some(url => url.includes("/api/v2/awards/"))).toBe(false);
  });

  it("refetches a changed award and the awards of a changed opportunity", async () => {
    const upstream = baseline();
    stub(upstream);
    const d = deps();
    await refresh(d, "run-1");

    upstream.rows[0]![2] = "2026-11-01";
    upstream.listing[1]!.version = "v2";
    upstream.records.set(OPP_B, opportunity(OPP_B, "SM00-PAIMI", "Advocacy, renamed"));
    stub(upstream);
    const later = { ...d, now: () => new Date("2026-11-04T12:00:00Z") };
    const { opp, fetched } = await refresh(later, "run-2");

    expect(opp).toMatchObject({ fetched: 1, changed: 1 });
    expect(fetched.fetched).toBe(2);
    const awards = createD1AwardRepository(d.db, later.now);
    const page = await awards.list(
      { sortBy: "title", sortOrder: "asc" },
      { page: 1, pageSize: 10 }
    );
    expect(page.items.find(a => a.opportunity?.id === OPP_B)?.opportunity?.title).toBe(
      "Advocacy, renamed"
    );
  });

  it("removes awards and opportunities that are gone upstream", async () => {
    const upstream = withExtraOpportunities(baseline(), 10);
    stub(upstream);
    const d = deps();
    await refresh(d, "run-1");

    upstream.listing = upstream.listing.filter(l => l.id !== OPP_B);
    stub(upstream);
    const { removed, report } = await refresh(d, "run-2");
    expect(removed).toEqual({ opportunitiesRemoved: 1, awardsRemoved: 1 });
    expect(report.served).toMatchObject({ opportunities: 11, awards: 1 });
  });

  it("removes no opportunities when the listing looks short", async () => {
    const upstream = withExtraOpportunities(baseline(), 10);
    stub(upstream);
    const d = deps();
    await refresh(d, "run-1");

    upstream.listing = upstream.listing.slice(0, 2);
    stub(upstream);
    const { removed, report } = await refresh(d, "run-2");
    expect(removed.opportunitiesRemoved).toBe(0);
    expect(report.served.opportunities).toBe(12);
  });

  it("removes nothing when the download looks truncated", async () => {
    const upstream = baseline();
    stub(upstream);
    const d = deps();
    await refresh(d, "run-1");

    upstream.rows = [];
    stub(upstream);
    const { removed } = await refresh(d, "run-2");
    expect(removed).toEqual({ opportunitiesRemoved: 0, awardsRemoved: 0 });
  });

  it("refuses to start while another run is going", async () => {
    stub(baseline());
    const d = deps();
    await startRun(d, "run-1");
    await expect(startRun(d, "run-2")).rejects.toThrow(/still running/);
  });
  it("lets only one of two runs started at the same moment through", async () => {
    const d = deps();
    const results = await Promise.allSettled([startRun(d, "run-1"), startRun(d, "run-2")]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    // A retry of the run that got through still goes on.
    const winner = results[0]?.status === "fulfilled" ? "run-1" : "run-2";
    await expect(startRun(d, winner)).resolves.toBeUndefined();
  });

  it("writes a large listing in a few statements", async () => {
    const upstream = withExtraOpportunities(baseline(), 1200);
    stub(upstream);
    const d = deps();
    const batch = vi.spyOn(d.db, "batch");
    await startRun(d, "run-1");
    const listing = await listOpportunitiesStep(d, "run-1");
    expect(listing.listed).toBe(1202);
    const statements = batch.mock.calls.reduce((n, [s]) => n + s.length, 0);
    expect(statements).toBeLessThanOrEqual(3);
  });

  it("updates an award whose id changed under the same USAspending key", async () => {
    stub(baseline());
    const d = deps();
    await refresh(d, "run-1");
    const before = await d.db
      .prepare("SELECT id, source_key, record_json FROM awards LIMIT 1")
      .first<{ id: string; source_key: string; record_json: string }>();
    const record = {
      ...JSON.parse(before!.record_json),
      id: "11111111-1111-4111-8111-111111111111",
    };
    await d.db.batch([
      upsertAward(d.db, record, {
        sourceKey: before!.source_key,
        popEnd: null,
        sourceVersion: null,
        rawHash: null,
        syncedAt: "2026-11-03T12:00:00Z",
      }),
    ]);
    const after = await d.db
      .prepare("SELECT id FROM awards WHERE source_key = ?")
      .bind(before!.source_key)
      .all<{ id: string }>();
    expect(after.results).toEqual([{ id: "11111111-1111-4111-8111-111111111111" }]);
  });

  it("starts once the other run has failed or timed out", async () => {
    const d = deps();
    await startRun(d, "run-1");
    await failRun(d, "run-1", "boom");
    await expect(startRun(d, "run-2")).resolves.toBeUndefined();

    const later = { ...d, now: () => new Date("2026-11-04T01:00:00Z") };
    await expect(startRun(later, "run-3")).resolves.toBeUndefined();
  });

  it("leaves the listing run's mark alone when another run fetches records", async () => {
    stub(baseline());
    const d = deps();
    const listing = await listOpportunitiesStep(d, "run-a");
    await fetchOpportunitiesStep(d, "run-b", listing.toFetch);
    const marked = await d.db
      .prepare("SELECT COUNT(*) AS n FROM opportunities WHERE seen_run = 'run-a'")
      .first<{ n: number }>();
    expect(marked?.n).toBe(listing.listed);
  });

  it("removes the awards of an opportunity whose record lost its number", async () => {
    const upstream = baseline();
    stub(upstream);
    const d = deps();
    await refresh(d, "run-1");

    const record = opportunity(OPP_B, "SM00-PAIMI", "Advocacy") as {
      customFields: Record<string, unknown>;
    };
    delete record.customFields.federalOpportunityNumber;
    upstream.records.set(OPP_B, record as ReturnType<typeof opportunity>);
    upstream.listing[1]!.version = "v2";
    stub(upstream);
    const later = { ...d, now: () => new Date("2026-11-04T12:00:00Z") };
    const { fetched, report } = await refresh(later, "run-2");
    expect(fetched.skipped).toBe(1);
    expect(report.served.awards).toBe(1);
  });
});

describe("the USAspending download", () => {
  it("fails a slice that reached the row cap", async () => {
    stub({ ...baseline(), downloadRows: 500_000 });
    const job = await requestDownload("https://usaspending.test", {
      startDate: "2024-10-01",
      endDate: "2025-09-30",
    });
    expect(await checkDownload(job)).toMatchObject({ state: "failed" });
  });

  it("splits the window into fiscal years", () => {
    expect(fiscalYearSlices("2024-10-01", "2026-11-03")).toEqual([
      { startDate: "2024-10-01", endDate: "2025-09-30" },
      { startDate: "2025-10-01", endDate: "2026-09-30" },
      { startDate: "2026-10-01", endDate: "2026-11-03" },
    ]);
  });

  it("parses quoted CSV fields across chunk boundaries", () => {
    const records: string[][] = [];
    const parser = createCsvParser(fields => records.push(fields));
    for (const chunk of ['a,"b, ', 'c ""d""",e\r\n', "f,g,h\n", '"multi\nline",x,y']) {
      parser.push(chunk);
    }
    parser.end();
    expect(records).toEqual([
      ["a", 'b, c "d"', "e"],
      ["f", "g", "h"],
      ["multi\nline", "x", "y"],
    ]);
  });

  it("streams every row from a zipped download", async () => {
    stub(baseline());
    const rows: string[] = [];
    const count = await streamDownload("https://dl.test/f.zip", row => rows.push(row.awardKey));
    expect(count).toBe(3);
    expect(rows).toContain("ASST_NON_SIWCM248002_075");
  });
});

describe("opportunity number matching", () => {
  const matcher = createFonMatcher([
    { id: "a", fon: "CDC-RFA-JG-26-0142" },
    { id: "b", fon: "HRSA-26-004" },
    { id: "c", fon: "X-26-0001" },
    { id: "d", fon: "Y-26-0001" },
  ]);

  it("normalizes case, spacing and dash variants", () => {
    expect(normalizeFon(" hrsa–26 - 004 ")).toBe("HRSA-26-004");
    expect(matcher.match("hrsa-26-004")).toMatchObject({ kind: "matched", method: "exact" });
  });

  it("matches a number reported without its prefix", () => {
    expect(matcher.match("JG-26-0142")).toEqual({
      kind: "matched",
      opportunityId: "a",
      method: "suffix",
    });
  });

  it("never guesses between numbers that share a suffix, or on generic tails", () => {
    expect(matcher.match("26-0001")).toEqual({ kind: "unmatched" });
    expect(matcher.match("0142")).toEqual({ kind: "unmatched" });
  });

  it("treats placeholder numbers as no number", () => {
    expect(matcher.match("NOT APPLICABLE")).toEqual({ kind: "none" });
    expect(matcher.match("")).toEqual({ kind: "none" });
  });
});

describe("Simpler.Grants.gov records", () => {
  it("writes +00:00 attachment timestamps as Z, so they validate", () => {
    const record = normalizeAttachmentDates({
      customFields: {
        attachments: {
          value: [
            {
              name: "a.pdf",
              createdAt: "2024-11-04T11:42:00+00:00",
              lastModifiedAt: "2024-11-05T00:00:00Z",
            },
          ],
        },
      },
    });
    expect(record).toEqual({
      customFields: {
        attachments: {
          value: [
            {
              name: "a.pdf",
              createdAt: "2024-11-04T11:42:00Z",
              lastModifiedAt: "2024-11-05T00:00:00Z",
            },
          ],
        },
      },
    });
  });
});

describe("when USAspending refuses requests", () => {
  it("stores what succeeded, then fails the step so the Workflow backs off", async () => {
    const upstream = baseline();
    stub(upstream);
    const d = deps();
    await startRun(d, "run-1");
    const listing = await listOpportunitiesStep(d, "run-1");
    await fetchOpportunitiesStep(d, "run-1", listing.toFetch);
    // 25 candidates for a stored opportunity, none of which USAspending answers.
    for (let n = 0; n < 25; n += 1) {
      await d.db
        .prepare(
          `INSERT INTO award_candidates (source_key, opportunity_id, fon, match_method, source_version, run_id)
           VALUES (?, ?, 'X', 'exact', '2026-01-01', 'run-1')`
        )
        .bind(`ASST_NON_MISSING${String(n).padStart(3, "0")}_075`, OPP_A)
        .run();
    }
    await expect(fetchAwardsStep(d, "run-1", "", 100)).rejects.toThrow(/backing off/);
  });
});
