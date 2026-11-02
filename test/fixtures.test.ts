import { describe, expect, it } from "vitest";
import { fixtureRepository, opportunities } from "../src/data/fixtures.js";
import type { OpportunityFilters, SortSpec } from "../src/data/repository.js";

const ALL_PAGES = { page: 1, pageSize: 100 };
const BY_LAST_MODIFIED_DESC: SortSpec = { sortBy: "lastModifiedAt", sortOrder: "desc" };

const ID = {
  cleanWater: "0f8d3c1a-4b2e-4c6f-9a10-000000000001",
  broadband: "1a9e4d2b-5c3f-4d70-8b21-000000000002",
  arts: "2b0f5e3c-6d40-4e81-9c32-000000000003",
  stem: "3c1a6f4d-7e51-4f92-8d43-000000000004",
  wildfire: "4d2b7a5e-8f62-4a03-9e54-000000000005",
  historic: "5e3c8b6f-9073-4b14-8f65-000000000006",
  vouchers: "6f4d9c70-a184-4c25-9076-000000000007",
  coastal: "7a5e0d81-b295-4d36-8187-000000000008",
} as const;

/** Descending `lastModifiedAt`; the broadband/STEM tie breaks on ascending id. */
const NEWEST_FIRST = [
  ID.broadband,
  ID.stem,
  ID.coastal,
  ID.cleanWater,
  ID.wildfire,
  ID.historic,
  ID.arts,
  ID.vouchers,
];

async function searchIds(
  filters: OpportunityFilters,
  sorting: SortSpec = BY_LAST_MODIFIED_DESC
): Promise<string[]> {
  const page = await fixtureRepository.search(filters, sorting, ALL_PAGES);
  return page.items.map(item => item.id);
}

describe("fixture parsing", () => {
  it("parses every bundled record against the shared opportunity schema", () => {
    expect(opportunities).toHaveLength(8);
    expect(new Set(opportunities.map(o => o.id)).size).toBe(8);
  });

  it("produces Date values for date-valued fields rather than strings", () => {
    const cleanWater = opportunities.find(o => o.id === ID.cleanWater);
    expect(cleanWater?.lastModifiedAt).toBeInstanceOf(Date);
    expect(cleanWater?.keyDates?.closeDate?.eventType).toBe("singleDate");
    const closeDate = cleanWater?.keyDates?.closeDate;
    expect(closeDate && "date" in closeDate ? closeDate.date : undefined).toBeInstanceOf(Date);
  });

  it("keeps the date-only wire format when a parsed date is serialized", () => {
    const cleanWater = opportunities.find(o => o.id === ID.cleanWater);
    const closeDate = cleanWater?.keyDates?.closeDate;
    const date = closeDate && "date" in closeDate ? closeDate.date : undefined;
    expect(JSON.parse(JSON.stringify({ date }))).toEqual({ date: "2026-03-31" });
  });
});

