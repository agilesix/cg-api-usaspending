/**
 * Transforms a joined (USAspending award, Simpler.Grants.gov opportunity) pair
 * into a CommonGrants `AwardBase` record.
 *
 * Fields that USAspending does not carry are derived rather than invented, and
 * every derivation is noted on the field it affects. The three that matter:
 *
 *   - `id` and the UUIDs on organization references are UUIDv5 values derived
 *     from source keys (see ids.ts). USAspending has no UUIDs of its own.
 *   - `title` has no USAspending equivalent. Short award descriptions read as
 *     titles, so they are used directly; longer ones fall back to the
 *     opportunity title plus the FAIN.
 *   - `createdAt` / `lastModifiedAt` describe the record, which USAspending does
 *     not timestamp. The award's signing date and the transaction's last
 *     modified date stand in.
 */

import type {
  AwardBase,
  AwdIds,
  AwdStatus,
  AwdFunding,
  AwdTimeline,
  Identifier,
  Money,
  OppIds,
  OppRef,
  OrgIds,
  OrgRef,
  OrgRefCollection,
  SystemMetadata,
} from "./award-types.js";
import { agencyUuid, awardUuid, recipientUuid } from "./ids.js";
import { isoDate, utcDateTime, utcMidnight } from "./dates.js";
import type { AwardDetail } from "./usaspending.js";
import { opportunityNumberOf } from "./usaspending.js";
import type { ResolvedOpportunity } from "./sgg.js";

// =============================================================================
// Registry codes
// =============================================================================

const REGISTRY_BASE = "https://commongrants.org/registries";

/** Registries the protocol defines. */
const FAIN = { code: "awd:us:fain", url: `${REGISTRY_BASE}/awd-us-fain` } as const;
const FON = { code: "opp:us:fon", url: `${REGISTRY_BASE}/opp-us-fon` } as const;
const ALN = { code: "opp:us:aln", url: `${REGISTRY_BASE}/opp-us-aln` } as const;
const UEI = { code: "org:us:uei", url: `${REGISTRY_BASE}/org-us-uei` } as const;
const DUNS = { code: "org:xi:duns", url: `${REGISTRY_BASE}/org-xi-duns` } as const;

/** Extension registries this script publishes, for source keys the protocol has
 * no base identifier for. Codes follow the `<schema>:<scope>:<prop>` convention. */
const USASPENDING_SYSTEM = { code: "awd:usaspending:system" };
const USASPENDING_AWARD_ID = {
  code: "awd:usaspending:generated-unique-award-id",
};
const USASPENDING_URI = { code: "awd:usaspending:uri" };
const USASPENDING_ORG_SYSTEM = { code: "org:usaspending:system" };
const RECIPIENT_HASH = { code: "org:usaspending:recipient-hash" };
const AGENCY_TOPTIER = { code: "org:usaspending:toptier-code" };
const AGENCY_SUBTIER = { code: "org:usaspending:subtier-code" };
const SGG_OPPORTUNITY = { code: "opp:grants.gov:system" };

// =============================================================================
// Scalar helpers
// =============================================================================

/** Formats a number as a CommonGrants `decimalString` (two decimal places). */
function money(amount: number): Money {
  return { amount: amount.toFixed(2), currency: "USD" };
}

/** Collapses runs of whitespace so descriptions read as one line. */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Builds an identifier, keeping the registry's literal code in the type. */
function identifier<Code extends string>(
  registry: { code: Code; url?: string },
  id: string | null | undefined
): { registry: { code: Code; url?: string }; id: string } | undefined {
  const trimmed = id?.trim();
  return trimmed ? { registry, id: trimmed } : undefined;
}

// =============================================================================
// Field builders
// =============================================================================

/** The longest description that reads as a title rather than a summary. */
const TITLE_LENGTH_LIMIT = 150;

