/**
 * AISStream wire-format message envelopes.
 *
 * AISStream sends JSON over WebSocket. Each message is an envelope with
 * `MessageType` (discriminant), `MetaData` (consistent across all types),
 * and `Message` (the actual payload, nested under a key matching the type).
 *
 * Field names mirror the wire format exactly (PascalCase, AIS sentinel
 * values intact). Use `toPositionFix` / `toVesselStatic` from canonical.ts
 * to get clean canonical records with sentinel normalization applied.
 *
 * Reference: https://github.com/aisstream/ais-message-models
 *            https://aisstream.io/documentation
 */

/**
 * Common envelope metadata, present on every AISStream message regardless
 * of MessageType. ShipName + lat/lon here are duplicated from the inner
 * Message body for convenience; trust the inner body for canonical values.
 */
export type AisMetaData = {
  MMSI: number;
  /** Space-padded fixed-width string in the wire format — call `trimAisString` before use. */
  ShipName?: string;
  latitude: number;
  longitude: number;
  /**
   * AISStream's timestamp string. Format example:
   *   `"2026-05-05 23:52:50.801045713 +0000 UTC"`
   * Use `parseAisTimestamp` from `normalize.ts` to convert to a Date.
   */
  time_utc: string;
};

/**
 * AIS vessel-dimension structure. The four values are offsets from the
 * vessel's reference point (typically the GNSS antenna):
 *   A = distance from bow
 *   B = distance from stern
 *   C = distance from port side
 *   D = distance from starboard side
 *
 * Length = A + B (meters). Beam = C + D (meters). See `dimToLengthBeamM`.
 */
export type Dimension = { A: number; B: number; C: number; D: number };

// --- Class A (commercial: ferries, cargo, tankers, tugs, fishing) ---------

/** Class A position report (AIS message type 1, 2, or 3). */
export type PositionReport = {
  MessageID: number;
  RepeatIndicator: number;
  UserID: number;
  Valid: boolean;
  /** ITU-R M.1371 navigational status, integer 0–15. */
  NavigationalStatus: number;
  RateOfTurn: number;
  /** Speed over ground, knots. Sentinel: 102.3 = not available. */
  Sog: number;
  PositionAccuracy: boolean;
  Longitude: number;
  Latitude: number;
  /** Course over ground, degrees true. Sentinel: 360 = not available. */
  Cog: number;
  /** True heading, degrees true. Sentinel: 511 = not available. */
  TrueHeading: number;
  Timestamp: number;
  SpecialManoeuvreIndicator: number;
  Spare: number;
  Raim: boolean;
  CommunicationState: number;
};

/** Class A static / voyage-related data (AIS message type 5). */
export type ShipStaticData = {
  MessageID: number;
  RepeatIndicator: number;
  UserID: number;
  Valid: boolean;
  AisVersion: number;
  ImoNumber: number;
  /** Space-padded fixed-width — trim before use. */
  CallSign: string;
  /** Space-padded fixed-width — trim before use. */
  Name: string;
  /** AIS Type code 0–99. See ITU-R M.1371 Table 53 for the meaning of each. */
  Type: number;
  Dimension: Dimension;
  FixType: number;
  /** Estimated time of arrival. Year is intentionally omitted by the AIS spec. */
  Eta: { Month: number; Day: number; Hour: number; Minute: number };
  /** Maximum static draught, meters. */
  MaximumStaticDraught: number;
  /** Space-padded fixed-width — trim before use. */
  Destination: string;
  Dte: boolean;
  Spare: boolean;
};

// --- Class B (most pleasure craft: sailboats, motor yachts) ---------------

/**
 * Class B standard position report (AIS message type 18).
 * Class B does NOT broadcast NavigationalStatus.
 */
export type StandardClassBPositionReport = {
  MessageID: number;
  RepeatIndicator: number;
  UserID: number;
  Valid: boolean;
  Spare1: number;
  Sog: number;
  PositionAccuracy: boolean;
  Longitude: number;
  Latitude: number;
  Cog: number;
  TrueHeading: number;
  Timestamp: number;
  Spare2: number;
  ClassBUnit: boolean;
  ClassBDisplay: boolean;
  ClassBDsc: boolean;
  ClassBBand: boolean;
  ClassBMsg22: boolean;
  AssignedMode: boolean;
  Raim: boolean;
  CommunicationStateIsItdma: boolean;
  CommunicationState: number;
};

