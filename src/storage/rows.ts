/**
 * Writes CommonGrants records into D1: the record as JSON, plus the columns the
 * repositories in `d1.ts` filter and sort on. The columns are read from the
 * parsed record with the same helpers the in-memory repositories use, so both
 * stores agree on every value.
 */

import { AwardBaseSchema } from "@common-grants/sdk/schemas";
import { OpportunitySchema } from "../data/schema.js";
import { eventDate } from "../data/memory.js";
import { normalizeFon } from "../sync/fon.js";
import { toCents } from "./d1.js";
import type { D1Database, D1PreparedStatement } from "./types.js";

type Money = { amount: string; currency: string } | null | undefined;

function money(value: Money): [number | null, string | null] {
  return value == null ? [null, null] : [toCents(value.amount) ?? null, value.currency];
}

/** The record as clients receive it: dates as strings, no `undefined`. */
function wire(record: unknown): string {
  return JSON.stringify(record);
}

export interface OpportunityMeta {
  /** The opportunity number from the Simpler.Grants.gov listing. */
  fon: string;
  /** Upstream "last changed" marker from the listing. */
  sourceVersion: string | null;
  rawHash: string | null;
  runId: string;
  syncedAt: string;
}

/** Rows per bulk statement: one bound JSON parameter, well under D1's size limits. */
export const BULK_ROWS = 500;

/**
 * Records opportunities from the listing before their full records are
 * fetched, or refreshes the listing fields of ones already stored. A new row is
 * not served until {@link upsertOpportunity} fills in `record_json`.
 *
 * Writes up to {@link BULK_ROWS} rows per statement through `json_each`, so a
 * listing of thousands stays far below D1's per-invocation query limit.
 */
export function markOpportunities(
  db: D1Database,
  listings: { id: string; fon: string; title: string; sourceVersion: string | null }[],
  runId: string
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < listings.length; i += BULK_ROWS) {
    const rows = listings.slice(i, i + BULK_ROWS).map(l => ({
      id: l.id,
      fon: l.fon,
      fon_norm: normalizeFon(l.fon),
      title: l.title,
      version: l.sourceVersion,
    }));
    statements.push(
      db
        .prepare(
          `INSERT INTO opportunities (id, fon, fon_norm, title, status, created_at, last_modified_at, listed_version, seen_run)
           SELECT json_extract(value, '$.id'), json_extract(value, '$.fon'),
                  json_extract(value, '$.fon_norm'), json_extract(value, '$.title'),
                  '', 0, 0, json_extract(value, '$.version'), ?
           FROM json_each(?) WHERE true
           ON CONFLICT(id) DO UPDATE SET fon = excluded.fon, fon_norm = excluded.fon_norm,
             listed_version = excluded.listed_version, seen_run = excluded.seen_run`
        )
        .bind(runId, JSON.stringify(rows))
    );
  }
  return statements;
}

export function upsertOpportunity(
  db: D1Database,
  raw: unknown,
  meta: OpportunityMeta
): D1PreparedStatement {
  const record = OpportunitySchema.parse(raw);
  const [totalCents, totalCurrency] = money(record.funding?.totalAmountAvailable);
  const [minCents, minCurrency] = money(record.funding?.minAwardAmount);
  const [maxCents, maxCurrency] = money(record.funding?.maxAwardAmount);
  return db
    .prepare(
      `INSERT INTO opportunities (
         id, fon, fon_norm, title, status, created_at, last_modified_at, close_date,
         total_available_cents, total_available_currency, min_award_cents, min_award_currency,
         max_award_cents, max_award_currency, estimated_award_count,
         source_version, raw_hash, record_json, seen_run, synced_at, changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         fon = excluded.fon, fon_norm = excluded.fon_norm, title = excluded.title,
         status = excluded.status, created_at = excluded.created_at,
         last_modified_at = excluded.last_modified_at, close_date = excluded.close_date,
         total_available_cents = excluded.total_available_cents,
         total_available_currency = excluded.total_available_currency,
         min_award_cents = excluded.min_award_cents, min_award_currency = excluded.min_award_currency,
         max_award_cents = excluded.max_award_cents, max_award_currency = excluded.max_award_currency,
         estimated_award_count = excluded.estimated_award_count,
         source_version = excluded.source_version, raw_hash = excluded.raw_hash,
         record_json = excluded.record_json,
         synced_at = excluded.synced_at,
         changed_at = CASE WHEN opportunities.raw_hash IS excluded.raw_hash
           THEN opportunities.changed_at ELSE excluded.synced_at END`
    )
    .bind(
      record.id,
      meta.fon,
      normalizeFon(meta.fon),
      record.title,
      record.status.value,
      record.createdAt.getTime(),
      record.lastModifiedAt.getTime(),
      eventDate(record.keyDates?.closeDate)?.getTime() ?? null,
      totalCents,
      totalCurrency,
      minCents,
      minCurrency,
      maxCents,
      maxCurrency,
      record.funding?.estimatedAwardCount ?? null,
      meta.sourceVersion,
      meta.rawHash,
      wire(raw),
      meta.runId,
      meta.syncedAt,
      meta.syncedAt
    );
}

export interface AwardMeta {
  /** USAspending's generated unique award id. */
  sourceKey: string;
  /** Period-of-performance end date (YYYY-MM-DD), from which status is derived. */
  popEnd: string | null;
  sourceVersion: string | null;
  rawHash: string | null;
  syncedAt: string;
}

export function upsertAward(db: D1Database, raw: unknown, meta: AwardMeta): D1PreparedStatement {
  const record = AwardBaseSchema.parse(raw);
  const [cents, currency] = money(record.funding?.awardedAmount);
  return db
    .prepare(
      `INSERT INTO awards (
         id, source_key, opportunity_id, title, description, created_at, last_modified_at,
         award_date, pop_end, awarded_cents, awarded_currency,
         source_version, raw_hash, record_json, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_key) DO UPDATE SET
         id = excluded.id, opportunity_id = excluded.opportunity_id,
         title = excluded.title, description = excluded.description,
         created_at = excluded.created_at, last_modified_at = excluded.last_modified_at,
         award_date = excluded.award_date, pop_end = excluded.pop_end,
         awarded_cents = excluded.awarded_cents, awarded_currency = excluded.awarded_currency,
         source_version = excluded.source_version, raw_hash = excluded.raw_hash,
         record_json = excluded.record_json, synced_at = excluded.synced_at
       ON CONFLICT(id) DO UPDATE SET
         source_key = excluded.source_key, opportunity_id = excluded.opportunity_id,
         title = excluded.title, description = excluded.description,
         created_at = excluded.created_at, last_modified_at = excluded.last_modified_at,
         award_date = excluded.award_date, pop_end = excluded.pop_end,
         awarded_cents = excluded.awarded_cents, awarded_currency = excluded.awarded_currency,
         source_version = excluded.source_version, raw_hash = excluded.raw_hash,
         record_json = excluded.record_json, synced_at = excluded.synced_at`
    )
    .bind(
      record.id,
      meta.sourceKey,
      record.opportunity?.id ?? "",
      record.title,
      record.description,
      record.createdAt.getTime(),
      record.lastModifiedAt.getTime(),
      eventDate(record.keyDates?.awardDate)?.getTime() ?? null,
      meta.popEnd,
      cents,
      currency,
      meta.sourceVersion,
      meta.rawHash,
      wire(raw),
      meta.syncedAt
    );
}
