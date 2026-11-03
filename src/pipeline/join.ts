/**
 * Joins USAspending awards to Simpler.Grants.gov opportunities on the federal
 * funding opportunity number.
 *
 * Every joined award is kept by default. A single opportunity can account for
 * dozens of awards (one NOFO, many recipients), so awards are ordered
 * round-robin across opportunity numbers rather than left grouped by program.
 * That makes the output read across the sample instead of in program-sized
 * blocks, and it means an optional cap yields a spread of opportunities rather
 * than the first one or two programs.
 */

import { mapWithConcurrency } from "./concurrency.js";
import type { OpportunityResolver, ResolvedOpportunity } from "./sgg.js";
import type { AwardDetail, CandidateSet } from "./usaspending.js";
import { opportunityNumberOf } from "./usaspending.js";

/** Concurrent lookups against Simpler.Grants.gov. Kept low deliberately: this is
 * a shared public API and the candidate pool is small. */
const LOOKUP_CONCURRENCY = 4;

export interface JoinedPair {
  award: AwardDetail;
  opportunity: ResolvedOpportunity;
}

export interface JoinResult {
  /** Awards whose opportunity number matched, ordered round-robin and capped. */
  selected: JoinedPair[];
  /** Awards whose opportunity number matched, before any cap. */
  matchedAwardCount: number;
  /** Opportunity numbers that resolved to a Simpler.Grants.gov opportunity. */
  matchedNumbers: string[];
  /** Opportunity numbers Simpler.Grants.gov has no opportunity for. */
  unmatchedNumbers: string[];
}

/** Groups awards by opportunity number, preserving input order within a group. */
function groupByNumber(awards: readonly AwardDetail[]): Map<string, AwardDetail[]> {
  const groups = new Map<string, AwardDetail[]>();
  for (const award of awards) {
    const number = opportunityNumberOf(award);
    const group = groups.get(number);
    if (group) group.push(award);
    else groups.set(number, [award]);
  }
  return groups;
}

/** Draws awards one per opportunity number per pass, up to `limit`. */
function drawRoundRobin(groups: Map<string, AwardDetail[]>, limit: number): AwardDetail[] {
  const queues = [...groups.values()];
  const drawn: AwardDetail[] = [];

  let exhausted = false;
  while (drawn.length < limit && !exhausted) {
    exhausted = true;
    for (const queue of queues) {
      if (drawn.length >= limit) break;
      const award = queue.shift();
      if (award) {
        drawn.push(award);
        exhausted = false;
      }
    }
  }

  return drawn;
}

/**
 * Resolves every candidate opportunity number, then joins.
 *
 * `targetCount` is an optional cap. Undefined emits every joined award.
 */
export async function joinAwardsToOpportunities(
  candidates: CandidateSet,
  resolver: OpportunityResolver,
  targetCount?: number
): Promise<JoinResult> {
  const resolutions = await mapWithConcurrency(
    candidates.opportunityNumbers,
    LOOKUP_CONCURRENCY,
    async number => ({ number, opportunity: await resolver.resolve(number) })
  );

  const byNumber = new Map<string, ResolvedOpportunity>();
  const unmatchedNumbers: string[] = [];
  for (const { number, opportunity } of resolutions) {
    if (opportunity) byNumber.set(number, opportunity);
    else unmatchedNumbers.push(number);
  }

  const matchedAwards = candidates.withOpportunityNumber.filter(award =>
    byNumber.has(opportunityNumberOf(award))
  );

  const limit = targetCount ?? Number.POSITIVE_INFINITY;
  const selected = drawRoundRobin(groupByNumber(matchedAwards), limit).map(award => ({
    award,
    opportunity: byNumber.get(opportunityNumberOf(award)) as ResolvedOpportunity,
  }));

  return {
    selected,
    matchedAwardCount: matchedAwards.length,
    matchedNumbers: [...byNumber.keys()].sort(),
    unmatchedNumbers: unmatchedNumbers.sort(),
  };
}
