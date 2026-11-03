/**
 * Stubbed Simpler.Grants.gov and USAspending for the refresh tests: a listing
 * and CommonGrants records for two opportunities, a zipped award download, and
 * three real USAspending award records (`fixtures/usaspending-awards.json`).
 */

import { expect, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
import awardDetails from "./fixtures/usaspending-awards.json" with { type: "json" };

export const MATCHED = "IW-SIW-18-001";
export const OPP_A = "00000000-0000-4000-8000-0000000000a1";
export const OPP_B = "00000000-0000-4000-8000-0000000000b2";

export function opportunity(id: string, fon: string, title: string) {
  return {
    id,
    title,
    description: `${title} description`,
    status: { value: "closed" },
    createdAt: "2024-11-01T00:00:00Z",
    lastModifiedAt: "2024-11-02T00:00:00Z",
    customFields: {
      federalOpportunityNumber: {
        name: "federalOpportunityNumber",
        fieldType: "string",
        value: fon,
      },
    },
  };
}

export interface Upstream {
  /** `posted` defaults to 2024-11-01, inside the first fiscal year in scope. */
  listing: { id: string; fon: string; title: string; version: string; posted?: string }[];
  records: Map<string, unknown>;
  /** Rows in the award download: key, opportunity number, last modified. */
  rows: [string, string, string][];
  downloadRows?: number;
  /** The first this-many download requests are reported as failed builds. */
  failBuilds?: number;
}

function csv(rows: [string, string, string][]): string {
  const header = "assistance_award_unique_key,funding_opportunity_number,last_modified_date";
  return [header, ...rows.map(r => r.map(v => (v.includes(",") ? `"${v}"` : v)).join(","))].join(
    "\n"
  );
}

export function stub(upstream: Upstream) {
  const zip = () =>
    zipSync({
      "Assistance_PrimeAwardSummaries_2026-11-03_1.csv": strToU8(csv(upstream.rows)),
      "Assistance_Subawards_2026-11-03.csv": strToU8(""),
    });
  const details = new Map(awardDetails.map(a => [a.generated_unique_award_id, a]));
  const calls: string[] = [];
  let downloadRequests = 0;

  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/v1/opportunities/search")) {
      const { filters } = JSON.parse(String(init?.body)) as {
        filters: { post_date: { start_date: string; end_date: string } };
      };
      const { start_date: start, end_date: end } = filters.post_date;
      const inWindow = upstream.listing.filter(l => {
        const posted = l.posted ?? "2024-11-01";
        return posted >= start && posted <= end;
      });
      return Response.json({
        data: inWindow.map(l => ({
          opportunity_id: l.id,
          opportunity_number: l.fon,
          opportunity_title: l.title,
          summary: { updated_at: l.version },
        })),
        pagination_info: { total_pages: 1, total_records: inWindow.length },
      });
    }
    const cg = url.match(/\/common-grants\/opportunities\/([^/]+)$/);
    if (cg) {
      const record = upstream.records.get(decodeURIComponent(cg[1]!));
      return record ? Response.json({ data: record }) : new Response("gone", { status: 404 });
    }
    if (url.endsWith("/api/v2/download/awards/")) {
      const body = JSON.parse(String(init?.body)) as {
        filters: { time_period: { date_type?: string }[] };
      };
      expect(body.filters.time_period).toHaveLength(1);
      expect(body.filters.time_period[0]?.date_type).toBe("action_date");
      downloadRequests += 1;
      return Response.json({
        status_url: `https://dl.test/status?n=${downloadRequests}`,
        file_url: "https://dl.test/f.zip",
      });
    }
    if (url.startsWith("https://dl.test/status")) {
      const n = Number(new URL(url).searchParams.get("n"));
      if (n <= (upstream.failBuilds ?? 0)) {
        return Response.json({ status: "failed", total_rows: 0, message: "An error occurred." });
      }
      return Response.json({
        status: "finished",
        total_rows: upstream.downloadRows ?? upstream.rows.length,
      });
    }
    if (url === "https://dl.test/f.zip") return new Response(zip());
    const award = url.match(/\/api\/v2\/awards\/([^/]+)\/$/);
    if (award) {
      const detail = details.get(decodeURIComponent(award[1]!));
      return detail ? Response.json(detail) : new Response("missing", { status: 404 });
    }
    return new Response(`unexpected ${url}`, { status: 500 });
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, calls };
}

export function baseline(): Upstream {
  return {
    listing: [
      { id: OPP_A, fon: MATCHED, title: "Water", version: "v1" },
      { id: OPP_B, fon: "SM00-PAIMI", title: "Advocacy", version: "v1" },
    ],
    records: new Map<string, unknown>([
      [OPP_A, opportunity(OPP_A, MATCHED, "Water")],
      [OPP_B, opportunity(OPP_B, "SM00-PAIMI", "Advocacy")],
    ]),
    rows: awardDetails.map(a => [
      a.generated_unique_award_id,
      a.funding_opportunity?.number ?? "",
      a.period_of_performance?.last_modified_date ?? "",
    ]),
  };
}
