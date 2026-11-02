/**
 * The single opportunity schema used by this API.
 *
 * Everything downstream — repository types, fixture parsing, response
 * factories, response validation and tests — imports {@link OpportunitySchema}
 * from here. That makes this file the one place to edit to add custom fields
 * to the opportunity data, its types and its OpenAPI definitions at once.
 *
 * To add custom fields, see "Add custom fields in one file" in PORTING.md.
 */

import { OpportunityBaseSchema } from "@common-grants/sdk/schemas";
import type { z } from "zod";

/** The opportunity model this API serves. */
export const OpportunitySchema = OpportunityBaseSchema;

/** A parsed opportunity. `Date`-valued fields are real `Date`s, not strings. */
export type Opportunity = z.output<typeof OpportunitySchema>;
