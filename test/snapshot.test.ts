/**
 * The bundled snapshot, served end to end.
 *
 * These tests run against real USAspending awards and Simpler.Grants.gov
 * opportunities (`src/data/snapshot.json`), so they check what the reference
 * implementation is for: opportunities linked to the awards they resulted in,
 * in both directions, with every response valid against the published SDK
 * schemas. They assert relationships, not counts or ids, so they keep passing
 * after `pnpm refresh` rewrites the file.
 */

import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  AwardResponseSchema,
  AwardsFilteredResponseSchema,
  AwardsListResponseSchema,
  OkSchema,
  OpportunityDetailsSchema,
} from "@common-grants/sdk/schemas";
import { createAppFromSnapshot } from "../src/app.js";
import { parseSnapshot, type Snapshot } from "../src/data/snapshot.js";

/** The acceptance bar for the reference implementation (#1367). */
const MIN_LINKED_OPPORTUNITIES = 10;

let snapshot: Snapshot;
let app: ReturnType<typeof createAppFromSnapshot>;

beforeAll(() => {
  snapshot = parseSnapshot(fs.readFileSync("src/data/snapshot.json", "utf8"));
  app = createAppFromSnapshot(snapshot);
});

async function getJson(path: string) {
  const res = await app.request(path);
  return { status: res.status, body: (await res.json()) as unknown };
}

function searchAwards(body: unknown) {
  return app.request("/common-grants/awards/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("the bundled snapshot", () => {
  it("parses against the published schemas and states when it was pulled", () => {
    expect(Number.isNaN(Date.parse(snapshot.asOf))).toBe(false);
    expect(snapshot.report.funnel.awardsEmitted).toBe(snapshot.awards.length);
  });

  it(`links at least ${MIN_LINKED_OPPORTUNITIES} real opportunities to their awards`, async () => {
    const linked = [];
    for (const opportunity of snapshot.opportunities) {
      const { status, body } = await getJson(`/common-grants/opportunities/${opportunity.id}`);
      expect(status).toBe(200);
      const parsed = OkSchema(OpportunityDetailsSchema).parse(body);
      if ((parsed.data.awards ?? []).length > 0) linked.push(opportunity.id);
    }
    expect(linked.length).toBeGreaterThanOrEqual(MIN_LINKED_OPPORTUNITIES);
  });

  it("points every award at an opportunity the API also serves", () => {
    const served = new Set(snapshot.opportunities.map(o => o.id));
    for (const award of snapshot.awards) {
      expect(served.has(award.opportunity?.id ?? "")).toBe(true);
    }
  });

  it("carries the federal opportunity number the link was made on", () => {
    for (const award of snapshot.awards) {
      expect(award.opportunity?.identifiers?.["opp:us:fon"]?.id).toBeTruthy();
    }
  });
});

describe("the link, in both directions", () => {
  it("lists the same awards on an opportunity as the opportunityId filter returns", async () => {
    for (const opportunity of snapshot.opportunities) {
      const { body } = await getJson(`/common-grants/opportunities/${opportunity.id}`);
      const listed = (OkSchema(OpportunityDetailsSchema).parse(body).data.awards ?? [])
        .map(ref => ref.id)
        .sort();

      const res = await searchAwards({
        filters: { opportunityId: { operator: "in", value: [opportunity.id] } },
      });
      const found = AwardsFilteredResponseSchema.parse(await res.json())
        .items.map(award => award.id)
        .sort();

      expect(found).toEqual(listed);
    }
  });

  it("serves each award by id with its opportunity reference", async () => {
    const award = snapshot.awards[0];
    if (award === undefined) throw new Error("snapshot has no awards");

    const { status, body } = await getJson(`/common-grants/awards/${award.id}`);

    expect(status).toBe(200);
    expect(AwardResponseSchema.parse(body).data.opportunity?.id).toBe(award.opportunity?.id);
  });
});

describe("award routes over the snapshot", () => {
  it("pages through every award with SDK-valid responses", async () => {
    const seen = new Set<string>();
    for (let page = 1; ; page += 1) {
      const { status, body } = await getJson(`/common-grants/awards?page=${page}&pageSize=7`);
      expect(status).toBe(200);
      const parsed = AwardsListResponseSchema.parse(body);
      if (parsed.items.length === 0) break;
      for (const award of parsed.items) seen.add(award.id);
    }
    expect(seen.size).toBe(snapshot.awards.length);
  });

  it("sorts by awarded amount, largest first", async () => {
    const res = await searchAwards({
      sorting: { sortBy: "funding.awardedAmount", sortOrder: "desc" },
    });
    const amounts = AwardsFilteredResponseSchema.parse(await res.json())
      .items.map(award => award.funding?.awardedAmount)
      .filter(money => money !== undefined)
      .map(money => Number(money.amount));

    expect(amounts.length).toBeGreaterThan(1);
    expect(amounts).toEqual([...amounts].sort((a, b) => b - a));
  });

  it("finds awards by text in the title or description", async () => {
    const award = snapshot.awards[0];
    if (award === undefined) throw new Error("snapshot has no awards");
    const word = award.title.split(/\s+/).find(w => w.length > 5) ?? award.title;

    const res = await searchAwards({ search: word.toUpperCase() });
    const ids = AwardsFilteredResponseSchema.parse(await res.json()).items.map(a => a.id);

    expect(ids).toContain(award.id);
  });

  it("filters by status", async () => {
    const res = await searchAwards({
      filters: { status: { operator: "in", value: ["completed"] } },
    });
    const statuses = AwardsFilteredResponseSchema.parse(await res.json()).items.map(
      award => award.status.value
    );
    expect(statuses.every(status => status === "completed")).toBe(true);
  });
});
