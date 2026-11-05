/**
 * The steps of one refresh, as plain functions over D1, R2 and the two
 * upstream APIs. `src/sync/workflow.ts` runs them as Cloudflare Workflow steps,
 * so each one stays inside a single step's time, memory and request limits;
 * tests run them directly against `node:sqlite`.
 *
 * Every step is safe to retry: writes are upserts keyed on stable ids, and the
 * award candidates are scoped to the run that found them.
 */

import { createHash } from "node:crypto";
import { AwardBaseSchema } from "@common-grants/sdk/schemas";
import { OpportunitySchema } from "../data/schema.js";
import { toAwardBase } from "../pipeline/award.js";
import { fetchAwardDetailWithRaw } from "../pipeline/usaspending.js";
import { mapWithConcurrency } from "../pipeline/concurrency.js";
import { createPacer } from "./pace.js";
import type { ResolvedOpportunity } from "../pipeline/sgg.js";
import { BULK_ROWS, markOpportunities, upsertAward, upsertOpportunity } from "../storage/rows.js";
import type { D1Database, D1PreparedStatement, R2Bucket } from "../storage/types.js";
import { createFonMatcher } from "./fon.js";
import { fetchOpportunity, listOpportunities, type SggConfig } from "./sgg.js";
import { streamDownload, type DownloadJob } from "./usaspending-download.js";

/** Opportunities posted on or after this date are in scope, with all their awards. */
export const SCOPE_START = "2024-10-01";

export interface SyncDeps {
  db: D1Database;
  bucket: R2Bucket;
  sgg: SggConfig;
  usaSpendingBaseUrl: string;
  /** Max concurrent requests per upstream API. */
  concurrency: number;
  /** Minimum gap between USAspending award requests, to stay under its rate limit. */
  awardRequestIntervalMs: number;
  now: () => Date;
  log: (message: string) => void;
}

/** D1 accepts large batches, but smaller ones keep each call well under its limits. */
const BATCH_SIZE = 200;

