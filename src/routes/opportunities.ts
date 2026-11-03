/**
 * The `/common-grants/opportunities` routes.
 *
 * Route definitions (`createRoute`) are kept apart from their handlers so the
 * HTTP contract stays readable on its own. Every request schema and every
 * response schema comes from `@common-grants/sdk/schemas`; the only local
 * additions are the numeric coercion a query string needs and the shared
 * {@link OpportunitySchema}.
 *
 * The handlers own everything the repository deliberately does not: defaults,
 * response envelopes, pagination metadata, truthful reporting of filters and
 * sort keys that were *not* applied, and full parsing of the response before
 * it is serialized.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  FilteredSchema,
  NotFoundSchema,
  OkSchema,
  OppFiltersSchema,
  OppSortingSchema,
  PaginatedBodyParamsSchema,
  PaginatedSchema,
  UuidSchema,
} from "@common-grants/sdk/schemas";
import { OpportunityDetailsSchema, OpportunitySchema } from "../data/schema.js";
import type {
  OpportunityFilters,
  OpportunityRepository,
  SortField,
  SortSpec,
} from "../data/repository.js";
import { validationErrorHook } from "../http.js";
import {
  ERROR_RESPONSES,
  PaginationQuerySchema,
  normalizePagination,
  paginationInfo,
  serverError,
  validated,
} from "./common.js";

// ############################################################################
// Request schemas
// ############################################################################

/**
 * The path parameter for the read route, validated by the SDK's `UuidSchema`.
 * The SDK schema is applied through a refinement rather than used directly, so
 * the OpenAPI parameter metadata can sit on a schema built by `@hono/zod-openapi`.
 */
const OppIdParamSchema = z.object({
  oppId: z
    .string()
    .refine(value => UuidSchema.safeParse(value).success, { message: "Invalid UUID" })
    .openapi({
      param: { name: "oppId", in: "path" },
      format: "uuid",
      example: "0f8d3c1a-4b2e-4c6f-9a10-000000000001",
    }),
});

/**
 * Deliberately not `.strict()`. Zod strips unknown keys by default, the SDK's
 * own `OppFiltersSchema` is not strict, and the protocol's OpenAPI document
 * sets no `additionalProperties` on the search body, so a client on a newer
 * protocol version can send a field this template does not know about and
 * still be served. The Express and FastAPI templates behave the same way. The
 * trade-off is that a misspelled key (`filter` for `filters`) is ignored
 * rather than rejected.
 */
const SearchRequestSchema = z.object({
  search: z.string().optional(),
  filters: OppFiltersSchema.optional(),
  sorting: OppSortingSchema.optional(),
  pagination: PaginatedBodyParamsSchema.optional(),
});

// ############################################################################
// Response schemas
// ############################################################################

const OpportunitiesListSchema = PaginatedSchema(OpportunitySchema);
const OpportunityDetailSchema = OkSchema(OpportunityDetailsSchema);
const OpportunitiesSearchSchema = FilteredSchema(OpportunitySchema, OppFiltersSchema);

// ############################################################################
// Route definitions
// ############################################################################

export const listOpportunitiesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Opportunities"],
  summary: "List opportunities",
  description:
    "Get a paginated list of opportunities, sorted by `lastModifiedAt` with most recent first.",
  request: { query: PaginationQuerySchema },
  responses: {
    200: {
      description: "A paginated list of opportunities",
      content: { "application/json": { schema: OpportunitiesListSchema } },
    },
    ...ERROR_RESPONSES,
  },
});

export const getOpportunityRoute = createRoute({
  method: "get",
  path: "/{oppId}",
  tags: ["Opportunities"],
  summary: "View opportunity details",
  description: "View details about an opportunity, including the awards it resulted in.",
  request: { params: OppIdParamSchema },
  responses: {
    200: {
      description: "The requested opportunity",
      content: { "application/json": { schema: OpportunityDetailSchema } },
    },
    404: {
      description: "No opportunity has that id",
      content: { "application/json": { schema: NotFoundSchema } },
    },
    ...ERROR_RESPONSES,
  },
});

export const searchOpportunitiesRoute = createRoute({
  method: "post",
  path: "/search",
  tags: ["Opportunities"],
  summary: "Search opportunities",
  description: "Search for opportunities based on the provided filters.",
  request: {
    body: { content: { "application/json": { schema: SearchRequestSchema } }, required: false },
  },
  responses: {
    200: {
      description: "A filtered, sorted, paginated list of opportunities",
      content: { "application/json": { schema: OpportunitiesSearchSchema } },
    },
    ...ERROR_RESPONSES,
  },
});

// ############################################################################
// Request normalization
// ############################################################################

/** The order the protocol specifies for the list route. */
/**
 * The order of the list route, and of a search that asks for none. Owned here
 * so the repository never has to know it: `list` and `search` both receive a
 * fully resolved {@link SortSpec}.
 */
const DEFAULT_SORT: SortSpec = { sortBy: "lastModifiedAt", sortOrder: "desc" };

