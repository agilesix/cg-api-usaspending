/**
 * The daily refresh, as a Cloudflare Workflow.
 *
 * A refresh outlasts a single Worker invocation: USAspending takes several
 * minutes to build each download, and the first load fetches tens of
 * thousands of award records. A Workflow runs it as a sequence of steps, each
 * with its own time and request budget, retried on its own, and sleeps
 * between download status checks without holding a Worker open.
 *
 * The steps themselves live in `steps.ts`; this file only orders them.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { loadConfig, type PipelineEnv } from "../pipeline/config.js";
import type { D1Database, R2Bucket } from "../storage/types.js";
import {
  failRun,
  fetchAwardsStep,
  fetchOpportunitiesStep,
  finishRun,
  listOpportunitiesStep,
  pruneStep,
  readDownloadStep,
  SCOPE_START,
  startRun,
  type SyncDeps,
} from "./steps.js";
import {
  checkDownload,
  fiscalYearSlices,
  requestDownload,
  type DownloadJob,
} from "./usaspending-download.js";

export interface SyncParams {
  runId: string;
}

export type SyncEnv = PipelineEnv & {
  DB: D1Database;
  SNAPSHOTS: R2Bucket;
};

const RETRY = {
  retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
  timeout: "10 minutes",
} as const;

/**
 * Award steps back off for longer: a failure there usually means USAspending's
 * rate limit, which lasts minutes. Retries wait 5, 10, 20 and 40 minutes.
 */
const AWARD_RETRY = {
  retries: { limit: 4, delay: "5 minutes", backoff: "exponential" },
  timeout: "15 minutes",
} as const;

/** Opportunity records fetched per step. */
const OPPORTUNITY_BATCH = 100;

/**
 * Award records fetched per step; each costs one fetch and up to two R2 writes.
 * At four requests a second a step takes under half a minute. Sized so that
 * even if every request hangs until its 30-second timeout (100 / 4 x 30 s),
 * the step still ends, and saves what it got, inside AWARD_RETRY's timeout.
 */
const AWARD_BATCH = 100;

/** About four USAspending award requests a second. */
const AWARD_REQUEST_INTERVAL_MS = 250;

/** Download status checks, two minutes apart: up to two hours of waiting. */
const MAX_STATUS_CHECKS = 60;

/** How many times one download is requested before the refresh gives up. */
const MAX_DOWNLOAD_REQUESTS = 3;

/** A guard against a runaway loop; the first load needs about 230 award steps. */
const MAX_AWARD_STEPS = 600;

const AWARD_TYPE_CODES = ["02", "03", "04", "05"];

export function syncDeps(env: SyncEnv): SyncDeps {
  const config = loadConfig(env as PipelineEnv);
  return {
    db: env.DB,
    bucket: env.SNAPSHOTS,
    sgg: { baseUrl: config.sggBaseUrl, apiKey: config.sggApiKey, authHeader: config.sggAuthHeader },
    usaSpendingBaseUrl: config.usaSpendingBaseUrl,
    concurrency: Math.min(config.concurrency, 4),
    awardRequestIntervalMs: AWARD_REQUEST_INTERVAL_MS,
    now: () => new Date(),
    log: message => console.log(message),
  };
}