/**
 * Class B extended position report (AIS message type 19).
 * Includes Name, Type, Dimension alongside position. Rare in practice.
 */
export type ExtendedClassBPositionReport = {
  MessageID: number;
  RepeatIndicator: number;
  UserID: number;
  Valid: boolean;
  Spare1: number;
  Sog: number;
  PositionAccuracy: boolean;
  Longitude: number;
  Latitude: number;
  Cog: number;
  TrueHeading: number;
  Timestamp: number;
  Spare2: number;
  /** Space-padded fixed-width — trim before use. */
  Name: string;
  Type: number;
  Dimension: Dimension;
  FixType: number;
  Raim: boolean;
  Dte: boolean;
  AssignedMode: boolean;
  Spare3: number;
};

/**
 * Class B static data report (AIS message type 24). Comes in two parts:
 *   - Part A (`PartNumber: false`): vessel Name only.
 *   - Part B (`PartNumber: true`): CallSign, ShipType, Dimension, etc.
 *
 * Each emit carries exactly one part. The two parts typically arrive
 * minutes apart. A consumer building a complete vessel record needs to
 * merge them by MMSI (the `UserID` field) across messages. See
 * `toVesselStatic` for a normalized one-side-at-a-time extractor.
 */
export type StaticDataReport = {
  MessageID: number;
  RepeatIndicator: number;
  UserID: number;
  Valid: boolean;
  Reserved: number;
  /** `false` = Part A (Name only). `true` = Part B (CallSign, ShipType, Dimension). */
  PartNumber: boolean;
  ReportA: { Valid: boolean; Name: string };
  ReportB: {
    Valid: boolean;
    ShipType: number;
    VendorIDName: string;
    VenderIDModel: number;
    VenderIDSerial: number;
    CallSign: string;
    Dimension: Dimension;
    FixType: number;
    Spare: number;
  };
};

// --- Envelope discriminated union -----------------------------------------

/** Envelope for any AISStream message we have explicit type definitions for. */
export type KnownAisEnvelope =
  | {
      MessageType: "PositionReport";
      MetaData: AisMetaData;
      Message: { PositionReport: PositionReport };
    }
  | {
      MessageType: "StandardClassBPositionReport";
      MetaData: AisMetaData;
      Message: { StandardClassBPositionReport: StandardClassBPositionReport };
    }
  | {
      MessageType: "ExtendedClassBPositionReport";
      MetaData: AisMetaData;
      Message: { ExtendedClassBPositionReport: ExtendedClassBPositionReport };
    }
  | {
      MessageType: "ShipStaticData";
      MetaData: AisMetaData;
      Message: { ShipStaticData: ShipStaticData };
    }
  | {
      MessageType: "StaticDataReport";
      MetaData: AisMetaData;
      Message: { StaticDataReport: StaticDataReport };
    };

/**
 * Generic envelope shape covering AISStream message types we don't fully
 * type (AidsToNavigationReport, SafetyBroadcastMessage, BaseStationReport,
 * etc., 20+ in total). Not part of the `AisEnvelope` union — including it
 * there would break discriminated-union narrowing on the known variants.
 *
 * If you want to handle these, cast the raw parsed JSON to this type and
 * read fields manually. Most callers should set `filterMessageTypes` in
 * `AISStreamClientConfig` to receive only known types.
 */
export type RawAisEnvelope = {
  MessageType: string;
  MetaData: AisMetaData;
  Message: Record<string, unknown>;
};

/**
 * Any AISStream message we have explicit types for. Use a
 * `switch (env.MessageType) { ... }` for type-narrowed handling on each
 * known variant.
 */
export type AisEnvelope = KnownAisEnvelope;

/** Names of the fully-typed `MessageType` values supported by this package. */
export const KNOWN_AIS_MESSAGE_TYPES = [
  "PositionReport",
  "ShipStaticData",
  "StandardClassBPositionReport",
  "ExtendedClassBPositionReport",
  "StaticDataReport",
] as const;

export type KnownAisMessageType = (typeof KNOWN_AIS_MESSAGE_TYPES)[number];
