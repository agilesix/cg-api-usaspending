/**
 * The single opportunity schema used by this API.
 *
 * Everything downstream — repository types, snapshot parsing, response
 * factories, response validation and tests — imports {@link OpportunitySchema}
 * from here. That makes this file the one place to edit to add custom fields
 * to the opportunity data, its types and its OpenAPI definitions at once.
 *
 * Opportunities come from Simpler.Grants.gov, so the schema is the Grants.gov
 * plugin's: the base model plus Grants.gov's custom fields, typed.
 */

import plugin from "@common-grants/cg-grants-gov";
import { AwdRefSchema } from "@common-grants/sdk/schemas";
import { z } from "zod";

/** The opportunity model this API serves. */
export const OpportunitySchema = plugin.schemas.Opportunity.commonSchema;

/**
 * An opportunity with the awards it resulted in, for the view route.
 *
 * The SDK's `OpportunityDetailsSchema` adds the same `awards` field to the base
 * model; this adds it to the plugin's model so the Grants.gov custom fields
 * stay typed.
 */
export const OpportunityDetailsSchema = OpportunitySchema.extend({
  awards: z.array(AwdRefSchema).optional(),
});

/** A parsed opportunity. `Date`-valued fields are real `Date`s, not strings. */
export type Opportunity = z.output<typeof OpportunitySchema>;
export type OpportunityDetails = z.output<typeof OpportunityDetailsSchema>;