export class SyncWorkflow extends WorkflowEntrypoint<SyncEnv, SyncParams> {
  async run(event: WorkflowEvent<SyncParams>, step: WorkflowStep): Promise<unknown> {
    const { runId } = event.payload;
    const deps = syncDeps(this.env);

    try {
      await step.do("start", RETRY, async () => {
        await startRun(deps, runId);
      });

      // Opportunities: list everything in scope, then fetch what changed.
      const listing = await step.do("list opportunities", RETRY, () =>
        listOpportunitiesStep(deps, runId)
      );
      const opportunities = { fetched: 0, changed: 0, missing: 0, rejected: 0, failed: 0 };
      for (let i = 0; i < listing.toFetch.length; i += OPPORTUNITY_BATCH) {
        const ids = listing.toFetch.slice(i, i + OPPORTUNITY_BATCH);
        const batch = await step.do(`fetch opportunities ${i}`, RETRY, () =>
          fetchOpportunitiesStep(deps, runId, ids)
        );
        opportunities.fetched += batch.fetched;
        opportunities.changed += batch.changed;
        opportunities.missing += batch.missing;
        opportunities.rejected += batch.rejected;
        opportunities.failed += batch.failed;
      }

      // Awards: request the downloads, wait for them, and read each one. A
      // download that USAspending fails to build is requested again, up to
      // MAX_DOWNLOAD_REQUESTS times: re-checking a failed one never helps.
      let jobs = await step.do("request downloads", RETRY, async () => {
        const today = new Date().toISOString().slice(0, 10);
        const requested: DownloadJob[] = [];
        for (const slice of fiscalYearSlices(SCOPE_START, today)) {
          requested.push(await requestDownload(deps.usaSpendingBaseUrl, slice));
        }
        return requested;
      });

      // Each job's row count, once all of them have finished.
      let totals: number[] | null = null;
      let requests = jobs.map(() => 1);
      for (let check = 0; totals === null; check += 1) {
        if (check >= MAX_STATUS_CHECKS) throw new Error("USAspending downloads did not finish");
        await step.sleep(`wait for downloads ${check}`, "2 minutes");
        const current = { jobs, requests };
        const checked = await step.do(`check downloads ${check}`, RETRY, async () => {
          const next = { jobs: [...current.jobs], requests: [...current.requests] };
          const rows: number[] = [];
          let done = true;
          for (const [index, job] of current.jobs.entries()) {
            const status = await checkDownload(job);
            if (status.state === "finished") {
              rows.push(status.totalRows);
              continue;
            }
            done = false;
            if (status.state === "failed") {
              const made = current.requests[index] ?? 1;
              if (made >= MAX_DOWNLOAD_REQUESTS) {
                throw new Error(`${status.message} (USAspending failed to build it ${made} times)`);
              }
              next.jobs[index] = await requestDownload(deps.usaSpendingBaseUrl, job.slice);
              next.requests[index] = made + 1;
            }
          }
          return { ...next, totals: done ? rows : null };
        });
        jobs = checked.jobs;
        requests = checked.requests;
        totals = checked.totals;
      }
      const expected = totals;

      const downloads = { slices: jobs.length, rows: 0, withOpportunityNumber: 0 };
      const matching = { exact: 0, suffix: 0, ambiguous: 0 };
      for (const [index, job] of jobs.entries()) {
        const read = await step.do(`read download ${index}`, RETRY, () =>
          readDownloadStep(deps, runId, job, expected[index] ?? 0)
        );
        downloads.rows += read.rows;
        downloads.withOpportunityNumber += read.withOpportunityNumber;
        matching.exact += read.matchedExact;
        matching.suffix += read.matchedSuffix;
        matching.ambiguous += read.ambiguous;
      }

      // Award records: fetch what is new or changed, in batches.
      const awards = {
        fetched: 0,
        changed: 0,
        rejected: 0,
        failed: 0,
        skipped: 0,
        stoppedEarly: true,
      };
      let cursor = "";
      for (let n = 0; n < MAX_AWARD_STEPS; n += 1) {
        const after = cursor;
        const batch = await step.do(`fetch awards ${n}`, AWARD_RETRY, () =>
          fetchAwardsStep(deps, runId, after, AWARD_BATCH)
        );
        if (batch.cursor === null) {
          awards.stoppedEarly = false;
          break;
        }
        cursor = batch.cursor;
        awards.fetched += batch.fetched;
        awards.changed += batch.changed;
        awards.rejected += batch.rejected;
        awards.failed += batch.failed;
        awards.skipped += batch.skipped;
      }
      if (awards.stoppedEarly) {
        // The rest are fetched by the next refresh; the report says so.
        deps.log(`Stopped after ${MAX_AWARD_STEPS} award steps; the next refresh continues`);
      }

      const removed = await step.do("prune", RETRY, () => pruneStep(deps, runId));

      return await step.do("finish", RETRY, () =>
        finishRun(deps, runId, {
          scope: { postedSince: SCOPE_START, awardTypeCodes: AWARD_TYPE_CODES },
          opportunities: { listed: listing.listed, ...opportunities },
          downloads,
          matching,
          awards,
          removed,
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await step.do("record failure", RETRY, () => failRun(deps, runId, message));
      throw error;
    }
  }
}
