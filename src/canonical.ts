/**
 * Canonical extractors — turn a raw `AisEnvelope` into a clean, sentinel-
 * normalized record suitable for application code or persistence.
 *
 * The output shapes (`PositionFix`, `VesselStatic`) are AIS-domain-natural
 * but not AISStream-specific: they hide all wire-format quirks. Use these
 * if you want clean data; use the raw envelope types if you need full
 * fidelity to the wire format.
 */

import type { AisEnvelope } from "./envelope";
import {
  dimToLengthBeamM,
  isValidPosition,
  normalizeCog,
  normalizeHeading,
  normalizeSog,
  trimAisString,
} from "./normalize";

/**
 * A vessel position fix in canonical form. Covers Class A `PositionReport`,
 * Class B `StandardClassBPositionReport`, and Class B `ExtendedClassBPositionReport`.
 *
 * Fields that AIS reported as "not available" (sentinel values) come back
 * as `null`, never as the raw sentinel numbers (102.3 / 360 / 511 / etc.).
 *
 * `navStatus` is `null` for Class B reports — Class B does not broadcast
 * NavigationalStatus, even though Class A does.
 */
export type PositionFix = {
  mmsi: number;
  ts: Date;
  lat: number;
  lon: number;
  /** Speed over ground (knots). `null` if AIS reported "not available". */
  sog: number | null;
  /** Course over ground (degrees true). `null` if AIS reported "not available". */
  cog: number | null;
  /** True heading (degrees true). `null` if AIS reported "not available". */
  heading: number | null;
  /**
   * ITU-R M.1371 navigational status (integer 0–15). `null` for Class B
   * reports, which do not broadcast this field.
   */
  navStatus: number | null;
};

/**
 * Vessel particulars in canonical form. Covers Class A `ShipStaticData`,
 * Class B `ExtendedClassBPositionReport` (which carries identity inline),
 * and Class B `StaticDataReport` (which arrives in two parts — see note).
 *
 * Class B `StaticDataReport` two-part merge:
 *   - Part A (`PartNumber: false`) carries the vessel's `Name` only.
 *   - Part B (`PartNumber: true`) carries `CallSign`, `Type`, and `Dimension`.
 *
 * Each emit gives you a single part; the parts can arrive minutes apart.
 * Callers that want a complete vessel record need to merge by MMSI over
 * time. This extractor returns whatever fields the single message carried,
 * with the other fields left `undefined`.
 */
export type VesselStatic = {
  mmsi: number;
  /** Timestamp of the source message. */
  ts: Date;
  name: string | undefined;
  callSign: string | undefined;
  imo: number | undefined;
  /** AIS Type code 0–99. See ITU-R M.1371 Table 53 for the meaning of each. */
  typeCode: number | undefined;
  /** Vessel length (meters), derived from `Dimension.A + Dimension.B`. */
  lengthM: number | undefined;
  /** Vessel beam (meters), derived from `Dimension.C + Dimension.D`. */
  beamM: number | undefined;
};

/**
 * Extract a position fix from any of the three position-bearing message
 * types: `PositionReport`, `StandardClassBPositionReport`,
 * `ExtendedClassBPositionReport`.
 *
 * Returns `null` for:
 *   - Non-position message types (caller responsibility to check, but
 *     this is also robust to mistakes).
 *   - Invalid position (lat=91 / lon=181 sentinels or out-of-range values).
 *
 * The `ts` argument is supplied by the caller because AISStream's
 * `MetaData.time_utc` is a custom format — use `parseAisTimestamp` from
 * `normalize.ts` if you want to extract it, or pass `new Date()` for
 * receive-time wall-clock.
 */