function buildTitle(award: AwardDetail, opportunity: ResolvedOpportunity): string {
  const description = award.description ? normalizeText(award.description) : "";
  if (description && description.length <= TITLE_LENGTH_LIMIT) return description;

  const suffix = award.fain?.trim() || award.generated_unique_award_id;
  return `${opportunity.title} (${suffix})`;
}

function buildDescription(award: AwardDetail, federalOpportunityNumber: string): string {
  const description = award.description ? normalizeText(award.description) : "";
  if (description) return description;

  const goals = award.funding_opportunity?.goals
    ? normalizeText(award.funding_opportunity.goals)
    : "";
  if (goals) return goals;

  const label = award.fain?.trim() || award.generated_unique_award_id;
  return `Award ${label} under funding opportunity ${federalOpportunityNumber}. The USAspending record carries no award description.`;
}

/**
 * Derives the award's lifecycle status from its period of performance.
 *
 * USAspending has no status field for assistance awards. A period of performance
 * that has ended maps to `completed`, anything else to `awarded`. Terminated
 * awards are not distinguishable in this data, so `cancelled` is never emitted.
 */
function buildStatus(award: AwardDetail, asOf: Date): AwdStatus {
  return awardStatus(award.period_of_performance?.end_date, asOf);
}

/**
 * The status rule on its own, for stores that keep the period-of-performance
 * end date and derive status when the record is read, so it never goes stale.
 */
export function awardStatus(periodEnd: string | null | undefined, asOf: Date): AwdStatus {
  const endDate = periodEnd?.trim();
  if (endDate && Date.parse(`${endDate}T23:59:59Z`) < asOf.getTime()) {
    return {
      value: "completed",
      description: `Period of performance ended ${endDate}.`,
    };
  }
  return {
    value: "awarded",
    description: endDate
      ? `Award issued; period of performance runs through ${endDate}.`
      : "Award issued.",
  };
}

function buildFunding(award: AwardDetail): AwdFunding | undefined {
  const funding: AwdFunding = {};

  if (award.total_obligation != null) funding.awardedAmount = money(award.total_obligation);

  // `total_outlay` is null on most assistance awards; the account-level rollup is
  // the value USAspending actually populates for disbursements.
  const outlay = award.total_outlay ?? award.total_account_outlay;
  if (outlay != null) funding.disbursedAmount = money(outlay);

  if (award.non_federal_funding != null && award.non_federal_funding > 0) {
    funding.details = `Includes ${money(award.non_federal_funding).amount} USD of non-federal funding, which is not part of the obligated federal amount.`;
  }

  return Object.keys(funding).length > 0 ? funding : undefined;
}

function buildKeyDates(award: AwardDetail): AwdTimeline | undefined {
  const timeline: AwdTimeline = {};

  const signed = award.date_signed?.trim();
  if (signed) {
    timeline.awardDate = {
      name: "Award date",
      eventType: "singleDate",
      date: isoDate(signed),
      description: "The date the award was signed, per USAspending.",
    };
  }

  const start = award.period_of_performance?.start_date?.trim();
  const end = award.period_of_performance?.end_date?.trim();
  if (start && end) {
    timeline.periodOfPerformance = {
      name: "Period of performance",
      eventType: "dateRange",
      startDate: isoDate(start),
      endDate: isoDate(end),
      description: "The period during which the funded work is performed.",
    };
  }

  return Object.keys(timeline).length > 0 ? timeline : undefined;
}

/** Award-scoped identifiers. Opportunity-scoped registries (`opp:*`) belong on
 * the opportunity reference, not here. */
function buildIdentifiers(award: AwardDetail, awardId: string): AwdIds {
  const identifiers: AwdIds = {
    systemId: { registry: USASPENDING_SYSTEM, id: awardId },
  };

  const fain = identifier(FAIN, award.fain);
  if (fain) identifiers["awd:us:fain"] = fain;

  const otherIds: Record<string, Identifier> = {};

  const awardIdentifier = identifier(USASPENDING_AWARD_ID, award.generated_unique_award_id);
  if (awardIdentifier) otherIds[USASPENDING_AWARD_ID.code] = awardIdentifier;

  const uri = identifier(USASPENDING_URI, award.uri);
  if (uri) otherIds[USASPENDING_URI.code] = uri;

  if (Object.keys(otherIds).length > 0) identifiers.otherIds = otherIds;

  return identifiers;
}

