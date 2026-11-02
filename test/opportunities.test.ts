import { describe, expect, it, vi } from "vitest";
import {
  ErrorSchema,
  FilteredSchema,
  NotFoundSchema,
  OkSchema,
  OppFiltersSchema,
  PaginatedSchema,
} from "@common-grants/sdk/schemas";
import { createApp } from "../src/app.js";
import { OpportunitySchema } from "../src/data/schema.js";
import { aMalformedOpportunity, anOpportunity, pageOf, stubRepository } from "./support.js";
import type { StubResponses } from "./support.js";

const BASE = "/common-grants/opportunities";

/** The list route's order: owned by the route layer, handed to the repository. */
const NEWEST_FIRST = { sortBy: "lastModifiedAt", sortOrder: "desc" };

const ListResponseSchema = PaginatedSchema(OpportunitySchema);
const DetailResponseSchema = OkSchema(OpportunitySchema);
const SearchResponseSchema = FilteredSchema(OpportunitySchema, OppFiltersSchema);

function harness(responses: StubResponses = {}) {
  const stub = stubRepository(responses);
  return { app: createApp(stub), calls: stub.calls };
}

function search(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request(`${BASE}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Silences the deliberate server-side diagnostics an expected 500 emits. */
function withSilencedErrors<T>(run: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  return run().finally(() => spy.mockRestore());
}

// ############################################################################
// GET /common-grants/opportunities
// ############################################################################

describe("list opportunities", () => {
  it("returns a schema-valid paginated envelope", async () => {
    const items = [anOpportunity(), anOpportunity(), anOpportunity()];
    const { app } = harness({ list: pageOf(items, 7) });

    const res = await app.request(BASE);

    expect(res.status).toBe(200);
    const body = ListResponseSchema.parse(await res.json());
    expect(body.status).toBe(200);
    expect(body.items.map(o => o.id)).toEqual(items.map(o => o.id));
    expect(body.paginationInfo).toEqual({
      page: 1,
      pageSize: 100,
      totalItems: 7,
      totalPages: 1,
    });
  });

  it("applies the SDK pagination defaults when no query is supplied", async () => {
    const { app, calls } = harness();
    await app.request(BASE);
    expect(calls.list).toEqual([{ sorting: NEWEST_FIRST, pagination: { page: 1, pageSize: 100 } }]);
  });

  it("coerces valid numeric query strings before validation", async () => {
    const { app, calls } = harness();
    await app.request(`${BASE}?page=3&pageSize=25`);
    expect(calls.list).toEqual([{ sorting: NEWEST_FIRST, pagination: { page: 3, pageSize: 25 } }]);
  });

  it("reports the requested page size, not the page length", async () => {
    const { app } = harness({ list: pageOf([anOpportunity()], 21) });
    const res = await app.request(`${BASE}?pageSize=10`);
    const body = ListResponseSchema.parse(await res.json());
    expect(body.paginationInfo.totalPages).toBe(3);
    expect(body.paginationInfo.pageSize).toBe(10);
  });

  // Core `pagination.tsp` requires `pageSize >= 1` on responses, so an empty
  // page must still report the requested size rather than the item count.
  it("reports the requested page size on an empty page past the end", async () => {
    const { app } = harness({ list: pageOf([], 21) });
    const res = await app.request(`${BASE}?page=999&pageSize=10`);
    const body = ListResponseSchema.parse(await res.json());
    expect(body.items).toEqual([]);
    expect(body.paginationInfo).toEqual({ page: 999, pageSize: 10, totalItems: 21, totalPages: 3 });
  });

  // The protocol constrains pageSize to a positive integer and nothing more:
  // `PaginatedQueryParamsSchema` and core/lib/core/pagination.tsp both declare
  // only `@minValue(1)`. This API must not invent a ceiling of its own.
  it.each([
    ["a large page size", 1000],
    ["a very large page size", 100000],
  ])("accepts %s and passes it through unchanged", async (_label, pageSize) => {
    const { app, calls } = harness();

    const res = await app.request(`${BASE}?pageSize=${pageSize}`);

    expect(res.status).toBe(200);
    expect(calls.list).toEqual([{ sorting: NEWEST_FIRST, pagination: { page: 1, pageSize } }]);
  });

  it.each([
    ["a non-numeric page", `${BASE}?page=abc`],
    ["a zero page", `${BASE}?page=0`],
    ["a negative page size", `${BASE}?pageSize=-1`],
    ["a zero page size", `${BASE}?pageSize=0`],
    ["a fractional page", `${BASE}?page=1.5`],
    ["a fractional page size", `${BASE}?pageSize=2.5`],
  ])("rejects %s with an ErrorSchema-valid 400", async (_label, url) => {
    const { app, calls } = harness();
    const res = await app.request(url);

    expect(res.status).toBe(400);
    const body = ErrorSchema.parse(await res.json());
    expect(body.status).toBe(400);
    expect(body.errors.length).toBeGreaterThan(0);
    expect(calls.list).toEqual([]);
  });

  it("returns 500 rather than a malformed 200 when the repository lies", async () => {
    await withSilencedErrors(async () => {
      const { app } = harness({ list: pageOf([aMalformedOpportunity()]) });
      const res = await app.request(BASE);

      expect(res.status).toBe(500);
      expect(ErrorSchema.parse(await res.json()).status).toBe(500);
    });
  });
});

// ############################################################################
// GET /common-grants/opportunities/{oppId}
// ############################################################################

describe("get an opportunity", () => {
  it("returns a schema-valid 200 envelope", async () => {
    const opportunity = anOpportunity();
    const { app, calls } = harness({ get: opportunity });

    const res = await app.request(`${BASE}/${opportunity.id}`);

    expect(res.status).toBe(200);
    const body = DetailResponseSchema.parse(await res.json());
    expect(body.data.id).toBe(opportunity.id);
    expect(calls.get).toEqual([opportunity.id]);
  });

  it("returns a NotFoundSchema-valid 404 for a valid id that has no record", async () => {
    const { app } = harness({ get: null });

    const res = await app.request(`${BASE}/11111111-2222-4333-8444-555555555555`);

    expect(res.status).toBe(404);
    const body = NotFoundSchema.parse(await res.json());
    expect(body.status).toBe(404);
  });

  it("returns an ErrorSchema-valid 400 for an id that is not a UUID", async () => {
    const { app, calls } = harness();

    const res = await app.request(`${BASE}/not-a-uuid`);

    expect(res.status).toBe(400);
    expect(ErrorSchema.parse(await res.json()).status).toBe(400);
    expect(calls.get).toEqual([]);
  });

  it("returns 500 rather than a malformed 200 when the repository lies", async () => {
    await withSilencedErrors(async () => {
      const { app } = harness({ get: aMalformedOpportunity() });
      const res = await app.request(`${BASE}/11111111-2222-4333-8444-555555555555`);

      expect(res.status).toBe(500);
      expect(ErrorSchema.parse(await res.json()).status).toBe(500);
    });
  });
});

// ############################################################################
// POST /common-grants/opportunities/search
// ############################################################################

describe("search opportunities", () => {
  it("returns a schema-valid filtered envelope", async () => {
    const items = [anOpportunity(), anOpportunity()];
    const { app } = harness({ search: pageOf(items, 2) });

    const res = await search(app, {});

    expect(res.status).toBe(200);
    const body = SearchResponseSchema.parse(await res.json());
    expect(body.items).toHaveLength(2);
    expect(body.sortInfo).toEqual({ sortBy: "lastModifiedAt", sortOrder: "desc" });
  });

  it("accepts a request with no body at all", async () => {
    const { app, calls } = harness();
    const res = await app.request(`${BASE}/search`, { method: "POST" });

    expect(res.status).toBe(200);
    expect(calls.search).toEqual([
      {
        filters: {},
        sorting: { sortBy: "lastModifiedAt", sortOrder: "desc" },
        pagination: { page: 1, pageSize: 100 },
      },
    ]);
  });

  it("passes the protocol's default filters straight through to the repository", async () => {
    const { app, calls } = harness();
    const filters = { status: { operator: "in", value: ["open"] } };

    await search(app, { filters });

    expect(calls.search[0]).toMatchObject({ filters });
  });

  it("echoes only the filters that were actually applied", async () => {
    const { app } = harness();
    const filters = { status: { operator: "in", value: ["open"] } };

    const res = await search(app, { filters });

    const body = SearchResponseSchema.parse(await res.json());
    expect(body.filterInfo.filters).toEqual(filters);
    expect(body.filterInfo.errors).toBeUndefined();
  });

  it("ignores unsupported custom filters and says so", async () => {
    const { app, calls } = harness();

    const res = await search(app, {
      filters: { customFilters: { region: { operator: "eq", value: "west" } } },
    });

    const body = SearchResponseSchema.parse(await res.json());
    expect(body.filterInfo.errors).toEqual([
      'Custom filter "region" is not supported by this API and was ignored.',
    ]);
    // The ignored filter is not reported as applied, and never reaches the data layer.
    expect(body.filterInfo.filters).not.toHaveProperty("customFilters");
    expect(calls.search[0]).toEqual({
      filters: {},
      sorting: { sortBy: "lastModifiedAt", sortOrder: "desc" },
      pagination: { page: 1, pageSize: 100 },
    });
  });

  it("reports that free-text search was ignored", async () => {
    const { app } = harness();
    const res = await search(app, { search: "broadband" });

    const body = SearchResponseSchema.parse(await res.json());
    expect(body.filterInfo.errors).toEqual([
      "Free-text search is not implemented by this API and was ignored.",
    ]);
  });

  it("falls back to the default order for a custom sort key and says so", async () => {
    const { app, calls } = harness();

    const res = await search(app, { sorting: { sortBy: "custom", customSortBy: "relevance" } });

    const body = SearchResponseSchema.parse(await res.json());
    expect(body.sortInfo.sortBy).toBe("lastModifiedAt");
    expect(body.sortInfo.sortOrder).toBe("desc");
    expect(body.sortInfo.customSortBy).toBe("relevance");
    expect(body.sortInfo.errors?.[0]).toContain("relevance");
    expect(calls.search[0]).toMatchObject({
      sorting: { sortBy: "lastModifiedAt", sortOrder: "desc" },
    });
  });

  it("defaults an explicitly requested sort key to ascending", async () => {
    const { app, calls } = harness();

    const res = await search(app, { sorting: { sortBy: "title" } });

    const body = SearchResponseSchema.parse(await res.json());
    expect(body.sortInfo).toEqual({ sortBy: "title", sortOrder: "asc" });
    expect(calls.search[0]).toMatchObject({ sorting: { sortBy: "title", sortOrder: "asc" } });
  });

  it("normalizes the SDK's nullable sortOrder into a concrete direction", async () => {
    const { app, calls } = harness();

    const res = await search(app, {
      sorting: { sortBy: "funding.maxAwardAmount", sortOrder: null },
    });

    const body = SearchResponseSchema.parse(await res.json());
    expect(body.sortInfo.sortOrder).toBe("asc");
    expect(calls.search[0]).toMatchObject({
      sorting: { sortBy: "funding.maxAwardAmount", sortOrder: "asc" },
    });
  });

  // Zero matches means zero pages: totalPages is derived from totalItems, and
  // the protocol puts no minimum on it. The SDK client stops once
  // `page >= totalPages`, so 0 ends pagination on the first request.
  it("reports zero pages when nothing matches", async () => {
    const { app } = harness();

    const body = SearchResponseSchema.parse(await (await search(app, {})).json());

    expect(body.items).toEqual([]);
    expect(body.paginationInfo).toEqual({ page: 1, pageSize: 100, totalItems: 0, totalPages: 0 });
  });

  it("honours body pagination", async () => {
    const { app, calls } = harness();
    await search(app, { pagination: { page: 4, pageSize: 5 } });
    expect(calls.search[0]).toMatchObject({ pagination: { page: 4, pageSize: 5 } });
  });

  it.each([
    ["an unknown filter operator", { filters: { status: { operator: "nope", value: ["open"] } } }],
    [
      "a filter value of the wrong type",
      { filters: { status: { operator: "in", value: "open" } } },
    ],
    ["an unknown sort key", { sorting: { sortBy: "nope" } }],
    ["a zero page", { pagination: { page: 0 } }],
    ["a non-numeric page", { pagination: { page: "2" } }],
  ])("rejects %s with an ErrorSchema-valid 400", async (_label, body) => {
    const { app, calls } = harness();

    const res = await search(app, body);

    expect(res.status).toBe(400);
    expect(ErrorSchema.parse(await res.json()).status).toBe(400);
    expect(calls.search).toEqual([]);
  });

  it("returns 500 rather than a malformed 200 when the repository lies", async () => {
    await withSilencedErrors(async () => {
      const { app } = harness({ search: pageOf([aMalformedOpportunity()]) });
      const res = await search(app, {});

      expect(res.status).toBe(500);
      expect(ErrorSchema.parse(await res.json()).status).toBe(500);
    });
  });
});

// ############################################################################
// Serialization
// ############################################################################

describe("date serialization", () => {
  it("keeps date-only and datetime wire formats through the response envelope", async () => {
    const opportunity = anOpportunity();
    const { app } = harness({ get: opportunity });

    const res = await app.request(`${BASE}/${opportunity.id}`);
    const raw = (await res.json()) as {
      data: { lastModifiedAt: string; keyDates: { closeDate: { date: string } } };
    };

    expect(raw.data.keyDates.closeDate.date).toBe("2026-05-01");
    expect(raw.data.lastModifiedAt).toBe("2026-01-02T00:00:00.000Z");
  });
});
