/**
 * Simpler.Grants.gov opportunity lookup, via the CommonGrants SDK and the
 * Grants.gov plugin.
 *
 * The plugin binds its Opportunity schema and its registered search filters, so
 * `customFields.federalOpportunityNumber` comes back typed and validated. That
 * field is the join key: USAspending reports the same value in
 * `funding_opportunity.number`.
 *
 * The CommonGrants search API has no filter for the opportunity number, so each
 * lookup is a free-text search followed by an exact match on the parsed custom
 * field. Text search can return near matches (a number that merely appears in a
 * description, or a sibling number sharing a prefix), so the match is always
 * confirmed against `federalOpportunityNumber` rather than trusted from ranking.
 */

import { z } from "zod";
import { Auth } from "@common-grants/sdk/client";
import plugin from "@common-grants/cg-grants-gov";
import type { Config } from "./config.js";

export type SggOpportunity = z.output<typeof plugin.schemas.Opportunity.commonSchema>;

/** A matched opportunity: the fields the join and transform read, plus the full record. */
export interface ResolvedOpportunity {
  /** The opportunity's CommonGrants UUID. */
  id: string;
  title: string;
  /** The federal opportunity number that matched, as reported by Simpler.Grants.gov. */
  federalOpportunityNumber: string;
  /** The opportunity as Simpler.Grants.gov served it, for the opportunity routes. */
  record: SggOpportunity;
}

export interface OpportunityResolver {
  /** Returns the matching opportunity, or null when Simpler.Grants.gov has none. */
  resolve(federalOpportunityNumber: string): Promise<ResolvedOpportunity | null>;
}

/** Compares opportunity numbers the way the two systems disagree in practice:
 * surrounding whitespace and letter case vary, everything else must be equal. */
function sameNumber(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** How many search hits to scan for an exact opportunity-number match. */
const SEARCH_PAGE_SIZE = 25;

export function createOpportunityResolver(config: Config): OpportunityResolver {
  const client = plugin.getClient({
    baseUrl: config.sggBaseUrl,
    auth: Auth.apiKey(config.sggApiKey, config.sggAuthHeader),
  });

  return {
    async resolve(federalOpportunityNumber) {
      const result = await client.opportunities.search({
        query: federalOpportunityNumber,
        page: 1,
        pageSize: SEARCH_PAGE_SIZE,
      });

      for (const item of result.items) {
        const reported = item.customFields?.federalOpportunityNumber?.value;
        if (typeof reported === "string" && sameNumber(reported, federalOpportunityNumber)) {
          return {
            id: item.id,
            title: item.title,
            federalOpportunityNumber: reported,
            record: item,
          };
        }
      }
      return null;
    },
  };
}
