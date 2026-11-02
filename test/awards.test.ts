/**
 * The awards router against a stub repository: the HTTP contract, independent
 * of the bundled data. `test/snapshot.test.ts` covers the same routes over
 * real records.
 */

import { describe, expect, it, vi } from "vitest";
import {
  AwardBaseSchema,
  AwardResponseSchema,
  AwardsFilteredResponseSchema,
  AwardsListResponseSchema,
  ErrorSchema,
  NotFoundSchema,
} from "@common-grants/sdk/schemas";
import { createApp } from "../src/app.js";
import type { AwardRepository, Page } from "../src/data/repository.js";
import type { Award } from "../src/data/snapshot.js";
import { stubRepository } from "./support.js";

const BASE = "/common-grants/awards";

let seq = 0;

function anAward(overrides: Record<string, unknown> = {}): Award {
  seq += 1;
  const n = String(seq).padStart(12, "0");
  return AwardBaseSchema.parse({
    id: `00000000-0000-5000-8000-${n}`,
    title: `Award ${seq}`,
    description: `Description ${seq}`,
    status: { value: "awarded" },
    funding: { awardedAmount: { amount: "1000.00", currency: "USD" } },
    opportunity: { id: "00000000-0000-4000-8000-000000000001", title: "An opportunity" },
    createdAt: "2026-01-01T00:00:00Z",
    lastModifiedAt: "2026-01-02T00:00:00Z",
    ...overrides,
  });
}

interface Calls {
  list: unknown[];
  get: unknown[];
  search: unknown[];
}

function harness(responses: { page?: Page<Award>; award?: Award | null } = {}) {
  const calls: Calls = { list: [], get: [], search: [] };
  const page = responses.page ?? { items: [], totalItems: 0 };
  const awards: AwardRepository = {
    async list(sorting, pagination) {
      calls.list.push({ sorting, pagination });
      return page;
    },
    async get(id) {
      calls.get.push(id);
      return responses.award ?? null;
    },
    async search(query, filters, sorting, pagination) {
      calls.search.push({ query, filters, sorting, pagination });
      return page;
    },
  };
  const app = createApp({ opportunities: stubRepository().opportunities, awards });
  return { app, calls };
}

function search(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request(`${BASE}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe(`GET ${BASE}`, () => {
  it("lists awards newest-modified first with SDK-valid pagination", async () => {
    const { app, calls } = harness({ page: { items: [anAward(), anAward()], totalItems: 5 } });

    const res = await app.request(`${BASE}?page=2&pageSize=2`);

    expect(res.status).toBe(200);
    const body = AwardsListResponseSchema.parse(await res.json());
    expect(body.paginationInfo).toEqual({ page: 2, pageSize: 2, totalItems: 5, totalPages: 3 });
    expect(calls.list).toEqual([
      {
        sorting: { sortBy: "lastModifiedAt", sortOrder: "desc" },
        pagination: { page: 2, pageSize: 2 },
      },
    ]);
  });

  it("rejects a page size of zero", async () => {
    const res = await harness().app.request(`${BASE}?pageSize=0`);
    expect(res.status).toBe(400);
    expect(ErrorSchema.safeParse(await res.json()).success).toBe(true);
  });
});

describe(`GET ${BASE}/{awdId}`, () => {
  it("returns the award", async () => {
    const award = anAward();
    const res = await harness({ award }).app.request(`${BASE}/${award.id}`);
    expect(res.status).toBe(200);
    expect(AwardResponseSchema.parse(await res.json()).data.id).toBe(award.id);
  });

  it("answers an unknown id with a 404", async () => {
    const res = await harness().app.request(`${BASE}/00000000-0000-5000-8000-999999999999`);
    expect(res.status).toBe(404);
    expect(NotFoundSchema.safeParse(await res.json()).success).toBe(true);
  });

  it("accepts any UUID-shaped id, as the SDK does", async () => {
    // Version and variant bits outside RFC 9562, like USAspending's recipient hashes.
    const res = await harness().app.request(`${BASE}/2f1c0f0e-3a2b-0c4d-0e5f-6a7b8c9d0e1f`);
    expect(res.status).toBe(404);
  });

  it("rejects an id that is not UUID-shaped", async () => {
    const res = await harness().app.request(`${BASE}/not-a-uuid`);
    expect(res.status).toBe(400);
  });

  it("answers an award the SDK rejects with a 500, not bad data", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const award = { ...anAward(), title: undefined } as unknown as Award;

    const res = await harness({ award }).app.request(`${BASE}/${anAward().id}`);

    expect(res.status).toBe(500);
    expect(ErrorSchema.safeParse(await res.json()).success).toBe(true);
    spy.mockRestore();
  });
});

describe(`POST ${BASE}/search`, () => {
  it("passes text, filters, sorting and pagination to the repository", async () => {
    const { app, calls } = harness();
    const filters = { opportunityId: { operator: "in", value: ["abc"] } };

    const res = await search(app, {
      search: "  health  ",
      filters,
      sorting: { sortBy: "funding.awardedAmount", sortOrder: "desc" },
      pagination: { page: 1, pageSize: 10 },
    });

    expect(res.status).toBe(200);
    const body = AwardsFilteredResponseSchema.parse(await res.json());
    expect(body.sortInfo).toEqual({ sortBy: "funding.awardedAmount", sortOrder: "desc" });
    expect(body.filterInfo.filters).toEqual(filters);
    expect(calls.search).toEqual([
      {
        query: "health",
        filters,
        sorting: { sortBy: "funding.awardedAmount", sortOrder: "desc" },
        pagination: { page: 1, pageSize: 10 },
      },
    ]);
  });

  it("accepts an empty body", async () => {
    const res = await harness().app.request(`${BASE}/search`, { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("reports custom filters as ignored instead of applying them", async () => {
    const { app, calls } = harness();

    const res = await search(app, {
      filters: { customFilters: { recipientState: { operator: "eq", value: "MD" } } },
    });

    const body = AwardsFilteredResponseSchema.parse(await res.json());
    expect(body.filterInfo.errors).toEqual([
      'Custom filter "recipientState" is not supported by this API and was ignored.',
    ]);
    expect(calls.search).toMatchObject([{ filters: {} }]);
  });

  it("falls back to the default order for a custom sort key and says so", async () => {
    const res = await search(harness().app, {
      sorting: { sortBy: "custom", customSortBy: "recipientName" },
    });

    const body = AwardsFilteredResponseSchema.parse(await res.json());
    expect(body.sortInfo.sortBy).toBe("lastModifiedAt");
    expect(body.sortInfo.errors?.[0]).toContain('"recipientName"');
  });

  it("rejects fields the protocol's search request does not define", async () => {
    const res = await search(harness().app, { filter: {} });
    expect(res.status).toBe(400);
  });
});
