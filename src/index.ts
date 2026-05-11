/**
 * aisstream-ts — typed TypeScript client for AISStream.io.
 *
 * - Handles WebSocket reconnect with exponential backoff
 * - Normalizes AIS sentinel values (102.3 for SOG, 360 for COG, 511 for heading, etc.)
 * - Merges Class B two-part static-data reports
 * - Provides discriminated-union types for the 5 most-used message types
 *
 * Public API only — implementation details live in the per-file modules.
 */

// --- Envelopes (raw wire-format types) ---
export type {
  AisEnvelope,
  KnownAisEnvelope,
  RawAisEnvelope,
  AisMetaData,
  Dimension,
  PositionReport,
  ShipStaticData,
  StandardClassBPositionReport,
  ExtendedClassBPositionReport,
  StaticDataReport,
  KnownAisMessageType,
} from "./envelope";

export { KNOWN_AIS_MESSAGE_TYPES } from "./envelope";

// --- Normalizers (sentinel handling, string trimming, dimension extraction) ---
export {
  trimAisString,
  normalizeSog,
  normalizeCog,
  normalizeHeading,
  dimToLengthBeamM,
  parseAisTimestamp,
  SOG_NA,
  COG_NA,
  HEADING_NA,
} from "./normalize";

// --- Canonical extractors (envelope → clean record) ---
export type { PositionFix, VesselStatic } from "./canonical";
export { toPositionFix, toVesselStatic } from "./canonical";

// --- WebSocket client ---
export {
  AISStreamClient,
  AISStreamAuthError,
  DEFAULT_AISSTREAM_URL,
} from "./client";
export type {
  AISStreamClientConfig,
  AISStreamClientState,
  WebSocketLike,
  WebSocketConstructor,
} from "./client";

// --- Class B static-data merger ---
export { ClassBStaticMerger } from "./merger";
export type { ClassBStaticMergerConfig, MergedVesselStatic } from "./merger";
