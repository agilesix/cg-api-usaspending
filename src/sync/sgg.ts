/**
 * Simpler.Grants.gov, in two calls:
 *
 * - `POST /v1/opportunities/search` lists every opportunity posted since the
 *   start date, with a "last updated" marker, in a handful of large pages. It
 *   is the only endpoint that filters on posting date.
 * - `GET /common-grants/opportunities/{id}` returns one opportunity as a
 *   CommonGrants record. This is the record the API serves, the same one the
 *   sample version served, so it is fetched only when the marker changes.
 */

import { z } from "zod";
import { fiscalYearSlices } from "./usaspending-download.js";

export interface SggConfig {
  baseUrl: string;
  apiKey: string;
  authHeader: string;
}

export interface OpportunityListing {
  id: string;
  fon: string;
  title: string;
  /** Changes whenever Simpler.Grants.gov updates the opportunity. */
  sourceVersion: string | null;
}

const ListingSchema = z.object({
  opportunity_id: z.string(),
  opportunity_number: z.string().nullish(),
  opportunity_title: z.string().nullish(),
  summary: z.object({ updated_at: z.string().nullish() }).nullish(),
});

const SearchResponseSchema = z.object({
  data: z.array(ListingSchema),
  pagination_info: z.object({ total_pages: z.number(), total_records: z.number() }),
});

/** All four statuses: a closed or archived opportunity can still have awards. */
const STATUSES = ["forecasted", "posted", "closed", "archived"];

/** The search API stops counting at 10,000 matches. */
const SEARCH_RESULT_LIMIT = 10_000;

const PAGE_SIZE = 1000;

function headers(config: SggConfig): Record<string, string> {
  return {
    [config.authHeader]: config.apiKey,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

/**
 * Every opportunity posted on or after `postedSince` (YYYY-MM-DD), listed one
 * fiscal year at a time so no single search nears the 10,000-result limit as
 * the window grows. Each window is checked: the ids returned must equal the
 * count the search reports, since a short list would make the refresh remove
 * real opportunities.
 */
export async function listOpportunities(
  config: SggConfig,
  postedSince: string,
  today: string = new Date().toISOString().slice(0, 10)
): Promise<OpportunityListing[]> {
  const listings: OpportunityListing[] = [];
  for (const window of fiscalYearSlices(postedSince, today)) {
    listings.push(...(await listWindow(config, window.startDate, window.endDate)));
  }
  return listings;
}

async function listWindow(
  config: SggConfig,
  startDate: string,
  endDate: string
): Promise<OpportunityListing[]> {
  const byId = new Map<string, OpportunityListing>();
  let reported: number;
  for (let page = 1; ; page += 1) {
    const response = await fetch(`${config.baseUrl}/v1/opportunities/search`, {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify({
        pagination: {
          page_offset: page,
          page_size: PAGE_SIZE,
          // The id tiebreak keeps the order stable, so a record cannot move
          // between pages mid-listing.
          sort_order: [
            { order_by: "post_date", sort_direction: "ascending" },
            { order_by: "opportunity_id", sort_direction: "ascending" },
          ],
        },
        filters: {
          opportunity_status: { one_of: STATUSES },
          post_date: { start_date: startDate, end_date: endDate },
        },
      }),
    });
    if (!response.ok) {
      throw new Error(
        `Simpler.Grants.gov search failed: ${response.status} ${response.statusText}`
      );
    }
    const body = SearchResponseSchema.parse(await response.json());
    reported = body.pagination_info.total_records;
    if (reported >= SEARCH_RESULT_LIMIT) {
      throw new Error(
        `Simpler.Grants.gov reports ${reported} opportunities posted ${startDate}..${endDate}, at its search limit`
      );
    }
    for (const item of body.data) {
      byId.set(item.opportunity_id, {
        id: item.opportunity_id,
        fon: item.opportunity_number?.trim() ?? "",
        title: item.opportunity_title ?? "",
        sourceVersion: item.summary?.updated_at ?? null,
      });
    }
    if (page >= body.pagination_info.total_pages) break;
  }
  if (byId.size !== reported) {
    throw new Error(
      `Simpler.Grants.gov listed ${byId.size} distinct opportunities for ${startDate}..${endDate}, but reported ${reported}`
    );
  }
  // An opportunity with no number cannot link to an award, so it is not served.
  return [...byId.values()].filter(listing => listing.fon !== "");
}

const DetailResponseSchema = z.object({ data: z.record(z.string(), z.unknown()) });

/**
 * Rewrites a UTC offset of `+00:00` as `Z`, leaving any other value alone.
 *
 * Simpler.Grants.gov writes attachment timestamps as `2024-11-04T11:42:00+00:00`,
 * but the CommonGrants schema only accepts the `Z` form of UTC. Both name the
 * same instant, so rewriting the suffix changes nothing a client can observe
 * except that the record now validates. Without this, about six in ten
 * opportunities with attachments would be rejected.
 */
function utcAsZ(value: unknown): unknown {
  return typeof value === "string" && value.endsWith("+00:00") ? `${value.slice(0, -6)}Z` : value;
}

/** Applies {@link utcAsZ} to each attachment's timestamps. */
export function normalizeAttachmentDates(record: Record<string, unknown>): Record<string, unknown> {
  const customFields = record.customFields as Record<string, unknown> | undefined;
  const attachments = customFields?.attachments as { value?: unknown } | undefined;
  if (!Array.isArray(attachments?.value)) return record;
  attachments.value = attachments.value.map((item: unknown) =>
    item !== null && typeof item === "object"
      ? {
          ...item,
          createdAt: utcAsZ((item as Record<string, unknown>).createdAt),
          lastModifiedAt: utcAsZ((item as Record<string, unknown>).lastModifiedAt),
        }
      : item
  );
  return record;
}

/**
 * One opportunity as a CommonGrants record, unparsed, or `null` when
 * Simpler.Grants.gov no longer has it.
 */
export async function fetchOpportunity(config: SggConfig, id: string): Promise<unknown> {
  const response = await fetch(
    `${config.baseUrl}/common-grants/opportunities/${encodeURIComponent(id)}`,
    { headers: headers(config) }
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Simpler.Grants.gov opportunity ${id} failed: ${response.status}`);
  }
  return normalizeAttachmentDates(DetailResponseSchema.parse(await response.json()).data);
}
