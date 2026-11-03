/**
 * Matching USAspending opportunity numbers to Simpler.Grants.gov ones.
 *
 * The two systems usually agree exactly, but not always: case, spacing and
 * dash characters vary, and some agencies report a number without its prefix
 * (`JG-26-0142` for `CDC-RFA-JG-26-0142`). Matching is therefore:
 *
 * 1. **Exact**, after normalizing both sides.
 * 2. **Suffix**, at a dash boundary, and only when exactly one stored number
 *    ends that way. A suffix shared by several numbers is ambiguous and is
 *    counted, never guessed.
 */

/**
 * Values agencies report in place of a real opportunity number, normalized.
 * The GSDM lets an agency report "Not Applicable" when an award is not
 * competitive and discretionary; several agencies use minor variants.
 */
const NOT_APPLICABLE = new Set(["NOTAPPLICABLE", "N/A", "NA", "NONE", "-", "0"]);

/** True when a reported number is a placeholder rather than a real one. */
export function isNotApplicable(fon: string): boolean {
  return NOT_APPLICABLE.has(normalizeFon(fon));
}

/** Uppercase, no whitespace, and every dash variant folded to "-". */
export function normalizeFon(fon: string): string {
  return fon
    .toUpperCase()
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, "");
}

/**
 * A suffix worth matching on: at least two segments, with letters and digits.
 * Shorter or all-numeric tails ("0142", "2026-001") are too generic to trust.
 */
function isDistinctiveSuffix(suffix: string): boolean {
  return suffix.includes("-") && /[A-Z]/.test(suffix) && /\d/.test(suffix);
}

export type MatchMethod = "exact" | "suffix";

export type FonMatch =
  | { kind: "matched"; opportunityId: string; method: MatchMethod }
  | { kind: "ambiguous" }
  | { kind: "unmatched" }
  | { kind: "none" };

export interface FonMatcher {
  match(fon: string | null | undefined): FonMatch;
}

/**
 * Builds a matcher over the stored opportunities' numbers. Numbers shared by
 * several opportunities are ambiguous even on an exact match.
 */
export function createFonMatcher(opportunities: Iterable<{ id: string; fon: string }>): FonMatcher {
  const exact = new Map<string, string[]>();
  for (const { id, fon } of opportunities) {
    const key = normalizeFon(fon);
    if (key) exact.set(key, [...(exact.get(key) ?? []), id]);
  }

  const suffixes = new Map<string, Set<string>>();
  for (const [key, ids] of exact) {
    const parts = key.split("-");
    for (let i = 1; i < parts.length; i += 1) {
      const suffix = parts.slice(i).join("-");
      if (!isDistinctiveSuffix(suffix)) continue;
      const set = suffixes.get(suffix) ?? new Set<string>();
      for (const id of ids) set.add(id);
      suffixes.set(suffix, set);
    }
  }

  return {
    match(fon) {
      const key = normalizeFon(fon ?? "");
      if (!key || NOT_APPLICABLE.has(key)) return { kind: "none" };

      const exactIds = exact.get(key);
      if (exactIds !== undefined) {
        return exactIds.length === 1 && exactIds[0] !== undefined
          ? { kind: "matched", opportunityId: exactIds[0], method: "exact" }
          : { kind: "ambiguous" };
      }

      const suffixIds = suffixes.get(key);
      if (suffixIds === undefined) return { kind: "unmatched" };
      const [only] = suffixIds;
      return suffixIds.size === 1 && only !== undefined
        ? { kind: "matched", opportunityId: only, method: "suffix" }
        : { kind: "ambiguous" };
    },
  };
}