async function runBatches(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    await db.batch(statements.slice(i, i + BATCH_SIZE));
  }
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** A period-of-performance end as YYYY-MM-DD, or null, so SQL and JS agree on status. */
function dayOrNull(value: string | null | undefined): string | null {
  const match = value?.trim().match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Raw upstream records, archived per record only when they change. The newest
 * copy of each record lives under `records/` and is kept; every version is
 * also written under `history/`, which a bucket lifecycle rule expires after a
 * year (see README).
 */
async function archive(
  deps: SyncDeps,
  kind: "opportunities" | "awards",
  id: string,
  runId: string,
  raw: unknown
): Promise<void> {
  const body = `${JSON.stringify(raw)}\n`;
  const options = { httpMetadata: { contentType: "application/json" } };
  await deps.bucket.put(`records/${kind}/${id}.json`, body, options);
  await deps.bucket.put(`history/${kind}/${id}/${runId}.json`, body, options);
}

// ############################################################################
// Run bookkeeping
// ############################################################################

/**
 * A run still marked running after this long is treated as dead. The first
 * load takes five to six hours, because USAspending rate-limits award
 * requests; retries and slow downloads can add a few more.
 */
const RUN_TIMEOUT_MS = 12 * 60 * 60 * 1000;

/**
 * Records the start of a run. Refuses to start while another run is still
 * going, since two runs would prune each other's results. The check and the
 * insert are one statement, so two runs starting at the same moment cannot
 * both get through. A retry of the same run finds its own row and goes on.
 */
export async function startRun(deps: SyncDeps, runId: string): Promise<void> {
  const now = deps.now();
  const cutoff = new Date(now.getTime() - RUN_TIMEOUT_MS).toISOString();
  await deps.db
    .prepare(
      `INSERT INTO sync_runs (id, started_at, status)
       SELECT ?, ?, 'running'
       WHERE NOT EXISTS (SELECT 1 FROM sync_runs
         WHERE status = 'running' AND id != ? AND started_at > ?)
       ON CONFLICT(id) DO NOTHING`
    )
    .bind(runId, now.toISOString(), runId, cutoff)
    .run();

  const own = await deps.db
    .prepare("SELECT status FROM sync_runs WHERE id = ?")
    .bind(runId)
    .first<{ status: string }>();
  if (own?.status === "running") return;
  throw new Error(
    own === null ? "Another refresh is still running" : `Refresh ${runId} already ${own.status}`
  );
}

export async function failRun(deps: SyncDeps, runId: string, error: string): Promise<void> {
  await deps.db
    .prepare("UPDATE sync_runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?")
    .bind(deps.now().toISOString(), error, runId)
    .run();
}

// ############################################################################
// Opportunities
// ############################################################################

export interface ListResult {
  listed: number;
  /** Ids whose full record is new or changed upstream. */
  toFetch: string[];
}

/**
 * Lists every opportunity in scope, records each one as seen by this run, and
 * returns the ids whose full record needs fetching.
 */
export async function listOpportunitiesStep(deps: SyncDeps, runId: string): Promise<ListResult> {
  const listings = await listOpportunities(deps.sgg, SCOPE_START, isoDay(deps.now()));
  if (listings.length === 0) throw new Error("Simpler.Grants.gov listed no opportunities");

  await runBatches(deps.db, markOpportunities(deps.db, listings, runId));

  const due = await deps.db
    .prepare(
      `SELECT id FROM opportunities WHERE seen_run = ?
         AND (record_json IS NULL OR source_version IS NOT listed_version)`
    )
    .bind(runId)
    .all<{ id: string }>();
  const toFetch = due.results.map(row => row.id);

  deps.log(`${listings.length} opportunities listed, ${toFetch.length} new or changed`);
  return { listed: listings.length, toFetch };
}

export interface FetchOpportunitiesResult {
  fetched: number;
  changed: number;
  missing: number;
  rejected: number;
  /** Requests that failed; the record is tried again next run. */
  failed: number;
}

/** Fetches and stores the full records for one batch of opportunity ids. */
export async function fetchOpportunitiesStep(
  deps: SyncDeps,
  runId: string,
  ids: string[]
): Promise<FetchOpportunitiesResult> {
  const stored = await deps.db
    .prepare(
      `SELECT id, fon, raw_hash, listed_version FROM opportunities
       WHERE id IN (SELECT value FROM json_each(?))`
    )
    .bind(JSON.stringify(ids))
    .all<{ id: string; fon: string; raw_hash: string | null; listed_version: string | null }>();
  const rows = new Map(stored.results.map(row => [row.id, row]));

  const result: FetchOpportunitiesResult = {
    fetched: 0,
    changed: 0,
    missing: 0,
    rejected: 0,
    failed: 0,
  };
  const statements: D1PreparedStatement[] = [];
  const syncedAt = deps.now().toISOString();

  await mapWithConcurrency(ids, deps.concurrency, async id => {
    // One record that keeps failing must not fail the whole refresh.
    let raw: unknown;
    try {
      raw = await fetchOpportunity(deps.sgg, id);
    } catch (error) {
      result.failed += 1;
      deps.log(`Opportunity ${id}: ${error instanceof Error ? error.message : error}`);
      return;
    }
    if (raw === null) {
      result.missing += 1;
      return;
    }
    if (!OpportunitySchema.safeParse(raw).success) {
      result.rejected += 1;
      deps.log(`Opportunity ${id} failed the schema; skipped`);
      return;
    }
    result.fetched += 1;
    const rawHash = hash(raw);
    const row = rows.get(id);
    if (row?.raw_hash !== rawHash) {
      result.changed += 1;
      await archive(deps, "opportunities", id, runId, raw);
    }
    statements.push(
      upsertOpportunity(deps.db, raw, {
        fon: row?.fon ?? "",
        sourceVersion: row?.listed_version ?? null,
        rawHash,
        runId,
        syncedAt,
      })
    );
  });

  await runBatches(deps.db, statements);
  return result;
}

// ############################################################################
// Awards: finding them
// ############################################################################

export interface ReadDownloadResult {
  rows: number;
  withOpportunityNumber: number;
  matchedExact: number;
  matchedSuffix: number;
  ambiguous: number;
}

/**
 * Streams one finished download and stages every award that links to a
 * stored opportunity as a candidate for this run.
 */
export async function readDownloadStep(
  deps: SyncDeps,
  runId: string,
  job: DownloadJob,
  expectedRows: number
): Promise<ReadDownloadResult> {
  const opportunities = await deps.db
    .prepare("SELECT id, fon FROM opportunities WHERE seen_run = ?")
    .bind(runId)
    .all<{ id: string; fon: string }>();
  const matcher = createFonMatcher(opportunities.results);

  const result: ReadDownloadResult = {
    rows: 0,
    withOpportunityNumber: 0,
    matchedExact: 0,
    matchedSuffix: 0,
    ambiguous: 0,
  };
  const candidates = new Map<
    string,
    { opportunityId: string; fon: string; method: string; version: string }
  >();

  result.rows = await streamDownload(job.fileUrl, row => {
    const match = matcher.match(row.fon);
    if (match.kind === "none") return;
    result.withOpportunityNumber += 1;
    if (match.kind === "ambiguous") result.ambiguous += 1;
    if (match.kind !== "matched") return;
    if (match.method === "exact") result.matchedExact += 1;
    else result.matchedSuffix += 1;
    const previous = candidates.get(row.awardKey);
    if (previous === undefined || previous.version < row.lastModified) {
      candidates.set(row.awardKey, {
        opportunityId: match.opportunityId,
        fon: row.fon.trim(),
        method: match.method,
        version: row.lastModified,
      });
    }
  });

  // A renamed file or a parsing problem would otherwise read zero rows and
  // pass for a quiet day.
  if (result.rows !== expectedRows) {
    throw new Error(
      `Read ${result.rows} rows from the ${job.slice.startDate}..${job.slice.endDate} download, which reported ${expectedRows}`
    );
  }

  // Thousands of candidates, so they go up BULK_ROWS at a time through
  // json_each: a few statements instead of one per award.
  const staged = [...candidates].map(([key, c]) => ({
    key,
    opp: c.opportunityId,
    fon: c.fon,
    method: c.method,
    version: c.version,
  }));
  const chunks: (typeof staged)[] = [];
  for (let i = 0; i < staged.length; i += BULK_ROWS) chunks.push(staged.slice(i, i + BULK_ROWS));
  await runBatches(
    deps.db,
    chunks.map(chunk =>
      deps.db
        .prepare(
          `INSERT INTO award_candidates (source_key, opportunity_id, fon, match_method, source_version, run_id)
           SELECT json_extract(value, '$.key'), json_extract(value, '$.opp'),
                  json_extract(value, '$.fon'), json_extract(value, '$.method'),
                  json_extract(value, '$.version'), ?
           FROM json_each(?) WHERE true
           ON CONFLICT(source_key) DO UPDATE SET
             opportunity_id = excluded.opportunity_id, fon = excluded.fon,
             match_method = excluded.match_method, run_id = excluded.run_id,
             source_version = CASE
               WHEN award_candidates.run_id = excluded.run_id
                 AND award_candidates.source_version > excluded.source_version
               THEN award_candidates.source_version ELSE excluded.source_version END`
        )
        .bind(runId, JSON.stringify(chunk))
    )
  );

  deps.log(
    `${job.slice.startDate}..${job.slice.endDate}: ${result.rows} rows, ${candidates.size} linked awards`
  );
  return result;
}

// ############################################################################
// Awards: fetching and storing them
// ############################################################################

export interface FetchAwardsResult {
  /** The last candidate key handled, to resume after; `null` when none were left. */
  cursor: string | null;
  fetched: number;
  changed: number;
  rejected: number;
  failed: number;
  /** Linked to an opportunity that is not served (it failed to fetch or validate). */
  skipped: number;
}

/**
 * Fetches full USAspending records for the next batch of candidates that are
 * new, changed upstream, or linked to an opportunity this run changed, and
 * stores them as CommonGrants awards.
 */
export async function fetchAwardsStep(
  deps: SyncDeps,
  runId: string,
  after: string,
  limit: number
): Promise<FetchAwardsResult> {
  const due = await deps.db
    .prepare(
      `SELECT c.source_key, c.opportunity_id, c.source_version, a.raw_hash
       FROM award_candidates c
       LEFT JOIN awards a ON a.source_key = c.source_key
       JOIN opportunities o ON o.id = c.opportunity_id
       WHERE c.run_id = ? AND c.source_key > ?
         AND (a.id IS NULL OR a.source_version IS NOT c.source_version
              OR a.opportunity_id != c.opportunity_id OR o.changed_at > a.synced_at)
       ORDER BY c.source_key
       LIMIT ?`
    )
    .bind(runId, after, limit)
    .all<{
      source_key: string;
      opportunity_id: string;
      source_version: string | null;
      raw_hash: string | null;
    }>();

  const result: FetchAwardsResult = {
    cursor: due.results.at(-1)?.source_key ?? null,
    fetched: 0,
    changed: 0,
    rejected: 0,
    failed: 0,
    skipped: 0,
  };
  if (due.results.length === 0) return result;

  const opportunityIds = [...new Set(due.results.map(row => row.opportunity_id))];
  const opportunities = await loadOpportunities(deps, opportunityIds);
  const asOf = deps.now();
  const syncedAt = asOf.toISOString();
  const statements: D1PreparedStatement[] = [];

  const pace = createPacer(deps.awardRequestIntervalMs);
  await mapWithConcurrency(due.results, deps.concurrency, async candidate => {
    const opportunity = opportunities.get(candidate.opportunity_id);
    if (opportunity === undefined) {
      // Pruning removes any stored copy, so the award is never served under a
      // stale link.
      result.skipped += 1;
      return;
    }

    let fetched: Awaited<ReturnType<typeof fetchAwardDetailWithRaw>>;
    await pace();
    try {
      fetched = await fetchAwardDetailWithRaw(deps, candidate.source_key);
    } catch (error) {
      result.failed += 1;
      deps.log(`Award ${candidate.source_key}: ${error instanceof Error ? error.message : error}`);
      return;
    }
    const { detail, raw } = fetched;
    result.fetched += 1;

    let wire: unknown;
    try {
      wire = JSON.parse(JSON.stringify(toAwardBase(detail, opportunity, { asOf })));
    } catch (error) {
      result.rejected += 1;
      deps.log(`Award ${candidate.source_key}: ${error instanceof Error ? error.message : error}`);
      return;
    }
    if (!AwardBaseSchema.safeParse(wire).success) {
      result.rejected += 1;
      deps.log(`Award ${candidate.source_key} failed the schema; skipped`);
      return;
    }

    const rawHash = hash(raw);
    if (candidate.raw_hash !== rawHash) {
      result.changed += 1;
      await archive(deps, "awards", candidate.source_key, runId, raw);
    }
    statements.push(
      upsertAward(deps.db, wire, {
        sourceKey: candidate.source_key,
        popEnd: dayOrNull(detail.period_of_performance?.end_date),
        sourceVersion: candidate.source_version,
        rawHash,
        syncedAt,
      })
    );
  });

  // Store what did succeed, then back off if USAspending is refusing most
  // requests: the step fails, the Workflow retries it after a long delay, and
  // anything still missing is picked up by the next run. Carrying on would
  // only send thousands more requests into the block.
  await runBatches(deps.db, statements);
  const attempted = result.fetched + result.failed;
  if (attempted >= 20 && result.failed > attempted / 2) {
    throw new Error(
      `USAspending refused ${result.failed} of ${attempted} award requests; backing off`
    );
  }
  return result;
}

/** The stored opportunities, in the shape the award transform reads. */
async function loadOpportunities(
  deps: SyncDeps,
  ids: string[]
): Promise<Map<string, ResolvedOpportunity>> {
  const rows = await deps.db
    .prepare(
      `SELECT id, record_json FROM opportunities
       WHERE id IN (SELECT value FROM json_each(?)) AND record_json IS NOT NULL`
    )
    .bind(JSON.stringify(ids))
    .all<{ id: string; record_json: string }>();
  const resolved = new Map<string, ResolvedOpportunity>();
  for (const row of rows.results) {
    const record = OpportunitySchema.parse(JSON.parse(row.record_json));
    const fon = record.customFields?.federalOpportunityNumber?.value;
    if (typeof fon !== "string") continue;
    resolved.set(row.id, {
      id: record.id,
      title: record.title,
      federalOpportunityNumber: fon,
      record,
    });
  }
  return resolved;
}

// ############################################################################
// Pruning and the report
// ############################################################################

export interface PruneResult {
  opportunitiesRemoved: number;
  awardsRemoved: number;
}

/**
 * Removes what this run no longer found upstream: opportunities missing from
 * the listing, awards missing from the downloads, and awards whose opportunity
 * is not served. Each kind of removal has its own safety check: a run that
 * found far fewer opportunities or awards than are stored is assumed to be an
 * upstream problem, and removes nothing of that kind.
 */
export async function pruneStep(deps: SyncDeps, runId: string): Promise<PruneResult> {
  const counts = await deps.db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM award_candidates WHERE run_id = ?) AS found_awards,
              (SELECT COUNT(*) FROM awards) AS stored_awards,
              (SELECT COUNT(*) FROM opportunities WHERE seen_run = ?) AS found_opportunities,
              (SELECT COUNT(*) FROM opportunities WHERE record_json IS NOT NULL) AS served_opportunities`
    )
    .bind(runId, runId)
    .first<{
      found_awards: number;
      stored_awards: number;
      found_opportunities: number;
      served_opportunities: number;
    }>();
  if (counts === null) return { opportunitiesRemoved: 0, awardsRemoved: 0 };

  let awardsRemoved = 0;
  let opportunitiesRemoved = 0;

  // Awards whose current link points at an opportunity that is not served, or
  // whose stored record no longer carries a federal opportunity number, are
  // never shown under a stale link. Safe on any run: the link is this run's.
  const unlinked = await deps.db
    .prepare(
      `DELETE FROM awards WHERE source_key IN (
         SELECT c.source_key FROM award_candidates c
         LEFT JOIN opportunities o ON o.id = c.opportunity_id
         WHERE c.run_id = ? AND (o.id IS NULL OR o.record_json IS NULL
           OR json_extract(o.record_json, '$.customFields.federalOpportunityNumber.value')
              IS NULL))
       RETURNING id`
    )
    .bind(runId)
    .all();
  awardsRemoved += unlinked.results.length;

  if (counts.found_opportunities >= counts.served_opportunities * 0.9) {
    const awards = await deps.db
      .prepare(
        `DELETE FROM awards WHERE opportunity_id IN
           (SELECT id FROM opportunities WHERE seen_run IS NOT ?) RETURNING id`
      )
      .bind(runId)
      .all();
    const opportunities = await deps.db
      .prepare("DELETE FROM opportunities WHERE seen_run IS NOT ? RETURNING id")
      .bind(runId)
      .all();
    awardsRemoved += awards.results.length;
    opportunitiesRemoved = opportunities.results.length;
  } else {
    deps.log(
      `Opportunity pruning skipped: listed ${counts.found_opportunities}, ${counts.served_opportunities} are served`
    );
  }

  if (counts.found_awards >= counts.stored_awards / 2) {
    const awards = await deps.db
      .prepare(
        `DELETE FROM awards WHERE source_key NOT IN
           (SELECT source_key FROM award_candidates WHERE run_id = ?) RETURNING id`
      )
      .bind(runId)
      .all();
    awardsRemoved += awards.results.length;
  } else {
    deps.log(
      `Award pruning skipped: this run found ${counts.found_awards} awards, ${counts.stored_awards} are stored`
    );
  }

  await deps.db.prepare("DELETE FROM award_candidates WHERE run_id != ?").bind(runId).run();
  return { opportunitiesRemoved, awardsRemoved };
}

export interface SyncReport {
  scope: { postedSince: string; awardTypeCodes: string[] };
  opportunities: {
    listed: number;
    fetched: number;
    changed: number;
    missing: number;
    rejected: number;
    failed: number;
  };
  downloads: { slices: number; rows: number; withOpportunityNumber: number };
  matching: { exact: number; suffix: number; ambiguous: number };
  awards: {
    candidates: number;
    fetched: number;
    changed: number;
    rejected: number;
    failed: number;
    skipped: number;
    /** True when the run hit its step limit before fetching every award. */
    stoppedEarly: boolean;
  };
  removed: PruneResult;
  served: { opportunities: number; opportunitiesWithAwards: number; awards: number };
}

export async function finishRun(
  deps: SyncDeps,
  runId: string,
  report: Omit<SyncReport, "served" | "awards"> & {
    awards: Omit<SyncReport["awards"], "candidates">;
  }
): Promise<SyncReport> {
  const served = await deps.db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM opportunities WHERE record_json IS NOT NULL) AS opportunities,
              (SELECT COUNT(DISTINCT opportunity_id) FROM awards) AS with_awards,
              (SELECT COUNT(*) FROM awards) AS awards,
              (SELECT COUNT(*) FROM award_candidates WHERE run_id = ?) AS candidates`
    )
    .bind(runId)
    .first<{ opportunities: number; with_awards: number; awards: number; candidates: number }>();

  const full: SyncReport = {
    ...report,
    awards: { candidates: served?.candidates ?? 0, ...report.awards },
    served: {
      opportunities: served?.opportunities ?? 0,
      opportunitiesWithAwards: served?.with_awards ?? 0,
      awards: served?.awards ?? 0,
    },
  };
  await deps.db
    .prepare(
      "UPDATE sync_runs SET status = 'succeeded', finished_at = ?, report_json = ? WHERE id = ?"
    )
    .bind(deps.now().toISOString(), JSON.stringify(full), runId)
    .run();
  return full;
}

/** The latest successful run, for `/snapshot`. */
export async function latestRun(
  db: D1Database
): Promise<{ id: string; finishedAt: string; report: SyncReport } | null> {
  const row = await db
    .prepare(
      `SELECT id, finished_at, report_json FROM sync_runs
       WHERE status = 'succeeded' ORDER BY finished_at DESC LIMIT 1`
    )
    .first<{ id: string; finished_at: string; report_json: string }>();
  return row === null
    ? null
    : {
        id: row.id,
        finishedAt: row.finished_at,
        report: JSON.parse(row.report_json) as SyncReport,
      };
}
