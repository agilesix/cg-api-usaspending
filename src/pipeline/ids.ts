/**
 * Deterministic UUID generation.
 *
 * The CommonGrants Award model requires a UUID for the award and for every
 * organization reference. Neither USAspending nor its recipient records expose
 * one, so this module derives a stable UUIDv5 from the source system's natural
 * key. The same source record always yields the same UUID, which keeps output
 * diffable across runs and lets consumers join records back to their source.
 */

import { createHash } from "node:crypto";

/** Namespace UUID for identifiers minted by this script. */
const NAMESPACE = "6ba7b812-9dad-11d1-80b4-00c04fd430c8";

function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) throw new Error(`Not a UUID: ${uuid}`);
  return Buffer.from(hex, "hex");
}

/** Builds a version 5 (SHA-1, name-based) UUID from a namespace and a name. */
export function uuidV5(name: string, namespace: string = NAMESPACE): string {
  const hash = createHash("sha1").update(uuidToBytes(namespace)).update(name, "utf8").digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  // Set the version (5) and RFC 4122 variant bits.
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/** UUID for a USAspending award, keyed on its generated unique award id. */
export function awardUuid(generatedUniqueAwardId: string): string {
  return uuidV5(`usaspending:award:${generatedUniqueAwardId}`);
}

/** UUID for a federal agency, keyed on its USAspending toptier/subtier codes. */
export function agencyUuid(toptierCode: string, subtierCode?: string | null): string {
  const key = subtierCode ? `${toptierCode}:${subtierCode}` : toptierCode;
  return uuidV5(`usaspending:agency:${key}`);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Extracts the UUID out of a USAspending recipient hash.
 *
 * A recipient hash is a UUID with a one-character level suffix appended:
 * `-R` for a recipient, `-P` for a parent, `-C` for a child of a parent (for
 * example `78e2168c-91dc-4ee3-f4cb-fb8e0cff6ea8-R`). The UUID is USAspending's
 * own identifier for the entity, so it is preferred over a derived one.
 *
 * Returns undefined when the value is absent or not in that shape.
 */
export function uuidFromRecipientHash(hash: string | null | undefined): string | undefined {
  if (!hash) return undefined;
  const base = hash.replace(/-[RPC]$/, "");
  return UUID_PATTERN.test(base) ? base.toLowerCase() : undefined;
}

/**
 * UUID for a recipient organization.
 *
 * USAspending's own recipient UUID is used when the record carries a recipient
 * hash. Otherwise the UUID is derived from the UEI, or from the name when there
 * is no UEI.
 */
export function recipientUuid(
  hash: string | null | undefined,
  uei: string | null | undefined,
  name: string
): { id: string; fromSource: boolean } {
  const sourced = uuidFromRecipientHash(hash);
  if (sourced) return { id: sourced, fromSource: true };

  const derived = uei
    ? uuidV5(`usaspending:recipient:uei:${uei.toUpperCase()}`)
    : uuidV5(`usaspending:recipient:name:${name.toUpperCase()}`);
  return { id: derived, fromSource: false };
}
