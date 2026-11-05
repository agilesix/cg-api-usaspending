/**
 * The D1 repositories against the in-memory ones, over the same data.
 *
 * The bundled snapshot is loaded into both stores, then every list, view and
 * search the routes can issue, across every sort key, both orders and each
 * default filter, must come back identical. That is the guarantee that
 * switching the Worker to D1 changes nothing a client can see.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { createAwardRepository, createOpportunityRepository } from "../src/data/memory.js";
import { SnapshotSchema, type Snapshot } from "../src/data/snapshot.js";
import type {
  AwardFilters,
  AwardRepository,
  AwardSortField,
  OpportunityFilters,
  OpportunityRepository,
  SortField,
} from "../src/data/repository.js";
import { createD1AwardRepository, createD1OpportunityRepository } from "../src/storage/d1.js";
import { upsertAward, upsertOpportunity } from "../src/storage/rows.js";
import bundled from "../src/data/snapshot.json" with { type: "json" };
import { createTestD1 } from "./d1.js";

const snapshot: Snapshot = SnapshotSchema.parse(bundled);
const asOf = new Date(snapshot.asOf);

/** Loads a snapshot into D1 the way a refresh would store it. */
export async function seed(data: Snapshot = snapshot) {
  const db = createTestD1();
  const raw = bundled as unknown as {
    opportunities: { id: string }[];
    awards: { id: string }[];
  };
  const statements = [
    ...raw.opportunities.map(o => {
      const parsed = data.opportunities.find(p => p.id === o.id);
      const fon = parsed?.customFields?.federalOpportunityNumber?.value;
      return upsertOpportunity(db, o, {
        fon: typeof fon === "string" ? fon : "",
        sourceVersion: null,
        rawHash: null,
        runId: "seed",
        syncedAt: snapshot.asOf,
      });
    }),
    ...raw.awards.map(a => {
      const parsed = data.awards.find(p => p.id === a.id);
      const pop = parsed?.keyDates?.periodOfPerformance;
      const popEnd =
        pop !== undefined && pop !== null && "endDate" in pop
          ? (pop.endDate as Date).toISOString().slice(0, 10)
          : null;
      return upsertAward(db, a, {
        sourceKey: a.id,
        popEnd,
        sourceVersion: null,
        rawHash: null,
        syncedAt: snapshot.asOf,
      });
    }),
  ];
  await db.batch(statements);
  return db;
}

let memory: { opportunities: OpportunityRepository; awards: AwardRepository };
let d1: { opportunities: OpportunityRepository; awards: AwardRepository };

beforeAll(async () => {
  const db = await seed();
  memory = {
    opportunities: createOpportunityRepository(snapshot),
    awards: createAwardRepository(snapshot),
  };
  d1 = {
    opportunities: createD1OpportunityRepository(db, () => asOf),
    awards: createD1AwardRepository(db, () => asOf),
  };
});

const PAGES = [
  { page: 1, pageSize: 100 },
  { page: 2, pageSize: 7 },
];

const OPP_SORTS: SortField[] = [
  "lastModifiedAt",
  "createdAt",
  "title",
  "status.value",
  "keyDates.closeDate",
  "funding.maxAwardAmount",
  "funding.minAwardAmount",
  "funding.totalAmountAvailable",
  "funding.estimatedAwardCount",
];

const AWARD_SORTS: AwardSortField[] = [
  "lastModifiedAt",
  "createdAt",
  "title",
  "status.value",
  "keyDates.awardDate",
  "funding.awardedAmount",
];

