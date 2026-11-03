/**
 * USAspending source client.
 *
 * Two endpoints are used:
 *
 *   POST /api/v2/search/spending_by_award/  -> page of awards, to get award ids
 *   GET  /api/v2/awards/{id}/               -> full award record
 *
 * The funding opportunity number only appears on the detail response, and the
 * search endpoint does not accept it as a filter or return it as a field, so the
 * only way to collect awards by opportunity number is to page through awards and
 * read each detail record. That is why this stage samples rather than queries.
 */

import { z } from "zod";
import type { Config } from "./config.js";
import { mapWithConcurrency } from "./concurrency.js";

// =============================================================================
// Response schemas
// =============================================================================

const SearchResponseSchema = z.object({
  results: z.array(
    z.object({
      "Award ID": z.string().nullish(),
      generated_internal_id: z.string(),
    })
  ),
});

const AgencyTierSchema = z.object({
  name: z.string().nullish(),
  code: z.string().nullish(),
  abbreviation: z.string().nullish(),
});

const AgencySchema = z.object({
  toptier_agency: AgencyTierSchema.nullish(),
  subtier_agency: AgencyTierSchema.nullish(),
});

const AwardDetailSchema = z.object({
  generated_unique_award_id: z.string(),
  fain: z.string().nullish(),
  uri: z.string().nullish(),
  category: z.string().nullish(),
  type: z.string().nullish(),
  type_description: z.string().nullish(),
  description: z.string().nullish(),
  date_signed: z.string().nullish(),
  total_obligation: z.number().nullish(),
  total_outlay: z.number().nullish(),
  total_account_outlay: z.number().nullish(),
  non_federal_funding: z.number().nullish(),
  period_of_performance: z
    .object({
      start_date: z.string().nullish(),
      end_date: z.string().nullish(),
      last_modified_date: z.string().nullish(),
    })
    .nullish(),
  funding_opportunity: z
    .object({
      number: z.string().nullish(),
      goals: z.string().nullish(),
    })
    .nullish(),
  cfda_info: z
    .array(
      z.object({
        cfda_number: z.string().nullish(),
        cfda_title: z.string().nullish(),
      })
    )
    .nullish(),
  awarding_agency: AgencySchema.nullish(),
  funding_agency: AgencySchema.nullish(),
  recipient: z
    .object({
      recipient_name: z.string().nullish(),
      recipient_uei: z.string().nullish(),
      recipient_unique_id: z.string().nullish(),
      // USAspending's own entity identifier: a UUID with a level suffix (-R, -P, -C).
      recipient_hash: z.string().nullish(),
      parent_recipient_name: z.string().nullish(),
      parent_recipient_uei: z.string().nullish(),
      parent_recipient_hash: z.string().nullish(),
    })
    .nullish(),
});

export type AwardDetail = z.infer<typeof AwardDetailSchema>;

// =============================================================================
// HTTP helpers
// =============================================================================

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`POST ${url} failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

// =============================================================================
// Award collection
// =============================================================================

/** Sort orders requested per agency. Two orders surface a wider spread of
 * programs than one, since a single order tends to return many awards from the
 * same funding opportunity. */
const SORT_ORDERS: Array<{ sort: string; order: "asc" | "desc" }> = [
  { sort: "Award Amount", order: "desc" },
  { sort: "Award ID", order: "desc" },
];

/** Fetches one page of award ids for a single agency and sort order. */
async function fetchAwardIds(
  config: Config,
  agency: string,
  sort: string,
  order: "asc" | "desc"
): Promise<string[]> {
  const body = {
    filters: {
      award_type_codes: config.awardTypeCodes,
      time_period: [
        {
          start_date: config.timePeriod.startDate,
          end_date: config.timePeriod.endDate,
        },
      ],
      agencies: [{ type: "awarding", tier: "toptier", name: agency }],
    },
    fields: ["Award ID", "Award Amount", "generated_internal_id"],
    limit: config.candidatesPerAgency,
    sort,
    order,
  };
  const json = await postJson(
    `${config.usaSpendingBaseUrl}/api/v2/search/spending_by_award/`,
    body
  );
  return SearchResponseSchema.parse(json).results.map(r => r.generated_internal_id);
}

/** Fetches the full award record for a generated unique award id. */
export async function fetchAwardDetail(config: Config, awardId: string): Promise<AwardDetail> {
  const url = `${config.usaSpendingBaseUrl}/api/v2/awards/${encodeURIComponent(awardId)}/`;
  return AwardDetailSchema.parse(await getJson(url));
}

/** Values agencies submit in place of a real opportunity number. The GSDM lets
 * an agency report "Not Applicable" when an award is not competitive and
 * discretionary; several agencies use minor spelling variants. */
const NOT_APPLICABLE = new Set(["not applicable", "notapplicable", "n/a", "na", "none", "-", "0"]);

/** True when the award carries a funding opportunity number worth looking up. */
export function hasUsableOpportunityNumber(award: AwardDetail): boolean {
  const fon = award.funding_opportunity?.number?.trim();
  if (!fon) return false;
  return !NOT_APPLICABLE.has(fon.toLowerCase());
}

/** Reads the award's funding opportunity number, trimmed. */
export function opportunityNumberOf(award: AwardDetail): string {
  const fon = award.funding_opportunity?.number?.trim();
  if (!fon) throw new Error(`Award ${award.generated_unique_award_id} has no opportunity number`);
  return fon;
}

/**
 * The stage 1 snapshot as it lands on disk: only the awards fetched. The
 * filtered views are derived on read rather than stored, so a hand-edited or
 * half-refreshed snapshot cannot disagree with itself.
 *
 * Parsed rather than cast when it is read back, because the snapshot on disk is
 * a tracked file that can be hand-edited or left stale.
 */
export const CandidateSnapshotSchema = z.object({
  /** Every award detail fetched. */
  all: z.array(AwardDetailSchema),
});

/** A stage 1 sample, with the filtered views the rest of the pipeline reads. */
export interface CandidateSet {
  /** Every award detail fetched. */
  all: AwardDetail[];
  /** Awards carrying a usable funding opportunity number. */
  withOpportunityNumber: AwardDetail[];
  /** Distinct opportunity numbers across `withOpportunityNumber`. */
  opportunityNumbers: string[];
}

/** Derives the filtered views from the awards fetched. */
export function deriveCandidateSet(all: AwardDetail[]): CandidateSet {
  const withOpportunityNumber = all.filter(hasUsableOpportunityNumber);
  return {
    all,
    withOpportunityNumber,
    opportunityNumbers: [...new Set(withOpportunityNumber.map(opportunityNumberOf))].sort(),
  };
}

/**
 * Samples assistance awards across the configured agencies and returns those
 * carrying a usable funding opportunity number.
 */
export async function collectCandidates(config: Config): Promise<CandidateSet> {
  const requests = config.agencies.flatMap(agency =>
    SORT_ORDERS.map(({ sort, order }) => ({ agency, sort, order }))
  );

  const idBatches = await mapWithConcurrency(requests, config.concurrency, req =>
    fetchAwardIds(config, req.agency, req.sort, req.order)
  );
  const awardIds = [...new Set(idBatches.flat())];

  const all = await mapWithConcurrency(awardIds, config.concurrency, id =>
    fetchAwardDetail(config, id)
  );

  return deriveCandidateSet(all);
}