/**
 * Builds the reference to the opportunity the award resulted from.
 *
 * The reference carries the opportunity's own identifiers, including
 * `opp:us:fon`, the key the join was made on. That lets a consumer re-derive the
 * join without re-querying either API. `OppRef.identifiers` is part of Core v0.5.
 */
function buildOpportunityRef(award: AwardDetail, opportunity: ResolvedOpportunity): OppRef {
  const ref: OppRef = { id: opportunity.id, title: opportunity.title };

  const identifiers: OppIds = {
    systemId: { registry: SGG_OPPORTUNITY, id: opportunity.id },
  };

  const fon = identifier(FON, opportunity.federalOpportunityNumber);
  if (fon) identifiers["opp:us:fon"] = fon;

  const aln = identifier(ALN, award.cfda_info?.[0]?.cfda_number);
  if (aln) identifiers["opp:us:aln"] = aln;

  ref.identifiers = identifiers;
  return ref;
}

interface AgencyTier {
  name?: string | null;
  code?: string | null;
  abbreviation?: string | null;
}

function buildAgencyRef(
  toptier: AgencyTier | null | undefined,
  subtier: AgencyTier | null | undefined,
  useSubtier: boolean
): OrgRef | undefined {
  const tier = useSubtier ? subtier : toptier;
  const name = tier?.name?.trim();
  const toptierCode = toptier?.code?.trim();
  if (!name || !toptierCode) return undefined;

  const subtierCode = useSubtier ? subtier?.code?.trim() : undefined;
  const ref: OrgRef = {
    id: agencyUuid(toptierCode, subtierCode),
    name,
  };

  const otherIds: Record<string, Identifier> = {};
  const codeIdentifier = identifier(
    useSubtier ? AGENCY_SUBTIER : AGENCY_TOPTIER,
    useSubtier ? subtierCode : toptierCode
  );
  if (codeIdentifier) {
    otherIds[useSubtier ? AGENCY_SUBTIER.code : AGENCY_TOPTIER.code] = codeIdentifier;
  }
  if (Object.keys(otherIds).length > 0) ref.identifiers = { otherIds };

  return ref;
}

function buildFunders(award: AwardDetail): OrgRefCollection | undefined {
  const awarding = award.awarding_agency;
  const primary = buildAgencyRef(awarding?.toptier_agency, awarding?.subtier_agency, false);
  if (!primary) return undefined;

  const collection: OrgRefCollection = { primary };
  const otherOrgs: Record<string, OrgRef> = {};

  // The subtier agency is the operating division that actually made the award
  // (NIH within HHS, for instance), which is usually the more useful of the two.
  const subtier = buildAgencyRef(awarding?.toptier_agency, awarding?.subtier_agency, true);
  if (subtier && subtier.name !== primary.name) otherOrgs.awardingSubtierAgency = subtier;

  const funding = award.funding_agency;
  const fundingRef = buildAgencyRef(funding?.toptier_agency, funding?.subtier_agency, false);
  if (fundingRef && fundingRef.id !== primary.id) otherOrgs.fundingAgency = fundingRef;

  if (Object.keys(otherOrgs).length > 0) collection.otherOrgs = otherOrgs;
  return collection;
}

interface RecipientSource {
  hash?: string | null;
  uei?: string | null;
  duns?: string | null;
  name: string;
}

/**
 * Builds a recipient organization reference.
 *
 * `id` is USAspending's own entity UUID, taken from the recipient hash. A
 * `systemId` is emitted only in that case, since claiming one for a UUID this
 * script derived would misrepresent where it came from. The hash's full
 * suffixed form is preserved separately under `org:usaspending:recipient-hash`,
 * because the suffix is meaningful: it records the entity level (`R` recipient,
 * `P` parent, `C` child) and is the form USAspending's own lookups expect.
 */