/** Compares as clients see it: JSON, with ids in order. */
function wire(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

describe("D1 opportunities match the in-memory store", () => {
  it("lists in every sort order and page", async () => {
    for (const sortBy of OPP_SORTS) {
      for (const sortOrder of ["asc", "desc"] as const) {
        for (const pagination of PAGES) {
          const a = await memory.opportunities.list({ sortBy, sortOrder }, pagination);
          const b = await d1.opportunities.list({ sortBy, sortOrder }, pagination);
          expect(b.totalItems).toBe(snapshot.opportunities.length);
          expect(wire(b), `${sortBy} ${sortOrder} p${pagination.page}`).toEqual(wire(a));
        }
      }
    }
  });

  it("views every opportunity with its awards", async () => {
    for (const { id } of snapshot.opportunities) {
      expect(wire(await d1.opportunities.get(id))).toEqual(
        wire(await memory.opportunities.get(id))
      );
    }
    expect(await d1.opportunities.get("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("filters the same way", async () => {
    const usd = (amount: string) => ({ amount, currency: "USD" });
    const filters: OpportunityFilters[] = [
      { status: { operator: "in", value: ["closed", "custom"] } },
      { status: { operator: "notIn", value: ["closed"] } },
      { status: { operator: "in", value: [] } },
      {
        closeDateRange: {
          operator: "between",
          value: { min: "2025-01-01", max: "2025-12-31" },
        },
      },
      {
        closeDateRange: {
          operator: "outside",
          value: { min: "2025-01-01", max: "2025-12-31" },
        },
      },
      {
        closeDateRange: {
          operator: "outside",
          value: { min: "2025-12-31", max: "2025-01-01" },
        },
      },
      {
        totalFundingAvailableRange: {
          operator: "between",
          value: { min: usd("0"), max: usd("5000000") },
        },
      },
      {
        maxAwardAmountRange: {
          operator: "outside",
          value: { min: usd("100000"), max: usd("500000") },
        },
      },
      {
        minAwardAmountRange: {
          operator: "between",
          value: { min: { amount: "0", currency: "EUR" }, max: { amount: "9", currency: "EUR" } },
        },
      },
    ] as OpportunityFilters[];
    for (const filter of filters) {
      const sorting = { sortBy: "title", sortOrder: "asc" } as const;
      const a = await memory.opportunities.search(filter, sorting, PAGES[0]!);
      const b = await d1.opportunities.search(filter, sorting, PAGES[0]!);
      expect(wire(b), `${JSON.stringify(filter)}`).toEqual(wire(a));
    }
  });
});

describe("D1 awards match the in-memory store", () => {
  it("lists in every sort order and page", async () => {
    for (const sortBy of AWARD_SORTS) {
      for (const sortOrder of ["asc", "desc"] as const) {
        for (const pagination of PAGES) {
          const a = await memory.awards.list({ sortBy, sortOrder }, pagination);
          const b = await d1.awards.list({ sortBy, sortOrder }, pagination);
          expect(b.totalItems).toBe(snapshot.awards.length);
          expect(wire(b), `${sortBy} ${sortOrder} p${pagination.page}`).toEqual(wire(a));
        }
      }
    }
  });

  it("views every award", async () => {
    for (const { id } of snapshot.awards) {
      expect(wire(await d1.awards.get(id))).toEqual(wire(await memory.awards.get(id)));
    }
    expect(await d1.awards.get("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("searches and filters the same way", async () => {
    const award = snapshot.awards[0]!;
    const word = award.title.split(/\s+/).find(w => w.length > 4) ?? award.title;
    const usd = (amount: string) => ({ amount, currency: "USD" });
    const cases: [string | undefined, AwardFilters][] = [
      [word.toLowerCase(), {}],
      ["50%_", {}],
      [undefined, { status: { operator: "in", value: ["completed"] } }],
      [undefined, { status: { operator: "notIn", value: ["completed"] } }],
      [undefined, { opportunityId: { operator: "in", value: [award.opportunity!.id] } }],
      [undefined, { opportunityId: { operator: "notIn", value: [award.opportunity!.id] } }],
      [
        undefined,
        {
          awardDateRange: { operator: "between", value: { min: "2026-01-01", max: "2026-06-30" } },
        },
      ],
      [
        undefined,
        {
          awardDateRange: { operator: "outside", value: { min: "2026-01-01", max: "2026-13-45" } },
        },
      ],
      [
        undefined,
        {
          awardedAmountRange: {
            operator: "outside",
            value: { min: usd("100000"), max: usd("1000000") },
          },
        },
      ],
    ] as [string | undefined, AwardFilters][];
    const hits: number[] = [];
    for (const [query, filters] of cases) {
      for (const sortBy of ["funding.awardedAmount", "status.value"] as const) {
        const sorting = { sortBy, sortOrder: "desc" } as const;
        const a = await memory.awards.search(query, filters, sorting, PAGES[0]!);
        const b = await d1.awards.search(query, filters, sorting, PAGES[0]!);
        expect(wire(b), `${query} ${JSON.stringify(filters)} ${sortBy}`).toEqual(wire(a));
        hits.push(b.totalItems);
      }
    }
    // The cases are only a real comparison if most of them match something.
    expect(hits.filter(n => n > 0).length).toBeGreaterThan(hits.length / 2);
  });

  it("accepts filter lists longer than D1's 100-parameter limit", async () => {
    const ids = [
      ...snapshot.awards.map(a => a.opportunity!.id),
      ...Array.from(
        { length: 150 },
        (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
      ),
    ];
    const sorting = { sortBy: "title", sortOrder: "asc" } as const;
    const filters = { opportunityId: { operator: "in", value: ids } } as AwardFilters;
    const b = await d1.awards.search(undefined, filters, sorting, PAGES[0]!);
    expect(b.totalItems).toBe(snapshot.awards.length);
  });

  it("derives status from today, not from when the record was stored", async () => {
    const db = await seed();
    const later = createD1AwardRepository(db, () => new Date("2099-01-01T00:00:00Z"));
    const page = await later.list({ sortBy: "title", sortOrder: "asc" }, PAGES[0]!);
    expect(page.items.every(a => a.status.value === "completed")).toBe(true);
  });
});
