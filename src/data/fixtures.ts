/**
 * An in-memory {@link OpportunityRepository} over the bundled JSON fixtures.
 *
 * This is the reference implementation of the data seam: it shows what real
 * filtering, sorting and paging have to do, using nothing but the protocol's
 * own default filter and sort vocabulary. Replace it with your own repository
 * (see PORTING.md) — the routes never change.
 *
 * Two behaviors are implementation-defined rather than protocol-mandated, and
 * both are covered by tests in `test/fixtures.test.ts`:
 *
 * - Records with no value for the sort key sort **last**, in both directions.
 * - Equal values break the tie on **ascending id**, in both directions, so a
 *   page boundary never straddles two records that compare equal.
 */

import { z } from "zod";
import { OpportunitySchema, type Opportunity } from "./schema.js";
import type {
  OpportunityFilters,
  OpportunityRepository,
  Page,
  Pagination,
  SortField,
  SortSpec,
} from "./repository.js";
// A plain import, so `tsc` emits the JSON into `dist` alongside this file and
// stops doing so the moment nothing imports it. No copy step in the build.
import rawFixtures from "./opportunities.json" with { type: "json" };

// ############################################################################
// Startup parsing
// ############################################################################

/**
 * The bundled data set, parsed once at startup.
 *
 * Parsing here rather than per request means a malformed fixture fails loudly
 * on boot instead of leaking a half-valid response later.
 */
export const opportunities: readonly Opportunity[] = z.array(OpportunitySchema).parse(rawFixtures);

// ############################################################################
// Filtering
// ############################################################################

/** `Money.amount` is a decimal *string*; compare it as a number, not text. */
function moneyAmount(money: { amount: string } | null | undefined): number | undefined {
  if (money == null) return undefined;
  const parsed = Number(money.amount);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** The close date of an opportunity, when it has one with a single date. */
function closeDate(opportunity: Opportunity): Date | undefined {
  const event = opportunity.keyDates?.closeDate;
  return event != null && event.eventType === "singleDate" ? event.date : undefined;
}

/**
 * Whether a value falls in (`between`) or out of (`outside`) an inclusive
 * range. A record with no value never matches either operator — it is unknown,
 * not "outside".
 *
 * An unusable bound is unknown in the same way. `DateRangeFilterSchema` accepts
 * any `YYYY-MM-DD`-shaped string, so an impossible date such as "2026-13-45"
 * reaches here as `NaN`; without this guard `outside` would report every record
 * as falling outside the range.
 *
 * An inverted range (`min` above `max`) is unusable too: taken literally,
 * `between` would match nothing and `outside` every record.
 */
function matchesRange(
  value: number | undefined,
  operator: "between" | "outside",
  min: number,
  max: number
): boolean {
  if (value === undefined || Number.isNaN(min) || Number.isNaN(max) || min > max) return false;
  const inside = value >= min && value <= max;
  return operator === "between" ? inside : !inside;
}

/**
 * A record held in another currency never matches either operator. Without a
 * rate the amounts are not comparable, so the record is unknown relative to
 * the range, like a missing value, rather than "outside" it. This is the
 * template's rule, not the protocol's; see PORTING.md §5.
 */
function matchesMoneyRange(
  value: { amount: string; currency: string } | null | undefined,
  filter: {
    operator: "between" | "outside";
    value: {
      min: { amount: string; currency: string };
      max: { amount: string; currency: string };
    };
  }
): boolean {
  if (
    value == null ||
    value.currency !== filter.value.min.currency ||
    value.currency !== filter.value.max.currency
  ) {
    return false;
  }

  const amount = moneyAmount(value);
  const min = moneyAmount(filter.value.min);
  const max = moneyAmount(filter.value.max);
  if (amount === undefined || min === undefined || max === undefined) return false;
  return matchesRange(amount, filter.operator, min, max);
}

function matches(opportunity: Opportunity, filters: OpportunityFilters): boolean {
  const {
    status,
    closeDateRange,
    totalFundingAvailableRange,
    minAwardAmountRange,
    maxAwardAmountRange,
  } = filters;

  if (status != null) {
    const listed = status.value.includes(opportunity.status.value);
    if (status.operator === "in" ? !listed : listed) return false;
  }

  if (closeDateRange != null) {
    const date = closeDate(opportunity);
    const matched = matchesRange(
      date?.getTime(),
      closeDateRange.operator,
      Date.parse(closeDateRange.value.min),
      Date.parse(closeDateRange.value.max)
    );
    if (!matched) return false;
  }

  if (
    totalFundingAvailableRange != null &&
    !matchesMoneyRange(opportunity.funding?.totalAmountAvailable, totalFundingAvailableRange)
  ) {
    return false;
  }

  if (
    minAwardAmountRange != null &&
    !matchesMoneyRange(opportunity.funding?.minAwardAmount, minAwardAmountRange)
  ) {
    return false;
  }

  if (
    maxAwardAmountRange != null &&
    !matchesMoneyRange(opportunity.funding?.maxAwardAmount, maxAwardAmountRange)
  ) {
    return false;
  }

  return true;
}

// ############################################################################
// Sorting
// ############################################################################

/** Every protocol sort key this repository can execute, and how to read it. */
const SORT_KEYS: Record<SortField, (o: Opportunity) => string | number | undefined> = {
  lastModifiedAt: o => o.lastModifiedAt.getTime(),
  createdAt: o => o.createdAt.getTime(),
  title: o => o.title,
  "status.value": o => o.status.value,
  "keyDates.closeDate": o => closeDate(o)?.getTime(),
  "funding.maxAwardAmount": o => moneyAmount(o.funding?.maxAwardAmount),
  "funding.minAwardAmount": o => moneyAmount(o.funding?.minAwardAmount),
  "funding.totalAmountAvailable": o => moneyAmount(o.funding?.totalAmountAvailable),
  "funding.estimatedAwardCount": o => o.funding?.estimatedAwardCount ?? undefined,
};

function compareValues(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  // Code-unit comparison, not `localeCompare`: the order must not depend on
  // the server's locale.
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function sorted(items: Opportunity[], { sortBy, sortOrder }: SortSpec): Opportunity[] {
  const read = SORT_KEYS[sortBy];
  const direction = sortOrder === "desc" ? -1 : 1;

  return [...items].sort((left, right) => {
    const a = read(left);
    const b = read(right);

    if (a === undefined || b === undefined) {
      if (a !== b) return a === undefined ? 1 : -1; // absent values last, always
    } else {
      const compared = compareValues(a, b);
      if (compared !== 0) return compared * direction;
    }

    return compareValues(left.id, right.id);
  });
}

// ############################################################################
// Paging
// ############################################################################

function paginate(items: Opportunity[], { page, pageSize }: Pagination): Page<Opportunity> {
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), totalItems: items.length };
}

// ############################################################################
// Repository
// ############################################################################

export const fixtureRepository: OpportunityRepository = {
  async list(sorting, pagination) {
    return paginate(sorted([...opportunities], sorting), pagination);
  },

  async get(id) {
    return opportunities.find(opportunity => opportunity.id === id) ?? null;
  },

  async search(filters, sorting, pagination) {
    const matched = opportunities.filter(opportunity => matches(opportunity, filters));
    return paginate(sorted(matched, sorting), pagination);
  },
};
