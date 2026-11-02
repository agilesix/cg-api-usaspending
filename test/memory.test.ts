/**
 * The implementation-defined ordering rules of the in-memory repositories,
 * which the protocol leaves open. See `src/data/memory.ts`.
 */

import { describe, expect, it } from "vitest";
import { AwardBaseSchema } from "@common-grants/sdk/schemas";
import { createAwardRepository, createOpportunityRepository } from "../src/data/memory.js";
import type { Snapshot } from "../src/data/snapshot.js";
import { anOpportunity } from "./support.js";

const ALL = { page: 1, pageSize: 100 };
const OPP_ID = "00000000-0000-4000-8000-0000000000aa";

function award(n: number, amount: string | undefined) {
  return AwardBaseSchema.parse({
    id: `00000000-0000-5000-8000-${String(n).padStart(12, "0")}`,
    title: `Award ${n}`,
    description: "",
    status: { value: "awarded" },
    ...(amount === undefined ? {} : { funding: { awardedAmount: { amount, currency: "USD" } } }),
    opportunity: { id: OPP_ID, title: "Opportunity" },
    createdAt: "2026-01-01T00:00:00Z",
    lastModifiedAt: "2026-01-01T00:00:00Z",
  });
}

function snapshotOf(awards: ReturnType<typeof award>[]): Snapshot {
  return {
    asOf: "2026-11-02T00:00:00Z",
    report: {
      usaSpending: {
        agencies: [],
        awardTypeCodes: [],
        timePeriod: { startDate: "", endDate: "" },
      },
      funnel: {
        awardsFetched: 0,
        awardsWithOpportunityNumber: 0,
        distinctOpportunityNumbers: 0,
        matchedOpportunityNumbers: 0,
        awardsJoined: 0,
        awardsEmitted: awards.length,
        awardsRejected: 0,
      },
      unmatchedNumbers: [],
    },
    opportunities: [anOpportunity({ id: OPP_ID }), anOpportunity()],
    awards,
  };
}

describe("award ordering", () => {
  const repository = createAwardRepository(
    snapshotOf([award(3, "50.00"), award(1, undefined), award(2, "50.00"), award(4, "900.00")])
  );

  it("puts awards with no value last, in both directions", async () => {
    for (const sortOrder of ["asc", "desc"] as const) {
      const page = await repository.list({ sortBy: "funding.awardedAmount", sortOrder }, ALL);
      expect(page.items.at(-1)?.title).toBe("Award 1");
    }
  });

  it("breaks ties on ascending id, in both directions", async () => {
    const asc = await repository.list({ sortBy: "funding.awardedAmount", sortOrder: "asc" }, ALL);
    const desc = await repository.list({ sortBy: "funding.awardedAmount", sortOrder: "desc" }, ALL);
    expect(asc.items.map(a => a.title)).toEqual(["Award 2", "Award 3", "Award 4", "Award 1"]);
    expect(desc.items.map(a => a.title)).toEqual(["Award 4", "Award 2", "Award 3", "Award 1"]);
  });
});

describe("opportunity details", () => {
  const snapshot = snapshotOf([award(2, "1.00"), award(1, "1.00")]);
  const repository = createOpportunityRepository(snapshot);

  it("lists the awards an opportunity resulted in, by title", async () => {
    const details = await repository.get(OPP_ID);
    expect(details?.awards?.map(ref => ref.title)).toEqual(["Award 1", "Award 2"]);
  });

  it("publishes an empty list for an opportunity with no awards", async () => {
    const other = snapshot.opportunities[1];
    const details = await repository.get(other?.id ?? "");
    expect(details?.awards).toEqual([]);
  });
});
