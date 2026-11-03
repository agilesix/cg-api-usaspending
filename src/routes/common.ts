/**
 * Pieces every router shares: query-string pagination, the reused error
 * responses, pagination metadata and response validation.
 */

import { z } from "@hono/zod-openapi";
import { ErrorSchema, PaginatedQueryParamsSchema } from "@common-grants/sdk/schemas";
import type { Page, Pagination } from "../data/repository.js";
import { errorBody } from "../http.js";

/**
 * Query-string pagination.
 *
 * Query parameters always arrive as strings, so they are coerced here — at the
 * transport boundary — and the coerced object is then validated by the SDK's
 * own `PaginatedQueryParamsSchema` in {@link normalizePagination}.
 */
export const PaginationQuerySchema = z.object({
  page: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .openapi({ param: { name: "page", in: "query" }, example: 1 }),
  // Positive integer only. The protocol sets no maximum page size, and this
  // API must not invent one — `PaginatedQueryParamsSchema` and
  // core/lib/core/pagination.tsp both declare `@minValue(1)` and no ceiling.
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .openapi({ param: { name: "pageSize", in: "query" }, example: 25 }),
});

/**
 * Reused on every route.
 *
 * These are written out as plain object literals rather than built by a
 * helper: `@hono/zod-openapi` infers each response's body type with a
 * conditional type that only resolves against a literal
 * `{ content: { "application/json": { schema } } }`. Wrapping that in a
 * generic factory silently drops the non-2xx responses from the handler's
 * return-type union.
 */
export const ERROR_RESPONSES = {
  400: {
    description: "The request did not match the schema",
    content: { "application/json": { schema: ErrorSchema } },
  },
  500: {
    description: "The server could not produce a valid response",
    content: { "application/json": { schema: ErrorSchema } },
  },
};

/**
 * Applies the SDK's pagination defaults and flattens its nullable output into
 * the plain positive integers the repository seam expects.
 */
export function normalizePagination(input: {
  page?: number | null;
  pageSize?: number | null;
}): Pagination {
  const { page, pageSize } = PaginatedQueryParamsSchema.parse(input);
  return { page: page ?? 1, pageSize: pageSize ?? 100 };
}

/**
 * `pageSize` is the *requested* page size, per core `pagination.tsp` and the
 * sibling Express template — not the number of items on this page, which is
 * smaller on the last page and zero past it.
 */
export function paginationInfo({ totalItems }: Page<unknown>, { page, pageSize }: Pagination) {
  return {
    page,
    pageSize,
    totalItems,
    totalPages: Math.ceil(totalItems / pageSize),
  };
}

/**
 * Parses a response envelope, returning `null` when it does not match the
 * published schema. The Zod issues are logged server-side; the client sees
 * only a generic 500.
 */
export function validated<T extends z.ZodType>(schema: T, payload: unknown): z.output<T> | null {
  const parsed = schema.safeParse(payload);
  if (parsed.success) return parsed.data;
  console.error("Repository returned data that does not match the published schema", {
    issues: parsed.error.issues,
  });
  return null;
}

export function serverError() {
  return errorBody(500, "The server could not produce a valid response");
}
