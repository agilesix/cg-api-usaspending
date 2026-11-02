/**
 * The data seam.
 *
 * `createApp()` accepts any {@link OpportunityRepository}, so replacing the
 * bundled fixtures with a database or an upstream API is a matter of writing
 * one more implementation of this interface. Nothing HTTP-shaped crosses this
 * boundary: no envelopes, no framework context, no status codes. The route
 * layer owns defaults, pagination metadata and error reporting.
 */

import type { OppDefaultFiltersSchema, OppSortByEnum } from "@common-grants/sdk/schemas";
import type { z } from "zod";
import type { Opportunity } from "./schema.js";

/** Pagination normalized by the route layer: always present, always positive. */
export interface Pagination {
  page: number;
  pageSize: number;
}

/** One page of results plus the total number of matches across all pages. */
export interface Page<T> {
  items: T[];
  totalItems: number;
}

/** The filters this API actually implements (the protocol's default set). */
export type OpportunityFilters = z.output<typeof OppDefaultFiltersSchema>;

/**
 * A sort key this API can execute.
 *
 * `"custom"` is excluded on purpose: implementation-defined sort keys are not
 * advertised by this template, so the route layer falls back to the default
 * order and reports that in `sortInfo.errors` rather than passing an
 * unsupported key down here.
 */
export type SortField = Exclude<z.output<typeof OppSortByEnum>, "custom">;

/** A fully resolved sort instruction. The route layer supplies both halves. */
export interface SortSpec {
  sortBy: SortField;
  sortOrder: "asc" | "desc";
}

export interface OpportunityRepository {
  /** Every opportunity, in the requested order. */
  list(sorting: SortSpec, pagination: Pagination): Promise<Page<Opportunity>>;

  /** One opportunity by id, or `null` when no record has that id. */
  get(id: string): Promise<Opportunity | null>;

  /** Opportunities matching every supplied filter, in the requested order. */
  search(
    filters: OpportunityFilters,
    sorting: SortSpec,
    pagination: Pagination
  ): Promise<Page<Opportunity>>;
}
