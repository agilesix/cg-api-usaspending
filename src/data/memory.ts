/**
 * In-memory repositories over one parsed {@link Snapshot}.
 *
 * A snapshot holds a few dozen opportunities and a few dozen awards, so
 * filtering, sorting and paging in memory is the whole job; no database is
 * needed. Both repositories follow the same two implementation-defined rules,
 * and both are covered by tests:
 *
 * - Records with no value for the sort key sort **last**, in both directions.
 * - Equal values break the tie on **ascending id**, in both directions, so a
 *   page boundary never straddles two records that compare equal.
 */

import type { Award, Snapshot } from "./snapshot.js";
import type { Opportunity, OpportunityDetails } from "./schema.js";
import type {
  AwardFilters,
  AwardRepository,
  AwardSortField,
  AwardSortSpec,
  OpportunityFilters,
  OpportunityRepository,
  Page,
  Pagination,
  SortField,
  SortSpec,
} from "./repository.js";

// ############################################################################
// Shared helpers
// ############################################################################

/** `Money.amount` is a decimal *string*; compare it as a number, not text. */
function moneyAmount(money: { amount: string } | null | undefined): number | undefined {
  if (money == null) return undefined;
  const parsed = Number(money.amount);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** The date of a single-date event, when there is one. */
function eventDate(event: { eventType: string } | null | undefined): Date | undefined {
  return event != null && event.eventType === "singleDate" && "date" in event
    ? (event.date as Date)
    : undefined;
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

/** An `in` / `notIn` filter over a list of strings. */
function matchesList(value: string, filter: { operator: "in" | "notIn"; value: string[] }) {
  const listed = filter.value.includes(value);
  return filter.operator === "in" ? listed : !listed;
}

function compareValues(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  // Code-unit comparison, not `localeCompare`: the order must not depend on
  // the server's locale.
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

type SortKey<T> = (record: T) => string | number | undefined;

function sorted<T extends { id: string }>(
  items: readonly T[],
  read: SortKey<T>,
  sortOrder: "asc" | "desc"
): T[] {
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

function paginate<T>(items: T[], { page, pageSize }: Pagination): Page<T> {
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), totalItems: items.length };
}

// ############################################################################
// Opportunities
// ############################################################################

function closeDate(opportunity: Opportunity): Date | undefined {
  return eventDate(opportunity.keyDates?.closeDate);
}

function matchesOpportunity(opportunity: Opportunity, filters: OpportunityFilters): boolean {
  const {
    status,
    closeDateRange,
    totalFundingAvailableRange,
    minAwardAmountRange,
    maxAwardAmountRange,
  } = filters;

  if (status != null && !matchesList(opportunity.status.value, status)) return false;

  if (closeDateRange != null) {
    const matched = matchesRange(
      closeDate(opportunity)?.getTime(),
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

/** Every protocol sort key the opportunity repository can execute, and how to read it. */
const OPPORTUNITY_SORT_KEYS: Record<SortField, SortKey<Opportunity>> = {
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

function sortedOpportunities(items: readonly Opportunity[], { sortBy, sortOrder }: SortSpec) {
  return sorted(items, OPPORTUNITY_SORT_KEYS[sortBy], sortOrder);
}

/**
 * Opportunities, each viewable with the awards it resulted in.
 *
 * The view route publishes the opportunity-to-award link: `awards` is always
 * present, and an empty array means no awards in the snapshot came from it.
 */
export function createOpportunityRepository(snapshot: Snapshot): OpportunityRepository {
  const awardsByOpportunity = new Map<string, Award[]>();
  for (const award of snapshot.awards) {
    const oppId = award.opportunity?.id;
    if (oppId === undefined) continue;
    awardsByOpportunity.set(oppId, [...(awardsByOpportunity.get(oppId) ?? []), award]);
  }

  return {
    async list(sorting, pagination) {
      return paginate(sortedOpportunities(snapshot.opportunities, sorting), pagination);
    },

    async get(id): Promise<OpportunityDetails | null> {
      const opportunity = snapshot.opportunities.find(o => o.id === id);
      if (opportunity === undefined) return null;
      const awards = sorted(awardsByOpportunity.get(id) ?? [], a => a.title, "asc").map(
        ({ id: awardId, title, identifiers }) => ({ id: awardId, title, identifiers })
      );
      return { ...opportunity, awards };
    },

    async search(filters, sorting, pagination) {
      const matched = snapshot.opportunities.filter(o => matchesOpportunity(o, filters));
      return paginate(sortedOpportunities(matched, sorting), pagination);
    },
  };
}

// ############################################################################
// Awards
// ############################################################################

function awardDate(award: Award): Date | undefined {
  return eventDate(award.keyDates?.awardDate);
}

function matchesAward(award: Award, filters: AwardFilters): boolean {
  const { status, opportunityId, awardDateRange, awardedAmountRange } = filters;

  if (status != null && !matchesList(award.status.value, status)) return false;

  if (opportunityId != null && !matchesList(award.opportunity?.id ?? "", opportunityId)) {
    return false;
  }

  if (awardDateRange != null) {
    const matched = matchesRange(
      awardDate(award)?.getTime(),
      awardDateRange.operator,
      Date.parse(awardDateRange.value.min),
      Date.parse(awardDateRange.value.max)
    );
    if (!matched) return false;
  }

  if (
    awardedAmountRange != null &&
    !matchesMoneyRange(award.funding?.awardedAmount, awardedAmountRange)
  ) {
    return false;
  }

  return true;
}

/** Every protocol sort key the award repository can execute, and how to read it. */
const AWARD_SORT_KEYS: Record<AwardSortField, SortKey<Award>> = {
  lastModifiedAt: a => a.lastModifiedAt.getTime(),
  createdAt: a => a.createdAt.getTime(),
  title: a => a.title,
  "status.value": a => a.status.value,
  "keyDates.awardDate": a => awardDate(a)?.getTime(),
  "funding.awardedAmount": a => moneyAmount(a.funding?.awardedAmount),
};

function sortedAwards(items: readonly Award[], { sortBy, sortOrder }: AwardSortSpec) {
  return sorted(items, AWARD_SORT_KEYS[sortBy], sortOrder);
}

/** Free-text search over award titles and descriptions, case-insensitive. */
function matchesText(award: Award, query: string): boolean {
  const needle = query.toLowerCase();
  return (
    award.title.toLowerCase().includes(needle) || award.description.toLowerCase().includes(needle)
  );
}

export function createAwardRepository(snapshot: Snapshot): AwardRepository {
  return {
    async list(sorting, pagination) {
      return paginate(sortedAwards(snapshot.awards, sorting), pagination);
    },

    async get(id) {
      return snapshot.awards.find(award => award.id === id) ?? null;
    },

    async search(query, filters, sorting, pagination) {
      const matched = snapshot.awards.filter(
        award => (query === undefined || matchesText(award, query)) && matchesAward(award, filters)
      );
      return paginate(sortedAwards(matched, sorting), pagination);
    },
  };
}
