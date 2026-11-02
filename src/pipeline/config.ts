/**
 * Refresh configuration.
 *
 * Read from a plain record of strings rather than `process.env`, so the same
 * code configures a run from Node (`scripts/refresh.ts`) and from the
 * Cloudflare Worker's scheduled handler, where settings arrive as bindings.
 * Every value except `SGG_API_KEY` has a default.
 */

/** Awarding agencies to sample USAspending candidates from.
 *
 * These are the toptier agency names USAspending recognizes. The default list is
 * limited to agencies that actually populate `funding_opportunity_number` with a
 * posted opportunity number; DOT, USDA, and HUD report `NOT APPLICABLE` on
 * effectively every assistance award and would only add candidates that get
 * filtered out.
 */
const DEFAULT_AGENCIES = [
  "Department of Health and Human Services",
  "Department of Education",
  "Environmental Protection Agency",
  "Department of Justice",
  "Department of the Interior",
  "National Science Foundation",
  "Department of Energy",
];

/** USAspending assistance award type codes.
 *
 * 02 = block grant, 03 = formula grant, 04 = project grant, 05 = cooperative
 * agreement. These are the four types the GSDM requires a funding opportunity
 * number for.
 */
const DEFAULT_AWARD_TYPE_CODES = ["02", "03", "04", "05"];

/** Length of the default action-date window, ending on the run date. */
const DEFAULT_WINDOW_DAYS = 365;

export type PipelineEnv = Record<string, string | undefined>;

export interface Config {
  /** Base URL of the Simpler.Grants.gov CommonGrants API. */
  sggBaseUrl: string;
  /** Simpler.Grants.gov API key. */
  sggApiKey: string;
  /** Header the API key is sent in. */
  sggAuthHeader: string;
  /** Base URL of the USAspending API. */
  usaSpendingBaseUrl: string;
  /** Toptier awarding agency names to sample from. */
  agencies: string[];
  /** USAspending assistance award type codes to include. */
  awardTypeCodes: string[];
  /** Action-date window for the USAspending award search. */
  timePeriod: { startDate: string; endDate: string };
  /** Awards to pull per agency, per sort order. */
  candidatesPerAgency: number;
  /** Optional cap on how many joined awards to emit. Undefined emits all of them. */
  targetAwardCount: number | undefined;
  /** Max concurrent HTTP requests per upstream API. */
  concurrency: number;
  /**
   * The date the run treats as "now" when deriving award status and the record
   * timestamps USAspending does not publish. Defaults to the current time,
   * which is what a scheduled refresh wants. Pin it to reproduce a snapshot.
   */
  asOf: Date;
}

function int(env: PipelineEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

/** Reads an optional positive integer. Unset means no value, not zero. */
function optionalInt(env: PipelineEnv, name: string): number | undefined {
  return env[name] ? int(env, name, 0) : undefined;
}

function list(env: PipelineEnv, name: string, fallback: string[]): string[] {
  const raw = env[name];
  if (!raw) return fallback;
  const items = raw
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  if (items.length === 0) throw new Error(`${name} was set but contained no values`);
  return items;
}

/** Reads the run's reference date. Unset means now. */
function asOfDate(env: PipelineEnv, now: Date): Date {
  const raw = env.AS_OF;
  if (!raw) return now;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`AS_OF must be a parseable date, got "${raw}"`);
  }
  return parsed;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function loadConfig(env: PipelineEnv, now: Date = new Date()): Config {
  const sggApiKey = env.SGG_API_KEY;
  if (!sggApiKey) throw new Error("SGG_API_KEY is required to look up opportunities");

  const asOf = asOfDate(env, now);
  const windowStart = new Date(asOf.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  return {
    sggBaseUrl: env.SGG_BASE_URL ?? "https://api.simpler.grants.gov",
    sggApiKey,
    sggAuthHeader: env.SGG_AUTH_HEADER ?? "X-API-Key",
    usaSpendingBaseUrl: env.USASPENDING_BASE_URL ?? "https://api.usaspending.gov",
    agencies: list(env, "USASPENDING_AGENCIES", DEFAULT_AGENCIES),
    awardTypeCodes: list(env, "USASPENDING_AWARD_TYPE_CODES", DEFAULT_AWARD_TYPE_CODES),
    timePeriod: {
      startDate: env.USASPENDING_START_DATE ?? isoDay(windowStart),
      endDate: env.USASPENDING_END_DATE ?? isoDay(asOf),
    },
    candidatesPerAgency: int(env, "CANDIDATES_PER_AGENCY", 15),
    targetAwardCount: optionalInt(env, "TARGET_AWARD_COUNT"),
    concurrency: int(env, "CONCURRENCY", 8),
    asOf,
  };
}
