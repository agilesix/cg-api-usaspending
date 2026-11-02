/**
 * Date construction for emitted records.
 *
 * The protocol's `isoDate` is a date-only `YYYY-MM-DD` value, and the SDK parses
 * it into a `Date`. A plain `Date` would serialize to a full timestamp, which the
 * schema's `format: date` assertion rejects, so the SDK returns a `Date` subclass
 * whose `toJSON` emits the date-only form (see HHS/simpler-grants-protocol#1024).
 *
 * That subclass is internal and unexported, so the only way to obtain one is to
 * parse through `ISODateSchema`. Everything here therefore routes through the
 * SDK's parsers rather than constructing dates directly. Copying a parsed value
 * with `new Date(value)` or `structuredClone` loses the behavior and reintroduces
 * the timestamp, so parsed values are passed along untouched.
 */

import { ISODateSchema, UTCDateTimeSchema } from "@common-grants/sdk/schemas";

/** Parses a `YYYY-MM-DD` string into a value that serializes back to that form. */
export function isoDate(value: string): Date {
  return ISODateSchema.parse(value) as Date;
}

/** Parses an RFC 3339 timestamp into a UTC `Date`. */
export function utcDateTime(value: string): Date {
  return UTCDateTimeSchema.parse(value) as Date;
}

/** Widens a `YYYY-MM-DD` string to a UTC timestamp at midnight. */
export function utcMidnight(isoDateString: string): Date {
  return utcDateTime(`${isoDateString}T00:00:00Z`);
}