describe("get", () => {
  it("returns the record with the requested id", async () => {
    const found = await fixtureRepository.get(ID.wildfire);
    expect(found?.title).toBe("Wildfire Resilience Planning");
  });

  it("returns null for a well-formed id that is not in the data set", async () => {
    expect(await fixtureRepository.get("00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});

describe("list", () => {
  it("applies the order it is given", async () => {
    const page = await fixtureRepository.list(BY_LAST_MODIFIED_DESC, ALL_PAGES);
    expect(page.items.map(o => o.id)).toEqual(NEWEST_FIRST);
    expect(page.totalItems).toBe(8);
  });

  it("returns the first page and the total across all pages", async () => {
    const page = await fixtureRepository.list(BY_LAST_MODIFIED_DESC, { page: 1, pageSize: 3 });
    expect(page.items.map(o => o.id)).toEqual(NEWEST_FIRST.slice(0, 3));
    expect(page.totalItems).toBe(8);
  });

  it("returns a later, partially filled page", async () => {
    const page = await fixtureRepository.list(BY_LAST_MODIFIED_DESC, { page: 3, pageSize: 3 });
    expect(page.items.map(o => o.id)).toEqual(NEWEST_FIRST.slice(6));
    expect(page.totalItems).toBe(8);
  });

  it("returns an empty page past the end without changing the total", async () => {
    const page = await fixtureRepository.list(BY_LAST_MODIFIED_DESC, { page: 4, pageSize: 3 });
    expect(page.items).toEqual([]);
    expect(page.totalItems).toBe(8);
  });
});

describe("search filters", () => {
  it("matches a status `in` filter", async () => {
    expect(await searchIds({ status: { operator: "in", value: ["open"] } })).toEqual([
      ID.broadband,
      ID.coastal,
      ID.cleanWater,
      ID.wildfire,
    ]);
  });

  it("matches a status `notIn` filter", async () => {
    expect(await searchIds({ status: { operator: "notIn", value: ["open"] } })).toEqual([
      ID.stem,
      ID.historic,
      ID.arts,
      ID.vouchers,
    ]);
  });

  it("treats both ends of a `between` date range as inclusive", async () => {
    const ids = await searchIds({
      closeDateRange: { operator: "between", value: { min: "2026-01-01", max: "2026-06-30" } },
    });
    expect(ids).toEqual([ID.broadband, ID.cleanWater, ID.wildfire]);
  });

  it("excludes records with no value for the filtered date field", async () => {
    const ids = await searchIds({
      closeDateRange: { operator: "outside", value: { min: "2026-01-01", max: "2026-06-30" } },
    });
    expect(ids).toEqual([ID.stem, ID.coastal, ID.arts, ID.vouchers]);
    expect(ids).not.toContain(ID.historic);
  });

  // `DateRangeFilterSchema` only checks the `YYYY-MM-DD` shape, so an impossible
  // date reaches the repository. Treat the bound as unknown, the way a missing
  // value is treated, rather than reporting every record as outside the range.
  it.each(["between", "outside"] as const)(
    "matches nothing for an unusable %s date bound",
    async operator => {
      const ids = await searchIds({
        closeDateRange: { operator, value: { min: "2026-13-45", max: "2026-13-45" } },
      });
      expect(ids).toEqual([]);
    }
  );

  // `min` above `max` is unusable in the same way: taken literally, `between`
  // would match nothing and `outside` every record.
  it.each(["between", "outside"] as const)(
    "matches nothing for an inverted %s date range",
    async operator => {
      const ids = await searchIds({
        closeDateRange: { operator, value: { min: "2026-06-30", max: "2026-01-01" } },
      });
      expect(ids).toEqual([]);
    }
  );

  it("compares money ranges numerically, not lexically", async () => {
    const ids = await searchIds({
      maxAwardAmountRange: {
        operator: "between",
        value: {
          min: { amount: "10000.00", currency: "USD" },
          max: { amount: "250000.00", currency: "USD" },
        },
      },
    });
    expect(ids).toEqual([ID.stem, ID.cleanWater, ID.wildfire, ID.arts, ID.vouchers]);
  });

  it("excludes money amounts denominated in a different currency", async () => {
    const ids = await searchIds({
      maxAwardAmountRange: {
        operator: "between",
        value: {
          min: { amount: "10000.00", currency: "EUR" },
          max: { amount: "250000.00", currency: "EUR" },
        },
      },
    });
    expect(ids).toEqual([]);
  });

  it("matches a total-funding `between` range at both edges", async () => {
    const ids = await searchIds({
      totalFundingAvailableRange: {
        operator: "between",
        value: {
          min: { amount: "250000.00", currency: "USD" },
          max: { amount: "5000000.00", currency: "USD" },
        },
      },
    });
    expect(ids).toEqual([ID.stem, ID.cleanWater, ID.wildfire, ID.arts, ID.vouchers]);
  });

  it("matches a total-funding `outside` range and excludes missing values", async () => {
    const ids = await searchIds({
      totalFundingAvailableRange: {
        operator: "outside",
        value: {
          min: { amount: "250000.00", currency: "USD" },
          max: { amount: "5000000.00", currency: "USD" },
        },
      },
    });
    expect(ids).toEqual([ID.broadband]);
    expect(ids).not.toContain(ID.historic);
  });

  it("matches a min-award `between` range", async () => {
    const ids = await searchIds({
      minAwardAmountRange: {
        operator: "between",
        value: {
          min: { amount: "1000.00", currency: "USD" },
          max: { amount: "25000.00", currency: "USD" },
        },
      },
    });
    expect(ids).toEqual([ID.stem, ID.wildfire, ID.arts, ID.vouchers]);
  });

  it("matches a min-award `outside` range and excludes missing values", async () => {
    const ids = await searchIds({
      minAwardAmountRange: {
        operator: "outside",
        value: {
          min: { amount: "5000.00", currency: "USD" },
          max: { amount: "100000.00", currency: "USD" },
        },
      },
    });
    expect(ids).toEqual([ID.arts]);
    expect(ids).not.toContain(ID.historic);
  });

  it("matches a max-award `outside` range and excludes missing values", async () => {
    const ids = await searchIds({
      maxAwardAmountRange: {
        operator: "outside",
        value: {
          min: { amount: "50000.00", currency: "USD" },
          max: { amount: "250000.00", currency: "USD" },
        },
      },
    });
    expect(ids).toEqual([ID.broadband, ID.arts]);
    expect(ids).not.toContain(ID.historic);
  });

  // Coastal Habitat Restoration is the one EUR record. Its max award satisfies
  // both of these ranges numerically, and only the EUR versions see it.
  const CROSS_CURRENCY_RANGES = [
    ["between", { min: "1000000.00", max: "5000000.00" }],
    ["outside", { min: "10000.00", max: "250000.00" }],
  ] as const;

  function maxAwardIds(
    operator: "between" | "outside",
    range: { min: string; max: string },
    currency: string
  ): Promise<string[]> {
    return searchIds({
      maxAwardAmountRange: {
        operator,
        value: {
          min: { amount: range.min, currency },
          max: { amount: range.max, currency },
        },
      },
    });
  }

  it.each(CROSS_CURRENCY_RANGES)(
    "keeps a record in another currency out of a USD `%s` range",
    async (operator, range) => {
      expect(await maxAwardIds(operator, range, "USD")).not.toContain(ID.coastal);
    }
  );

  it.each(CROSS_CURRENCY_RANGES)(
    "matches the EUR record against a EUR `%s` range",
    async (operator, range) => {
      expect(await maxAwardIds(operator, range, "EUR")).toEqual([ID.coastal]);
    }
  );

  it("combines multiple filters with AND", async () => {
    const ids = await searchIds({
      status: { operator: "in", value: ["open"] },
      closeDateRange: { operator: "between", value: { min: "2026-01-01", max: "2026-06-30" } },
    });
    expect(ids).toEqual([ID.broadband, ID.cleanWater, ID.wildfire]);
  });

  it("returns every record when no filter is supplied", async () => {
    expect(await searchIds({})).toEqual(NEWEST_FIRST);
  });

  it("paginates filtered results and reports the filtered total", async () => {
    const page = await fixtureRepository.search(
      { status: { operator: "in", value: ["open"] } },
      { sortBy: "lastModifiedAt", sortOrder: "desc" },
      { page: 2, pageSize: 3 }
    );
    expect(page.items.map(o => o.id)).toEqual([ID.wildfire]);
    expect(page.totalItems).toBe(4);
  });
});

describe("search sorting", () => {
  const cases: Array<{
    sortBy: SortSpec["sortBy"];
    asc: string[];
    desc: string[];
  }> = [
    {
      sortBy: "lastModifiedAt",
      asc: [
        ID.vouchers,
        ID.arts,
        ID.historic,
        ID.wildfire,
        ID.cleanWater,
        ID.coastal,
        ID.broadband,
        ID.stem,
      ],
      desc: NEWEST_FIRST,
    },
    {
      sortBy: "createdAt",
      asc: [
        ID.arts,
        ID.vouchers,
        ID.wildfire,
        ID.cleanWater,
        ID.historic,
        ID.stem,
        ID.broadband,
        ID.coastal,
      ],
      desc: [
        ID.coastal,
        ID.broadband,
        ID.stem,
        ID.historic,
        ID.cleanWater,
        ID.wildfire,
        ID.vouchers,
        ID.arts,
      ],
    },
    {
      sortBy: "title",
      asc: [
        ID.cleanWater,
        ID.coastal,
        ID.arts,
        ID.historic,
        ID.broadband,
        ID.stem,
        ID.vouchers,
        ID.wildfire,
      ],
      desc: [
        ID.wildfire,
        ID.vouchers,
        ID.stem,
        ID.broadband,
        ID.historic,
        ID.arts,
        ID.coastal,
        ID.cleanWater,
      ],
    },
    {
      sortBy: "status.value",
      asc: [
        ID.arts,
        ID.vouchers,
        ID.historic,
        ID.stem,
        ID.cleanWater,
        ID.broadband,
        ID.wildfire,
        ID.coastal,
      ],
      desc: [
        ID.cleanWater,
        ID.broadband,
        ID.wildfire,
        ID.coastal,
        ID.stem,
        ID.historic,
        ID.arts,
        ID.vouchers,
      ],
    },
    {
      sortBy: "keyDates.closeDate",
      asc: [
        ID.arts,
        ID.vouchers,
        ID.cleanWater,
        ID.wildfire,
        ID.broadband,
        ID.stem,
        ID.coastal,
        ID.historic,
      ],
      desc: [
        ID.coastal,
        ID.stem,
        ID.broadband,
        ID.cleanWater,
        ID.wildfire,
        ID.vouchers,
        ID.arts,
        ID.historic,
      ],
    },
    {
      sortBy: "funding.maxAwardAmount",
      asc: [
        ID.arts,
        ID.vouchers,
        ID.stem,
        ID.wildfire,
        ID.cleanWater,
        ID.broadband,
        ID.coastal,
        ID.historic,
      ],
      desc: [
        ID.coastal,
        ID.broadband,
        ID.cleanWater,
        ID.wildfire,
        ID.stem,
        ID.vouchers,
        ID.arts,
        ID.historic,
      ],
    },
    {
      sortBy: "funding.minAwardAmount",
      asc: [
        ID.arts,
        ID.vouchers,
        ID.wildfire,
        ID.stem,
        ID.cleanWater,
        ID.broadband,
        ID.coastal,
        ID.historic,
      ],
      desc: [
        ID.coastal,
        ID.broadband,
        ID.cleanWater,
        ID.stem,
        ID.wildfire,
        ID.vouchers,
        ID.arts,
        ID.historic,
      ],
    },
    {
      sortBy: "funding.totalAmountAvailable",
      asc: [
        ID.arts,
        ID.wildfire,
        ID.vouchers,
        ID.stem,
        ID.cleanWater,
        ID.broadband,
        ID.coastal,
        ID.historic,
      ],
      desc: [
        ID.coastal,
        ID.broadband,
        ID.cleanWater,
        ID.stem,
        ID.vouchers,
        ID.wildfire,
        ID.arts,
        ID.historic,
      ],
    },
    {
      sortBy: "funding.estimatedAwardCount",
      asc: [
        ID.wildfire,
        ID.coastal,
        ID.broadband,
        ID.arts,
        ID.cleanWater,
        ID.stem,
        ID.vouchers,
        ID.historic,
      ],
      desc: [
        ID.vouchers,
        ID.stem,
        ID.cleanWater,
        ID.arts,
        ID.broadband,
        ID.coastal,
        ID.wildfire,
        ID.historic,
      ],
    },
  ];

  it.each(cases)("sorts by $sortBy in both directions", async ({ sortBy, asc, desc }) => {
    expect(await searchIds({}, { sortBy, sortOrder: "asc" })).toEqual(asc);
    expect(await searchIds({}, { sortBy, sortOrder: "desc" })).toEqual(desc);
  });
});
