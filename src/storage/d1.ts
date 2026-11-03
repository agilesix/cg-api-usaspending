/**
 * D1 repositories: the same {@link OpportunityRepository} and
 * {@link AwardRepository} contracts as `src/data/memory.ts`, answered in SQL.
 *
 * They follow the in-memory repositories' implementation-defined rules exactly,
 * and the shared repository tests run against both:
 *
 * - Records with no value for the sort key sort **last**, in both directions.
 * - Equal values break the tie on **ascending id**.
 * - A range filter never matches a record with no value, a value in another
 *   currency, or an unusable range (unparseable or inverted bounds).
 * - Award text search is a case-insensitive substring match on title and
 *   description.
 *
 * Award status is derived when the record is read, from the stored
 * period-of-performance end date, so it never goes stale between refreshes.
 */

import { AwardBaseSchema } from "@common-grants/sdk/schemas";
import { awardStatus } from "../pipeline/award.js";
import { OpportunitySchema, type Opportunity, type OpportunityDetails } from "../data/schema.js";
import type { Award } from "../data/snapshot.js";
import type {
  AwardFilters,
  AwardRepository,
  AwardSortField,
  OpportunityFilters,
  OpportunityRepository,
  Page,
  Pagination,
  SortField,
} from "../data/repository.js";
import type { D1Database } from "./types.js";

type Value = string | number | null;

/** A WHERE clause under construction: SQL fragments plus their bound values. */
class Where {
  readonly clauses: string[] = [];
  readonly values: Value[] = [];
  /** Set when a filter can match nothing, so the query is skipped entirely. */
  impossible = false;

  add(sql: string, ...values: Value[]): void {
    this.clauses.push(sql);
    this.values.push(...values);
  }

  sql(): string {
    return this.clauses.length === 0 ? "" : `WHERE ${this.clauses.join(" AND ")}`;
  }
}

/** Amounts are compared in whole cents, as stored. */
export function toCents(amount: string | number | null | undefined): number | undefined {
  if (amount === null || amount === undefined) return undefined;
  const parsed = Number(amount);
  return Number.isNaN(parsed) ? undefined : Math.round(parsed * 100);
}

function addList(
  where: Where,
  column: string,
  filter: { operator: "in" | "notIn"; value: string[] }
) {
  if (filter.value.length === 0) {
    // `in ()` matches nothing; `notIn ()` matches everything.
    if (filter.operator === "in") where.impossible = true;
    return;
  }
  // One JSON parameter instead of one per value: D1 allows at most 100 bound
  // parameters per statement, and a client can send a longer list.
  where.add(
    `${column} ${filter.operator === "in" ? "IN" : "NOT IN"} (SELECT value FROM json_each(?))`,
    JSON.stringify(filter.value)
  );
}

function addRange(
  where: Where,
  column: string,
  operator: "between" | "outside",
  min: number | undefined,
  max: number | undefined
) {
  if (
    min === undefined ||
    max === undefined ||
    Number.isNaN(min) ||
    Number.isNaN(max) ||
    min > max
  ) {
    where.impossible = true;
    return;
  }
  where.add(
    operator === "between"
      ? `(${column} IS NOT NULL AND ${column} BETWEEN ? AND ?)`
      : `(${column} IS NOT NULL AND (${column} < ? OR ${column} > ?))`,
    min,
    max
  );
}

function addDateRange(
  where: Where,
  column: string,
  filter: { operator: "between" | "outside"; value: { min: string; max: string } }
) {
  addRange(
    where,
    column,
    filter.operator,
    Date.parse(filter.value.min),
    Date.parse(filter.value.max)
  );
}

function addMoneyRange(
  where: Where,
  column: string,
  currencyColumn: string,
  filter: {
    operator: "between" | "outside";
    value: {
      min: { amount: string; currency: string };
      max: { amount: string; currency: string };
    };
  }
) {
  const { min, max } = filter.value;
  if (min.currency !== max.currency) {
    where.impossible = true;
    return;
  }
  where.add(`${currencyColumn} = ?`, min.currency);
  addRange(where, column, filter.operator, toCents(min.amount), toCents(max.amount));
}