function buildRecipientRef(source: RecipientSource): OrgRef {
  const { id, fromSource } = recipientUuid(source.hash, source.uei, source.name);
  const ref: OrgRef = { id, name: source.name };
  const identifiers: OrgIds = {};

  if (fromSource) {
    identifiers.systemId = { registry: USASPENDING_ORG_SYSTEM, id };
  }

  const hash = identifier(RECIPIENT_HASH, source.hash);
  if (hash) identifiers.otherIds = { [RECIPIENT_HASH.code]: hash };

  const uei = identifier(UEI, source.uei?.toUpperCase());
  if (uei) identifiers["org:us:uei"] = uei;

  const duns = identifier(DUNS, source.duns);
  if (duns) identifiers["org:xi:duns"] = duns;

  if (Object.keys(identifiers).length > 0) ref.identifiers = identifiers;
  return ref;
}

function buildRecipients(award: AwardDetail): OrgRefCollection | undefined {
  const recipient = award.recipient;
  const name = recipient?.recipient_name?.trim();
  if (!name) return undefined;

  const collection: OrgRefCollection = {
    primary: buildRecipientRef({
      hash: recipient?.recipient_hash,
      uei: recipient?.recipient_uei,
      duns: recipient?.recipient_unique_id,
      name,
    }),
  };

  const parentName = recipient?.parent_recipient_name?.trim();
  if (parentName && parentName !== name) {
    collection.otherOrgs = {
      parentRecipient: buildRecipientRef({
        hash: recipient?.parent_recipient_hash,
        uei: recipient?.parent_recipient_uei,
        name: parentName,
      }),
    };
  }

  return collection;
}

/** Record timestamps, standing in for the ones USAspending does not publish. */
function buildTimestamps(award: AwardDetail, asOf: Date): SystemMetadata {
  const signed = award.date_signed?.trim();
  const start = award.period_of_performance?.start_date?.trim();
  const createdAt = signed
    ? utcMidnight(signed)
    : start
      ? utcMidnight(start)
      : utcDateTime(asOf.toISOString());

  const modified = award.period_of_performance?.last_modified_date?.trim();
  const lastModifiedAt = modified ? utcMidnight(modified) : createdAt;

  // A last-modified date that precedes the signing date would be incoherent to a
  // consumer, so the later of the two wins.
  return {
    createdAt,
    lastModifiedAt: lastModifiedAt.getTime() < createdAt.getTime() ? createdAt : lastModifiedAt,
  };
}

// =============================================================================
// Transform
// =============================================================================

export interface TransformContext {
  /** The date the records are derived against. Used for status and fallback timestamps. */
  asOf: Date;
}

/** Maps a USAspending award and its matched opportunity into an `AwardBase`. */
export function toAwardBase(
  award: AwardDetail,
  opportunity: ResolvedOpportunity,
  context: TransformContext
): AwardBase {
  const awardId = awardUuid(award.generated_unique_award_id);
  const federalOpportunityNumber = opportunityNumberOf(award);
  const { createdAt, lastModifiedAt } = buildTimestamps(award, context.asOf);

  const record: AwardBase = {
    id: awardId,
    title: buildTitle(award, opportunity),
    identifiers: buildIdentifiers(award, awardId),
    description: buildDescription(award, federalOpportunityNumber),
    status: buildStatus(award, context.asOf),
    opportunity: buildOpportunityRef(award, opportunity),
    source: `https://www.usaspending.gov/award/${encodeURIComponent(award.generated_unique_award_id)}`,
    createdAt,
    lastModifiedAt,
  };

  const funding = buildFunding(award);
  if (funding) record.funding = funding;

  const keyDates = buildKeyDates(award);
  if (keyDates) record.keyDates = keyDates;

  const funders = buildFunders(award);
  if (funders) record.funders = funders;

  const recipients = buildRecipients(award);
  if (recipients) record.recipientOrganizations = recipients;

  return record;
}
