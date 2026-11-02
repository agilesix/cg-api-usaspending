/**
 * The `/common-grants/awards` routes (Core v0.5).
 *
 * Laid out like the opportunities router: route definitions first, then the
 * handlers. Requests and responses use the SDK's award route schemas as they
 * are published — `AwdSearchRequestSchema`, `AwardsListResponseSchema` and so
 * on — so this API accepts exactly what the SDK client sends and returns
 * exactly what it expects. Only the query-string coercion is local.
 *
 * Every award references the Simpler.Grants.gov opportunity it resulted from in
 * `opportunity`, so the `opportunityId` filter answers "which awards came from
 * this opportunity", and the opportunity view route lists the same awards.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  AwardResponseSchema,
  AwardsFilteredResponseSchema,
  AwardsListResponseSchema,
  AwdSearchRequestSchema,
  NotFoundSchema,
  UuidSchema,
} from "@common-grants/sdk/schemas";
import type {
  AwardFilters,
  AwardRepository,
  AwardSortField,
  AwardSortSpec,
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
const AwdIdParamSchema = z.object({
  awdId: z
    .string()
    .refine(value => UuidSchema.safeParse(value).success, { message: "Invalid UUID" })
    .openapi({
      param: { name: "awdId", in: "path" },
      format: "uuid",
      example: "0f8d3c1a-4b2e-5c6f-9a10-000000000001",
    }),
});

// ############################################################################
// Route definitions
// ############################################################################

export const listAwardsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Awards"],
  summary: "List awards",
  description: "Get a paginated list of awards, sorted by `lastModifiedAt` with most recent first.",
  request: { query: PaginationQuerySchema },
  responses: {
    200: {
      description: "A paginated list of awards",
      content: { "application/json": { schema: AwardsListResponseSchema } },
    },
    ...ERROR_RESPONSES,
  },
});

export const getAwardRoute = createRoute({
  method: "get",
  path: "/{awdId}",
  tags: ["Awards"],
  summary: "View award details",
  description: "View details about an award, including the opportunity it resulted from.",
  request: { params: AwdIdParamSchema },
  responses: {
    200: {
      description: "The requested award",
      content: { "application/json": { schema: AwardResponseSchema } },
    },
    404: {
      description: "No award has that id",
      content: { "application/json": { schema: NotFoundSchema } },
    },
    ...ERROR_RESPONSES,
  },
});

export const searchAwardsRoute = createRoute({
  method: "post",
  path: "/search",
  tags: ["Awards"],
  summary: "Search awards",
  description:
    "Search awards by text (title and description) and filters. Use the `opportunityId` " +
    "filter to find the awards that resulted from an opportunity.",
  request: {
    body: { content: { "application/json": { schema: AwdSearchRequestSchema } }, required: false },
  },
  responses: {
    200: {
      description: "A filtered, sorted, paginated list of awards",
      content: { "application/json": { schema: AwardsFilteredResponseSchema } },
    },
    ...ERROR_RESPONSES,
  },
});

// ############################################################################
// Request normalization
// ############################################################################

/** The order of the list route, and of a search that asks for none. */
const DEFAULT_SORT: AwardSortSpec = { sortBy: "lastModifiedAt", sortOrder: "desc" };

type SearchRequest = z.output<typeof AwdSearchRequestSchema>;
type SortInfo = z.output<typeof AwardsFilteredResponseSchema>["sortInfo"];
type FilterInfo = z.output<typeof AwardsFilteredResponseSchema>["filterInfo"];

/**
 * Resolves a sort request into something the repository can execute, plus the
 * `sortInfo` that truthfully describes what was done. As for opportunities,
 * `"custom"` falls back to the default order and says so in `sortInfo.errors`.
 */
function resolveSorting(sorting: SearchRequest["sorting"]): {
  spec: AwardSortSpec;
  info: SortInfo;
} {
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

  const sortBy: AwardSortField = sorting.sortBy;
  const sortOrder = sorting.sortOrder ?? "asc";
  return { spec: { sortBy, sortOrder }, info: { sortBy, sortOrder } };
}

/**
 * Splits a filter request into the filters this API implements and a truthful
 * report of the custom filters it ignored, per ADR-0012.
 */
function resolveFilters(filters: SearchRequest["filters"]): {
  applied: AwardFilters;
  info: FilterInfo;
} {
  const { customFilters, ...defaults } = filters ?? {};
  const errors = Object.keys(customFilters ?? {}).map(
    name => `Custom filter "${name}" is not supported by this API and was ignored.`
  );
  return {
    applied: defaults,
    info: { filters: defaults, errors: errors.length > 0 ? errors : undefined },
  };
}

// ############################################################################
// Router
// ############################################################################

/**
 * Builds the awards router over any repository implementation. As with
 * opportunities, every response envelope is parsed before it is serialized.
 */
export function createAwardRoutes(repository: AwardRepository) {
  const routes = new OpenAPIHono({ defaultHook: validationErrorHook });

  routes.openapi(listAwardsRoute, async c => {
    const pagination = normalizePagination(c.req.valid("query"));
    const page = await repository.list(DEFAULT_SORT, pagination);

    const body = validated(AwardsListResponseSchema, {
      status: 200,
      message: "Awards fetched successfully",
      items: page.items,
      paginationInfo: paginationInfo(page, pagination),
    });
    if (body === null) return c.json(serverError(), 500);
    return c.json(body, 200);
  });

  routes.openapi(getAwardRoute, async c => {
    const { awdId } = c.req.valid("param");
    const award = await repository.get(awdId);

    if (award === null) {
      return c.json({ status: 404 as const, message: "Award not found", errors: [] }, 404);
    }

    const body = validated(AwardResponseSchema, {
      status: 200,
      message: "Award fetched successfully",
      data: award,
    });
    if (body === null) return c.json(serverError(), 500);
    return c.json(body, 200);
  });

  routes.openapi(searchAwardsRoute, async c => {
    const request = c.req.valid("json") ?? {};
    const pagination = request.pagination ?? { page: 1, pageSize: 100 };
    const { spec, info: sortInfo } = resolveSorting(request.sorting);
    const { applied, info: filterInfo } = resolveFilters(request.filters);
    const query = request.search?.trim() || undefined;

    const page = await repository.search(query, applied, spec, pagination);

    const body = validated(AwardsFilteredResponseSchema, {
      status: 200,
      message: "Awards searched successfully",
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