type Sorting = z.output<typeof OppSortingSchema>;
type SortInfo = z.output<typeof OpportunitiesSearchSchema>["sortInfo"];

/**
 * Resolves a sort request into something the repository can execute, plus the
 * `sortInfo` that truthfully describes what was done.
 *
 * `OppSortingSchema.sortOrder` is nullable but `SortedResultsInfoSchema.sortOrder`
 * is not, so a direction has to be chosen here rather than passed through. An
 * explicit `sortBy` defaults to ascending; the implicit default order is
 * `lastModifiedAt` descending.
 *
 * This template advertises no implementation-defined sort keys, so `"custom"`
 * falls back to the default order and says so in `sortInfo.errors` — per
 * ADR-0013, an unsupported sort must never be reported as applied.
 */
function resolveSorting(sorting: Sorting | undefined): { spec: SortSpec; info: SortInfo } {
  if (sorting === undefined || sorting.sortBy === "custom") {
    const errors =
      sorting === undefined
        ? undefined
        : [
            `Custom sort keys are not supported by this API${
              sorting.customSortBy ? ` (received "${sorting.customSortBy}")` : ""
            }. Results are sorted by lastModifiedAt descending instead.`,
          ];
    return {
      spec: DEFAULT_SORT,
      info: {
        sortBy: DEFAULT_SORT.sortBy,
        sortOrder: DEFAULT_SORT.sortOrder,
        customSortBy: sorting?.customSortBy,
        errors,
      },
    };
  }

  const sortBy: SortField = sorting.sortBy;
  const sortOrder = sorting.sortOrder ?? "asc";
  return { spec: { sortBy, sortOrder }, info: { sortBy, sortOrder } };
}

type Filters = z.output<typeof OppFiltersSchema>;
type FilterInfo = z.output<typeof OpportunitiesSearchSchema>["filterInfo"];

/**
 * Splits a filter request into the filters this API implements and a truthful
 * report of the ones it ignored.
 *
 * Per ADR-0012 an unsupported custom filter is ignored and named in
 * `filterInfo.errors`. Ignored filters are deliberately left out of
 * `filterInfo.filters`, which describes only what was actually applied.
 */
function resolveFilters(
  filters: Filters | undefined,
  search: string | undefined
): {
  applied: OpportunityFilters;
  info: FilterInfo;
} {
  const { customFilters, ...defaults } = filters ?? {};
  const errors = Object.keys(customFilters ?? {}).map(
    name => `Custom filter "${name}" is not supported by this API and was ignored.`
  );

  if (search !== undefined && search !== "") {
    errors.push("Free-text search is not implemented by this API and was ignored.");
  }

  return {
    applied: defaults,
    info: { filters: defaults, errors: errors.length > 0 ? errors : undefined },
  };
}

// ############################################################################
// Router
// ############################################################################

/**
 * Builds the opportunities router over any repository implementation.
 *
 * Each handler parses its complete response envelope before serializing it. A
 * repository that returns malformed data therefore produces a 500 with the
 * details logged server-side, never a 200 carrying data that does not match
 * the published schema.
 */
export function createOpportunityRoutes(repository: OpportunityRepository) {
  const routes = new OpenAPIHono({ defaultHook: validationErrorHook });

  routes.openapi(listOpportunitiesRoute, async c => {
    const pagination = normalizePagination(c.req.valid("query"));
    const page = await repository.list(DEFAULT_SORT, pagination);

    const body = validated(OpportunitiesListSchema, {
      status: 200,
      message: "Opportunities fetched successfully",
      items: page.items,
      paginationInfo: paginationInfo(page, pagination),
    });
    if (body === null) return c.json(serverError(), 500);
    return c.json(body, 200);
  });

  routes.openapi(getOpportunityRoute, async c => {
    const { oppId } = c.req.valid("param");
    const opportunity = await repository.get(oppId);

    if (opportunity === null) {
      return c.json({ status: 404 as const, message: "Opportunity not found", errors: [] }, 404);
    }

    const body = validated(OpportunityDetailSchema, {
      status: 200,
      message: "Opportunity fetched successfully",
      data: opportunity,
    });
    if (body === null) return c.json(serverError(), 500);
    return c.json(body, 200);
  });

  routes.openapi(searchOpportunitiesRoute, async c => {
    const request = c.req.valid("json") ?? {};
    const pagination = normalizePagination(request.pagination ?? {});
    const { spec, info: sortInfo } = resolveSorting(request.sorting);
    const { applied, info: filterInfo } = resolveFilters(request.filters, request.search);

    const page = await repository.search(applied, spec, pagination);

    const body = validated(OpportunitiesSearchSchema, {
      status: 200,
      message: "Opportunities searched successfully",
      items: page.items,
      paginationInfo: paginationInfo(page, pagination),
      sortInfo,
      filterInfo,
    });
    if (body === null) return c.json(serverError(), 500);
    return c.json(body, 200);
  });

  return routes;
}
