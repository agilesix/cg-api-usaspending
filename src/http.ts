/**
 * Shared HTTP error shapes.
 *
 * Every non-2xx body this API produces validates against the SDK's
 * `ErrorSchema`, so a client can parse failures with the same protocol
 * schemas it uses for successes.
 *
 * Unlike success envelopes, error bodies are not parsed at runtime. They carry
 * no repository output, only literals and Zod issues, so the `ErrorBody` type
 * and the `ErrorSchema.parse` assertions in `test/app.test.ts` are the check.
 */

import type { Env } from "hono";
import type { OpenAPIHonoOptions } from "@hono/zod-openapi";
import type { ErrorSchema } from "@common-grants/sdk/schemas";
import type { z } from "zod";

export type ErrorBody = z.output<typeof ErrorSchema>;

export function errorBody(status: number, message: string, errors: unknown[] = []): ErrorBody {
  return { status, message, errors };
}

/**
 * Turns a request-validation failure into an `ErrorSchema`-shaped 400.
 *
 * Without this, `@hono/zod-openapi` answers with its own body, which no
 * CommonGrants client knows how to read. The type is borrowed from the
 * library's own constructor options so this stays a single source of truth
 * for every router that installs it.
 */
export const validationErrorHook: NonNullable<OpenAPIHonoOptions<Env>["defaultHook"]> = (
  result,
  c
) => {
  if (!result.success) {
    return c.json(errorBody(400, "Invalid request", result.error.issues), 400);
  }
  return undefined;
};
