import { describe, expect, it } from "vitest";

import {
  COG_NA,
  HEADING_NA,
  SOG_NA,
  dimToLengthBeamM,
  isValidPosition,
  normalizeCog,
  normalizeHeading,
  normalizeSog,
  parseAisTimestamp,
  trimAisString,
} from "./normalize";

describe("normalizeSog", () => {
  it("returns null for the AIS sentinel value 102.3", () => {
    expect(normalizeSog(SOG_NA)).toBeNull();
    expect(normalizeSog(102.3)).toBeNull();
  });

  it("returns null for negative values", () => {
    expect(normalizeSog(-1)).toBeNull();
    expect(normalizeSog(-0.1)).toBeNull();
  });

  it("returns 0 unchanged (an anchored vessel is reporting 0 kn)", () => {
    expect(normalizeSog(0)).toBe(0);
  });

  it("returns a valid SOG unchanged", () => {
    expect(normalizeSog(14.7)).toBe(14.7);
    expect(normalizeSog(0.5)).toBe(0.5);
  });
});

describe("normalizeCog", () => {
  it("returns null for the AIS sentinel value 360", () => {
    expect(normalizeCog(COG_NA)).toBeNull();
    expect(normalizeCog(360)).toBeNull();
  });

  it("returns null for values >= 360", () => {
    expect(normalizeCog(360.1)).toBeNull();
    expect(normalizeCog(720)).toBeNull();
  });

  it("returns null for negative values", () => {
    expect(normalizeCog(-1)).toBeNull();
  });

  it("returns valid courses unchanged", () => {
    expect(normalizeCog(0)).toBe(0);
    expect(normalizeCog(180)).toBe(180);
    expect(normalizeCog(359.9)).toBe(359.9);
  });
});

describe("normalizeHeading", () => {
  it("returns null for the AIS sentinel value 511", () => {
    expect(normalizeHeading(HEADING_NA)).toBeNull();
    expect(normalizeHeading(511)).toBeNull();
  });

  it("returns 0 unchanged (a valid heading)", () => {
    expect(normalizeHeading(0)).toBe(0);
  });

  it("returns null for values > 360", () => {
    expect(normalizeHeading(361)).toBeNull();
  });

  it("returns valid headings unchanged", () => {
    expect(normalizeHeading(90)).toBe(90);
    expect(normalizeHeading(180)).toBe(180);
  });
});

describe("isValidPosition", () => {
  it("rejects AIS 'not available' sentinels (lat=91, lon=181)", () => {
    expect(isValidPosition(91, 181)).toBe(false);
    expect(isValidPosition(91, 0)).toBe(false);
    expect(isValidPosition(0, 181)).toBe(false);
  });

  it("accepts valid WGS-84 coordinates", () => {
    expect(isValidPosition(48.69, -123.41)).toBe(true);
    expect(isValidPosition(0, 0)).toBe(true);
    expect(isValidPosition(-90, -180)).toBe(true);
    expect(isValidPosition(90, 180)).toBe(true);
  });

  it("rejects out-of-range values", () => {
    expect(isValidPosition(90.1, 0)).toBe(false);
    expect(isValidPosition(0, -180.1)).toBe(false);
  });
});

describe("trimAisString", () => {
  it("trims trailing whitespace from space-padded fixed-width fields", () => {
    expect(trimAisString("CATHERINE C    ")).toBe("CATHERINE C");
    expect(trimAisString("VCZL3   ")).toBe("VCZL3");
  });

  it("returns undefined for empty string", () => {
    expect(trimAisString("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only string", () => {
    expect(trimAisString("    ")).toBeUndefined();
    expect(trimAisString(" \t ")).toBeUndefined();
  });

  it("returns undefined for null and undefined inputs", () => {
    expect(trimAisString(null)).toBeUndefined();
    expect(trimAisString(undefined)).toBeUndefined();
  });

  it("preserves internal whitespace", () => {
    expect(trimAisString("SKEENA QUEEN    ")).toBe("SKEENA QUEEN");
  });
});

describe("dimToLengthBeamM", () => {
  it("computes length = A + B and beam = C + D", () => {
    const r = dimToLengthBeamM({ A: 10, B: 20, C: 2, D: 3 });
    expect(r.lengthM).toBe(30);
    expect(r.beamM).toBe(5);
  });

  it("returns undefined when all dimensions are zero", () => {
    const r = dimToLengthBeamM({ A: 0, B: 0, C: 0, D: 0 });
    expect(r.lengthM).toBeUndefined();
    expect(r.beamM).toBeUndefined();
  });

  it("returns undefined for missing length when A+B = 0", () => {
    const r = dimToLengthBeamM({ A: 0, B: 0, C: 5, D: 5 });
    expect(r.lengthM).toBeUndefined();
    expect(r.beamM).toBe(10);
  });

  it("returns undefined for missing beam when C+D = 0", () => {
    const r = dimToLengthBeamM({ A: 50, B: 50, C: 0, D: 0 });
    expect(r.lengthM).toBe(100);
    expect(r.beamM).toBeUndefined();
  });
});

describe("parseAisTimestamp", () => {
  it("parses AISStream's `time_utc` format", () => {
    const d = parseAisTimestamp("2026-05-07 18:17:50.672000000 +0000 UTC");
    expect(d).not.toBeNull();
    expect(d?.toISOString()).toBe("2026-05-07T18:17:50.672Z");
  });

  it("handles fractional seconds without nanosecond precision", () => {
    const d = parseAisTimestamp("2026-05-07 18:17:50.5 +0000 UTC");
    expect(d?.toISOString()).toBe("2026-05-07T18:17:50.500Z");
  });

  it("handles no fractional seconds", () => {
    const d = parseAisTimestamp("2026-05-07 18:17:50 +0000 UTC");
    expect(d?.toISOString()).toBe("2026-05-07T18:17:50.000Z");
  });

  it("returns null for non-matching strings", () => {
    expect(parseAisTimestamp("not a timestamp")).toBeNull();
    expect(parseAisTimestamp("2026-05-07T18:17:50Z")).toBeNull(); // ISO 8601, not AISStream format
    expect(parseAisTimestamp("")).toBeNull();
  });
});
