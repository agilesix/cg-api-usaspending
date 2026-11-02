/**
 * Test doubles.
 *
 * The route tests are deliberately independent of the bundled fixture ids and
 * counts, so they keep working after an adopter replaces `src/data` with their
 * own repository.
 */

import { OpportunitySchema, type Opportunity } from "../src/data/schema.js";
import type { OpportunityRepository, Page } from "../src/data/repository.js";

let seq = 0;

/** Builds a valid opportunity with an overridable, deterministic shape. */
export function anOpportunity(overrides: Record<string, unknown> = {}): Opportunity {
  seq += 1;
  const n = String(seq).padStart(12, "0");
  return OpportunitySchema.parse({
    id: `00000000-0000-4000-8000-${n}`,
    title: `Opportunity ${seq}`,
    description: `Description ${seq}`,
    status: { value: "open" },
    funding: { maxAwardAmount: { amount: "1000.00", currency: "USD" } },
    keyDates: {
      closeDate: { name: "Application deadline", eventType: "singleDate", date: "2026-05-01" },
    },
    createdAt: "2026-01-01T00:00:00Z",
    lastModifiedAt: "2026-01-02T00:00:00Z",
    ...overrides,
  });
}

/**
 * An opportunity that satisfies the TypeScript type but not the schema.
 *
 * `id` is typed `string`, so a non-UUID compiles cleanly — which is exactly
 * the failure mode the route layer has to catch. Output typing is not
 * validation.
 */
export function aMalformedOpportunity(): Opportunity {
  return { ...anOpportunity(), id: "not-a-uuid" };
}

export interface StubCalls {
  list: unknown[];
  get: unknown[];
  search: unknown[];
}

export interface StubResponses {
  list?: Page<Opportunity>;
  get?: Opportunity | null;
  search?: Page<Opportunity>;
  throws?: Error;
}

/** A repository that answers with canned values and records how it was called. */
export function stubRepository(responses: StubResponses = {}): {
  repository: OpportunityRepository;
  calls: StubCalls;
} {
  const calls: StubCalls = { list: [], get: [], search: [] };

  const answer = <T>(value: T): T => {
    if (responses.throws) throw responses.throws;
    return value;
  };

  const repository: OpportunityRepository = {
    async list(sorting, pagination) {
      calls.list.push({ sorting, pagination });
      return answer(responses.list ?? emptyPage());
    },
    async get(id) {
      calls.get.push(id);
      return answer(responses.get ?? null);
    },
    async search(filters, sorting, pagination) {
      calls.search.push({ filters, sorting, pagination });
      return answer(responses.search ?? emptyPage());
    },
  };

  return { repository, calls };
}

export function emptyPage(): Page<Opportunity> {
  return { items: [], totalItems: 0 };
}

export function pageOf(items: Opportunity[], totalItems = items.length): Page<Opportunity> {
  return { items, totalItems };
}
