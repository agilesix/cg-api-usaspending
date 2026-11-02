/**
 * The CommonGrants `AwardBase` model and the sub-models the transform builds,
 * as types inferred from the published TypeScript SDK schemas.
 *
 * https://commongrants.org/protocol/models/award/
 *
 * These are output types: date-bearing fields hold `Date` values. Those values
 * must be produced by the SDK's own parsers, which return `Date` subclasses
 * whose `toJSON` emits the protocol's wire format (`YYYY-MM-DD` for a plain
 * date). See `dates.ts`.
 */

import type {
  AwardBaseSchema,
  AwdFundingSchema,
  AwdIdsSchema,
  AwdStatusSchema,
  AwdTimelineSchema,
  IdentifierSchema,
  MoneySchema,
  OppIdsSchema,
  OppRefSchema,
  OrgIdsSchema,
  OrgRefCollectionSchema,
  OrgRefSchema,
  SystemMetadataSchema,
} from "@common-grants/sdk/schemas";
import type { z } from "zod";

export type AwardBase = z.output<typeof AwardBaseSchema>;
export type AwdFunding = z.output<typeof AwdFundingSchema>;
export type AwdIds = z.output<typeof AwdIdsSchema>;
export type AwdStatus = z.output<typeof AwdStatusSchema>;
export type AwdTimeline = z.output<typeof AwdTimelineSchema>;
export type Identifier = z.output<typeof IdentifierSchema>;
export type Money = z.output<typeof MoneySchema>;
export type OppIds = z.output<typeof OppIdsSchema>;
export type OppRef = z.output<typeof OppRefSchema>;
export type OrgIds = z.output<typeof OrgIdsSchema>;
export type OrgRef = z.output<typeof OrgRefSchema>;
export type OrgRefCollection = z.output<typeof OrgRefCollectionSchema>;
export type SystemMetadata = z.output<typeof SystemMetadataSchema>;