export function toPositionFix(env: AisEnvelope, ts: Date): PositionFix | null {
  switch (env.MessageType) {
    case "PositionReport": {
      const m = env.Message.PositionReport;
      if (!m.Valid) return null;
      if (!isValidPosition(m.Latitude, m.Longitude)) return null;
      return {
        mmsi: env.MetaData.MMSI,
        ts,
        lat: m.Latitude,
        lon: m.Longitude,
        sog: normalizeSog(m.Sog),
        cog: normalizeCog(m.Cog),
        heading: normalizeHeading(m.TrueHeading),
        navStatus: m.NavigationalStatus,
      };
    }
    case "StandardClassBPositionReport": {
      const m = env.Message.StandardClassBPositionReport;
      if (!m.Valid) return null;
      if (!isValidPosition(m.Latitude, m.Longitude)) return null;
      return {
        mmsi: env.MetaData.MMSI,
        ts,
        lat: m.Latitude,
        lon: m.Longitude,
        sog: normalizeSog(m.Sog),
        cog: normalizeCog(m.Cog),
        heading: normalizeHeading(m.TrueHeading),
        navStatus: null,
      };
    }
    case "ExtendedClassBPositionReport": {
      const m = env.Message.ExtendedClassBPositionReport;
      if (!m.Valid) return null;
      if (!isValidPosition(m.Latitude, m.Longitude)) return null;
      return {
        mmsi: env.MetaData.MMSI,
        ts,
        lat: m.Latitude,
        lon: m.Longitude,
        sog: normalizeSog(m.Sog),
        cog: normalizeCog(m.Cog),
        heading: normalizeHeading(m.TrueHeading),
        navStatus: null,
      };
    }
    default:
      return null;
  }
}

/**
 * Extract vessel particulars from any static-bearing message type.
 *
 * Handles Class A `ShipStaticData`, Class B `ExtendedClassBPositionReport`
 * (which carries identity inline with position), and Class B
 * `StaticDataReport` (each emit gives you Part A *or* Part B, not both —
 * see `VesselStatic` doc for merge guidance).
 *
 * Returns `null` if the message has no useful static info: position-only
 * messages (`PositionReport`, `StandardClassBPositionReport`), invalid
 * messages (`Valid: false`), or unknown message types.
 */
export function toVesselStatic(env: AisEnvelope, ts: Date): VesselStatic | null {
  switch (env.MessageType) {
    case "ShipStaticData": {
      const m = env.Message.ShipStaticData;
      if (!m.Valid) return null;
      const dims = dimToLengthBeamM(m.Dimension);
      return {
        mmsi: env.MetaData.MMSI,
        ts,
        name: trimAisString(m.Name),
        callSign: trimAisString(m.CallSign),
        imo: m.ImoNumber > 0 ? m.ImoNumber : undefined,
        typeCode: m.Type > 0 ? m.Type : undefined,
        lengthM: dims.lengthM,
        beamM: dims.beamM,
      };
    }
    case "ExtendedClassBPositionReport": {
      const m = env.Message.ExtendedClassBPositionReport;
      if (!m.Valid) return null;
      const dims = dimToLengthBeamM(m.Dimension);
      return {
        mmsi: env.MetaData.MMSI,
        ts,
        name: trimAisString(m.Name),
        callSign: undefined,
        imo: undefined,
        typeCode: m.Type > 0 ? m.Type : undefined,
        lengthM: dims.lengthM,
        beamM: dims.beamM,
      };
    }
    case "StaticDataReport": {
      const m = env.Message.StaticDataReport;
      if (!m.Valid) return null;
      // PartNumber: false = ReportA (Name only); true = ReportB (CallSign,
      // ShipType, Dimension). Each emit carries exactly one part.
      if (!m.PartNumber && m.ReportA.Valid) {
        return {
          mmsi: env.MetaData.MMSI,
          ts,
          name: trimAisString(m.ReportA.Name),
          callSign: undefined,
          imo: undefined,
          typeCode: undefined,
          lengthM: undefined,
          beamM: undefined,
        };
      }
      if (m.PartNumber && m.ReportB.Valid) {
        const dims = dimToLengthBeamM(m.ReportB.Dimension);
        return {
          mmsi: env.MetaData.MMSI,
          ts,
          name: undefined,
          callSign: trimAisString(m.ReportB.CallSign),
          imo: undefined,
          typeCode: m.ReportB.ShipType > 0 ? m.ReportB.ShipType : undefined,
          lengthM: dims.lengthM,
          beamM: dims.beamM,
        };
      }
      return null;
    }
    default:
      return null;
  }
}
