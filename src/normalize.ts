/**
 * AIS wire-format normalization helpers.
 *
 * AIS encodes several "not available" values as sentinel numbers that
 * are easy to miss:
 *   - SOG       102.3   → not available
 *   - COG       360     → not available
 *   - Heading   511     → not available
 *   - Position  lat=91, lon=181 → not available
 *
 * Vessel names, call signs, and destinations are space-padded to fixed
 * widths in the wire format ("CATHERINE C    "). Always trim before use.
 *
 * Vessel dimensions are encoded as four offsets from the GNSS antenna
 * (A from bow, B from stern, C from port, D from starboard). Length =
 * A + B; beam = C + D.
 *
 * AISStream timestamps use a custom format that JavaScript's Date.parse
 * cannot consume directly. Use `parseAisTimestamp` to convert.
 */

import type { Dimension } from "./envelope";

// --- Sentinel constants ---------------------------------------------------

/** AIS sentinel: SOG (knots) value indicating "not available". */
export const SOG_NA = 102.3;
/** AIS sentinel: COG (degrees true) value indicating "not available". */
export const COG_NA = 360;
/** AIS sentinel: TrueHeading (degrees true) value indicating "not available". */
export const HEADING_NA = 511;

// --- String trimming ------------------------------------------------------

/**
 * Trim space-padded AIS string fields. AISStream's wire format pads
 * vessel names, call signs, destinations, etc. to fixed widths with
 * trailing spaces.
 *
 * Returns `undefined` for empty / whitespace-only / null / undefined inputs
 * so callers don't have to distinguish between "not present" and "present
 * but empty".
 */
export function trimAisString(s: string | undefined | null): string | undefined {
  if (s == null) return undefined;
  const t = s.trim();
  return t === "" ? undefined : t;
}

// --- Numeric sentinel normalizers -----------------------------------------

/** Normalize SOG (speed over ground) — returns null for sentinel/invalid values. */
export function normalizeSog(sog: number): number | null {
  return sog === SOG_NA || sog < 0 ? null : sog;
}

/** Normalize COG (course over ground) — returns null for sentinel/invalid values. */
export function normalizeCog(cog: number): number | null {
  return cog === COG_NA || cog < 0 || cog >= 360 ? null : cog;
}

/** Normalize TrueHeading — returns null for sentinel/invalid values. */
export function normalizeHeading(h: number): number | null {
  return h === HEADING_NA || h < 0 || h > 360 ? null : h;
}

/**
 * Validate AIS latitude/longitude.
 *
 * AIS encodes "position not available" as lat=91, lon=181 — both excluded
 * by the standard WGS-84 range check below. Also catches malformed values.
 */
export function isValidPosition(lat: number, lon: number): boolean {
  return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

// --- Vessel dimension extraction ------------------------------------------

/**
 * Extract length and beam (meters) from an AIS Dimension structure.
 *
 * AIS encodes vessel size as four offsets from the GNSS antenna position:
 *   A = distance from bow (m)
 *   B = distance from stern (m)
 *   C = distance from port (m)
 *   D = distance from starboard (m)
 *
 * Length = A + B; beam = C + D. Zero values indicate "not reported";
 * if all are zero, both length and beam come back as `undefined`.
 */
export function dimToLengthBeamM(d: Dimension): {
  lengthM: number | undefined;
  beamM: number | undefined;
} {
  const length = d.A + d.B;
  const beam = d.C + d.D;
  return {
    lengthM: length > 0 ? length : undefined,
    beamM: beam > 0 ? beam : undefined,
  };
}

// --- Timestamp parsing ----------------------------------------------------

/**
 * Parse an AISStream `time_utc` field into a `Date`.
 *
 * AISStream sends timestamps in this exact format:
 *   `"2026-05-05 23:52:50.801045713 +0000 UTC"`
 *
 * Not ISO 8601 (space separator, trailing "UTC" label, nanosecond precision).
 * JavaScript's built-in `Date.parse` cannot handle this format reliably.
 *
 * Returns `null` if the input doesn't match the expected format. Truncates
 * sub-millisecond precision (JS `Date` is millisecond-precision).
 */
export function parseAisTimestamp(time_utc: string): Date | null {
  // Match: YYYY-MM-DD HH:MM:SS[.fractional] +ZZZZ UTC
  const m = time_utc.match(
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)? (\+\d{4}) UTC$/,
  );
  if (!m) return null;
  const [, date, time, frac] = m;
  // JS Date precision is milliseconds — truncate sub-ms digits.
  // frac is ".801045713" → take ".801" (4 chars including the dot).
  const ms = frac ? frac.substring(0, 4).padEnd(4, "0") : "";
  // Combine into an ISO-8601 string. The zone is always "+0000 UTC" in
  // AISStream output today; we hard-code Z for parsing safety.
  const iso = `${date}T${time}${ms}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}