/** Absent values last in both directions, then ties on ascending id. */
function orderBy(expression: string, sortOrder: "asc" | "desc"): string {
  return `ORDER BY (${expression}) IS NULL, ${expression} ${sortOrder === "desc" ? "DESC" : "ASC"}, id ASC`;
}

async function page<Row, T>(
  db: D1Database,
  table: string,
  where: Where,
  order: string,
  { page: pageNumber, pageSize }: Pagination,
  read: (row: Row) => T,
  columns = "record_json"
): Promise<Page<T>> {
  if (where.impossible) return { items: [], totalItems: 0 };
  const count = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} ${where.sql()}`)
    .bind(...where.values)
    .first<{ n: number }>();
  const rows = await db
    .prepare(`SELECT ${columns} FROM ${table} ${where.sql()} ${order} LIMIT ? OFFSET ?`)
    .bind(...where.values, pageSize, (pageNumber - 1) * pageSize)
    .all<Row>();
  return { items: rows.results.map(read), totalItems: count?.n ?? 0 };
}

// ############################################################################
// Opportunities
// ############################################################################

const OPPORTUNITY_SORT_COLUMNS: Record<SortField, string> = {
  lastModifiedAt: "last_modified_at",
  createdAt: "created_at",
  title: "title",
  "status.value": "status",
  "keyDates.closeDate": "close_date",
  "funding.maxAwardAmount": "max_award_cents",
  "funding.minAwardAmount": "min_award_cents",
  "funding.totalAmountAvailable": "total_available_cents",
  "funding.estimatedAwardCount": "estimated_award_count",
};

/** Opportunities waiting for their first full record are not served yet. */
const SERVED_OPPORTUNITY = "record_json IS NOT NULL";

function readOpportunity(row: { record_json: string }): Opportunity {
  return OpportunitySchema.parse(JSON.parse(row.record_json));
}

function opportunityWhere(filters: OpportunityFilters): Where {
  const where = new Where();
  where.add(SERVED_OPPORTUNITY);
  const {
    status,
    closeDateRange,
    totalFundingAvailableRange,
    minAwardAmountRange,
    maxAwardAmountRange,
  } = filters;
  if (status != null) addList(where, "status", status);
  if (closeDateRange != null) addDateRange(where, "close_date", closeDateRange);
  if (totalFundingAvailableRange != null) {
    addMoneyRange(
      where,
      "total_available_cents",
      "total_available_currency",
      totalFundingAvailableRange
    );
  }
  if (minAwardAmountRange != null) {
    addMoneyRange(where, "min_award_cents", "min_award_currency", minAwardAmountRange);
  }
  if (maxAwardAmountRange != null) {
    addMoneyRange(where, "max_award_cents", "max_award_currency", maxAwardAmountRange);
  }
  return where;
}

export function createD1OpportunityRepository(
  db: D1Database,
  now: () => Date = () => new Date()
): OpportunityRepository {
  const awards = createD1AwardRepository(db, now);

  return {
    async list(sorting, pagination) {
      return this.search({}, sorting, pagination);
    },

    async get(id): Promise<OpportunityDetails | null> {
      const row = await db
        .prepare(`SELECT record_json FROM opportunities WHERE id = ? AND ${SERVED_OPPORTUNITY}`)
        .bind(id)
        .first<{ record_json: string }>();
      if (row === null) return null;
      const linked = await awards.forOpportunity(id);
      return {
        ...readOpportunity(row),
        awards: linked.map(({ id: awardId, title, identifiers }) => ({
          id: awardId,
          title,
          identifiers,
        })),
      };
    },

    async search(filters, { sortBy, sortOrder }, pagination) {
      return page(
        db,
        "opportunities",
        opportunityWhere(filters),
        orderBy(OPPORTUNITY_SORT_COLUMNS[sortBy], sortOrder),
        pagination,
        readOpportunity
      );
    },
  };
}

// ############################################################################
// Awards
// ############################################################################

/** The status rule from `awardStatus`, in SQL. `?` is today's UTC date. */
const AWARD_STATUS_SQL =
  "(CASE WHEN pop_end IS NOT NULL AND pop_end < ? THEN 'completed' ELSE 'awarded' END)";

const AWARD_SORT_COLUMNS: Record<Exclude<AwardSortField, "status.value">, string> = {
  lastModifiedAt: "last_modified_at",
  createdAt: "created_at",
  title: "title",
  "keyDates.awardDate": "award_date",
  "funding.awardedAmount": "awarded_cents",
};

interface AwardRow {
  record_json: string;
  pop_end: string | null;
}

/** Awards read through here get their status from today's date. */
export interface D1AwardRepository extends AwardRepository {
  /** Every award from one opportunity, by title then id. */
  forOpportunity(opportunityId: string): Promise<Award[]>;
}

function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Escapes LIKE wildcards so the query text is matched literally. */
function likePattern(query: string): string {
  return `%${query.toLowerCase().replace(/[\\%_]/g, c => `\\${c}`)}%`;
}

export function createD1AwardRepository(
  db: D1Database,
  now: () => Date = () => new Date()
): D1AwardRepository {
  function read(row: AwardRow): Award {
    const record = JSON.parse(row.record_json) as Record<string, unknown>;
    record.status = awardStatus(row.pop_end, now());
    return AwardBaseSchema.parse(record);
  }

  function search(
    query: string | undefined,
    filters: AwardFilters,
    sortBy: AwardSortField,
    sortOrder: "asc" | "desc",
    pagination: Pagination
  ): Promise<Page<Award>> {
    const date = today(now());
    const where = new Where();
    // Status is derived, so it is selected under an alias the filters and
    // ordering can use. The alias needs its own bound date.
    const table = `(SELECT *, ${AWARD_STATUS_SQL} AS status FROM awards)`;
    const prefix: Value[] = [date];

    if (query !== undefined) {
      where.add(
        "(lower(title) LIKE ? ESCAPE '\\' OR lower(description) LIKE ? ESCAPE '\\')",
        likePattern(query),
        likePattern(query)
      );
    }
    const { status, opportunityId, awardDateRange, awardedAmountRange } = filters;
    if (status != null) addList(where, "status", status);
    if (opportunityId != null) addList(where, "opportunity_id", opportunityId);
    if (awardDateRange != null) addDateRange(where, "award_date", awardDateRange);
    if (awardedAmountRange != null) {
      addMoneyRange(where, "awarded_cents", "awarded_currency", awardedAmountRange);
    }

    const column = sortBy === "status.value" ? "status" : AWARD_SORT_COLUMNS[sortBy];
    const bound = new Where();
    bound.clauses.push(...where.clauses);
    bound.values.push(...prefix, ...where.values);
    bound.impossible = where.impossible;
    return page<AwardRow, Award>(
      db,
      table,
      bound,
      orderBy(column, sortOrder),
      pagination,
      read,
      "record_json, pop_end"
    );
  }

  return {
    async list({ sortBy, sortOrder }, pagination) {
      return search(undefined, {}, sortBy, sortOrder, pagination);
    },

    async get(id) {
      const row = await db
        .prepare("SELECT record_json, pop_end FROM awards WHERE id = ?")
        .bind(id)
        .first<AwardRow>();
      return row === null ? null : read(row);
    },

    async search(query, filters, { sortBy, sortOrder }, pagination) {
      return search(query, filters, sortBy, sortOrder, pagination);
    },

    async forOpportunity(opportunityId) {
      const rows = await db
        .prepare(
          "SELECT record_json, pop_end FROM awards WHERE opportunity_id = ? ORDER BY title ASC, id ASC"
        )
        .bind(opportunityId)
        .all<AwardRow>();
      return rows.results.map(read);
    },
  };
}
