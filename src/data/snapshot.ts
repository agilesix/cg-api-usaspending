/**
 * The snapshot file: everything the API serves, produced by one refresh.
 *
 * A refresh (`src/pipeline/run.ts`) writes one of these; the API reads one at
 * startup (Node) or per isolate (Cloudflare Worker). Records are stored in their
 * wire form and parsed with the published schemas on load, so a snapshot that
 * no longer matches the protocol fails loudly instead of reaching a client.
 */

import { z } from "zod";
import { AwardBaseSchema } from "@common-grants/sdk/schemas";
import { OpportunitySchema } from "./schema.js";

/** Where the snapshot's records came from and how the refresh narrowed them down. */
const SnapshotReportSchema = z.object({
  usaSpending: z.object({
    agencies: z.array(z.string()),
    awardTypeCodes: z.array(z.string()),
    timePeriod: z.object({ startDate: z.string(), endDate: z.string() }),
  }),
  funnel: z.object({
    awardsFetched: z.number().int(),
    awardsWithOpportunityNumber: z.number().int(),
    distinctOpportunityNumbers: z.number().int(),
    matchedOpportunityNumbers: z.number().int(),
    awardsJoined: z.number().int(),
    awardsEmitted: z.number().int(),
    awardsRejected: z.number().int(),
  }),
  unmatchedNumbers: z.array(z.string()),
});

export const SnapshotSchema = z.object({
  /** The date the records were derived against: the "data as of" date. */
  asOf: z.iso.datetime(),
  report: SnapshotReportSchema,
  opportunities: z.array(OpportunitySchema),
  awards: z.array(AwardBaseSchema),
});

/** A parsed snapshot. Date-valued fields are real `Date`s. */
export type Snapshot = z.output<typeof SnapshotSchema>;
export type SnapshotReport = z.output<typeof SnapshotReportSchema>;
export type Award = Snapshot["awards"][number];

/** Parses a snapshot from its JSON text. */
export function parseSnapshot(json: string): Snapshot {
  return SnapshotSchema.parse(JSON.parse(json));
}
