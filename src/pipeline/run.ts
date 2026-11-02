/**
 * One refresh: sample USAspending, match to Simpler.Grants.gov, transform,
 * validate, and produce the snapshot the API serves.
 *
 * Runs unchanged under Node (`scripts/refresh.ts`) and in the Cloudflare
 * Worker's scheduled handler (`src/worker.ts`). It does no I/O of its own
 * beyond the two upstream APIs; the caller decides where the snapshot goes.
 */

import { AwardBaseSchema } from "@common-grants/sdk/schemas";
import { OpportunitySchema } from "../data/schema.js";
import { SnapshotSchema, type Snapshot } from "../data/snapshot.js";
import type { Config } from "./config.js";
import { collectCandidates } from "./usaspending.js";
import { createOpportunityResolver, type OpportunityResolver } from "./sgg.js";
import { joinAwardsToOpportunities } from "./join.js";
import { toAwardBase } from "./award.js";

export type Log = (message: string) => void;

export interface RunOptions {
  /** Overrides the Simpler.Grants.gov lookup. Tests use this. */
  resolver?: OpportunityResolver;
  log?: Log;
}

/**
 * Round-trips a value through JSON to get the exact representation a client
 * sees. Date-bearing fields hold `Date` values in memory and only become
 * protocol strings through `toJSON`, so validating the in-memory objects would
 * check a shape no consumer ever receives.
 */
function toWire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

export async function runRefresh(config: Config, options: RunOptions = {}): Promise<Snapshot> {
  const log = options.log ?? (() => {});
  const resolver = options.resolver ?? createOpportunityResolver(config);

  log(
    `Sampling USAspending awards across ${config.agencies.length} agencies, ` +
      `action dates ${config.timePeriod.startDate} to ${config.timePeriod.endDate}`
  );
  const candidates = await collectCandidates(config);
  log(
    `  ${candidates.all.length} awards fetched, ${candidates.withOpportunityNumber.length} ` +
      `carry an opportunity number (${candidates.opportunityNumbers.length} distinct)`
  );

  log("Matching opportunity numbers against Simpler.Grants.gov");
  const join = await joinAwardsToOpportunities(candidates, resolver, config.targetAwardCount);
  log(
    `  ${join.matchedNumbers.length} matched, ${join.unmatchedNumbers.length} unmatched, ` +
      `${join.matchedAwardCount} awards joined`
  );

  // Every record is checked against the published SDK schema in the form a
  // client receives. A record the SDK rejects is left out and counted, so one
  // odd upstream record cannot take the whole refresh down.
  const awards: unknown[] = [];
  let rejected = 0;
  for (const pair of join.selected) {
    const wire = toWire(toAwardBase(pair.award, pair.opportunity, { asOf: config.asOf }));
    const parsed = AwardBaseSchema.safeParse(wire);
    if (parsed.success) {
      awards.push(wire);
    } else {
      rejected += 1;
      log(`  rejected award ${pair.award.generated_unique_award_id}: ${parsed.error.message}`);
    }
  }

  const opportunities = new Map<string, unknown>();
  for (const pair of join.selected) {
    if (opportunities.has(pair.opportunity.id)) continue;
    const wire = toWire(pair.opportunity.record);
    if (OpportunitySchema.safeParse(wire).success) opportunities.set(pair.opportunity.id, wire);
  }

  log(`  ${awards.length} awards and ${opportunities.size} opportunities in the snapshot`);

  return SnapshotSchema.parse({
    asOf: config.asOf.toISOString(),
    report: {
      usaSpending: {
        agencies: config.agencies,
        awardTypeCodes: config.awardTypeCodes,
        timePeriod: config.timePeriod,
      },
      funnel: {
        awardsFetched: candidates.all.length,
        awardsWithOpportunityNumber: candidates.withOpportunityNumber.length,
        distinctOpportunityNumbers: candidates.opportunityNumbers.length,
        matchedOpportunityNumbers: join.matchedNumbers.length,
        awardsJoined: join.matchedAwardCount,
        awardsEmitted: awards.length,
        awardsRejected: rejected,
      },
      unmatchedNumbers: join.unmatchedNumbers,
    },
    opportunities: [...opportunities.values()],
    awards,
  });
}
