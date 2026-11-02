/**
 * The refresh, offline.
 *
 * USAspending is replaced by a stubbed `fetch` that serves three real award
 * records (`test/fixtures/usaspending-awards.json`), and Simpler.Grants.gov by
 * a stub resolver. That exercises sampling, the opportunity-number filter, the
 * join, the transform and SDK validation without touching the network.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/pipeline/config.js";
import { runRefresh } from "../src/pipeline/run.js";
import type { OpportunityResolver } from "../src/pipeline/sgg.js";
import { OpportunitySchema } from "../src/data/schema.js";
import { createAppFromSnapshot } from "../src/app.js";
import awardDetails from "./fixtures/usaspending-awards.json" with { type: "json" };

const MATCHED_NUMBER = "IW-SIW-18-001";
const OPP_ID = "00000000-0000-4000-8000-0000000000bb";

/** Serves the fixture awards for every search, and each one by id. */
function stubUsaSpending() {
  const byId = new Map(awardDetails.map(a => [a.generated_unique_award_id, a]));
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/api/v2/search/spending_by_award/")) {
      const results = awardDetails.map(a => ({
        generated_internal_id: a.generated_unique_award_id,
      }));
      return Response.json({ results });
    }
    const id = decodeURIComponent(url.split("/api/v2/awards/")[1]?.replace(/\/$/, "") ?? "");
    const detail = byId.get(id);
    return detail ? Response.json(detail) : new Response("not found", { status: 404 });
  });
}

/** Knows one opportunity number; every other number has no match. */
const resolver: OpportunityResolver = {
  async resolve(number) {
    if (number !== MATCHED_NUMBER) return null;
    const record = OpportunitySchema.parse({
      id: OPP_ID,
      title: "Indian Water Rights Settlements",
      description: "A matched opportunity",
      status: { value: "closed" },
      createdAt: "2018-01-01T00:00:00Z",
      lastModifiedAt: "2018-01-02T00:00:00Z",
      customFields: {
        federalOpportunityNumber: {
          name: "federalOpportunityNumber",
          fieldType: "string",
          value: MATCHED_NUMBER,
        },
      },
    });
    return { id: OPP_ID, title: record.title, federalOpportunityNumber: number, record };
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runRefresh", () => {
  const config = loadConfig({
    SGG_API_KEY: "test",
    USASPENDING_AGENCIES: "Department of Health and Human Services",
    AS_OF: "2026-11-02T00:00:00Z",
  });

  it("joins awards to opportunities on the federal opportunity number", async () => {
    vi.stubGlobal("fetch", stubUsaSpending());

    const snapshot = await runRefresh(config, { resolver });

    expect(snapshot.awards).toHaveLength(1);
    expect(snapshot.awards[0]?.opportunity?.id).toBe(OPP_ID);
    expect(snapshot.awards[0]?.opportunity?.identifiers?.["opp:us:fon"]?.id).toBe(MATCHED_NUMBER);
    expect(snapshot.opportunities.map(o => o.id)).toEqual([OPP_ID]);
  });

  it("reports how the records narrowed at each step", async () => {
    vi.stubGlobal("fetch", stubUsaSpending());

    const { report, asOf } = await runRefresh(config, { resolver });

    expect(asOf).toBe("2026-11-02T00:00:00.000Z");
    expect(report.funnel).toEqual({
      awardsFetched: 3,
      awardsWithOpportunityNumber: 2, // "NOT APPLICABLE" is not a number
      distinctOpportunityNumbers: 2,
      matchedOpportunityNumbers: 1,
      awardsJoined: 1,
      awardsEmitted: 1,
      awardsRejected: 0,
    });
    expect(report.unmatchedNumbers).toEqual(["SM00-PAIMI"]);
  });

  it("produces a snapshot the API serves with the link in place", async () => {
    vi.stubGlobal("fetch", stubUsaSpending());

    const app = createAppFromSnapshot(await runRefresh(config, { resolver }));
    const res = await app.request(`/common-grants/opportunities/${OPP_ID}`);
    const body = (await res.json()) as { data: { awards: unknown[] } };

    expect(res.status).toBe(200);
    expect(body.data.awards).toHaveLength(1);
  });

  it("defaults to the year of awards ending on the run date", () => {
    expect(config.timePeriod).toEqual({ startDate: "2025-11-02", endDate: "2026-11-02" });
  });

  it("refuses to run without a Simpler.Grants.gov key", () => {
    expect(() => loadConfig({})).toThrow("SGG_API_KEY");
  });
});
