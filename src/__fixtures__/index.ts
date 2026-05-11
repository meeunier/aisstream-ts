/**
 * Test fixture factories — internal, not exported from the package.
 *
 * Each factory returns a realistic envelope with overridable fields, so
 * tests can specify only the values that matter for the assertion and
 * inherit sensible defaults for the rest.
 */

import type {
  AisMetaData,
  Dimension,
  ExtendedClassBPositionReport,
  KnownAisEnvelope,
  PositionReport,
  ShipStaticData,
  StandardClassBPositionReport,
  StaticDataReport,
} from "../envelope";

function defaultMetaData(): AisMetaData {
  return {
    MMSI: 316001267,
    ShipName: "TEST VESSEL    ",
    latitude: 48.69,
    longitude: -123.41,
    time_utc: "2026-05-07 18:17:50.672000000 +0000 UTC",
  };
}

function defaultDimension(): Dimension {
  return { A: 30, B: 30, C: 5, D: 5 };
}

export function makePositionReport(
  overrides: Partial<PositionReport> = {},
  metaOverrides: Partial<AisMetaData> = {},
): Extract<KnownAisEnvelope, { MessageType: "PositionReport" }> {
  const payload: PositionReport = {
    MessageID: 1,
    RepeatIndicator: 0,
    UserID: 316001267,
    Valid: true,
    NavigationalStatus: 0,
    RateOfTurn: 0,
    Sog: 12.3,
    PositionAccuracy: true,
    Longitude: -123.41,
    Latitude: 48.69,
    Cog: 320.5,
    TrueHeading: 320,
    Timestamp: 30,
    SpecialManoeuvreIndicator: 0,
    Spare: 0,
    Raim: false,
    CommunicationState: 0,
    ...overrides,
  };
  return {
    MessageType: "PositionReport",
    MetaData: { ...defaultMetaData(), ...metaOverrides },
    Message: { PositionReport: payload },
  };
}

export function makeStandardClassBPositionReport(
  overrides: Partial<StandardClassBPositionReport> = {},
  metaOverrides: Partial<AisMetaData> = {},
): Extract<KnownAisEnvelope, { MessageType: "StandardClassBPositionReport" }> {
  const payload: StandardClassBPositionReport = {
    MessageID: 18,
    RepeatIndicator: 0,
    UserID: 367000000,
    Valid: true,
    Spare1: 0,
    Sog: 4.5,
    PositionAccuracy: true,
    Longitude: -123.41,
    Latitude: 48.69,
    Cog: 90,
    TrueHeading: 90,
    Timestamp: 30,
    Spare2: 0,
    ClassBUnit: true,
    ClassBDisplay: false,
    ClassBDsc: false,
    ClassBBand: false,
    ClassBMsg22: false,
    AssignedMode: false,
    Raim: false,
    CommunicationStateIsItdma: false,
    CommunicationState: 0,
    ...overrides,
  };
  return {
    MessageType: "StandardClassBPositionReport",
    MetaData: { ...defaultMetaData(), ...metaOverrides },
    Message: { StandardClassBPositionReport: payload },
  };
}

export function makeExtendedClassBPositionReport(
  overrides: Partial<ExtendedClassBPositionReport> = {},
  metaOverrides: Partial<AisMetaData> = {},
): Extract<KnownAisEnvelope, { MessageType: "ExtendedClassBPositionReport" }> {
  const payload: ExtendedClassBPositionReport = {
    MessageID: 19,
    RepeatIndicator: 0,
    UserID: 367000000,
    Valid: true,
    Spare1: 0,
    Sog: 4.5,
    PositionAccuracy: true,
    Longitude: -123.41,
    Latitude: 48.69,
    Cog: 90,
    TrueHeading: 90,
    Timestamp: 30,
    Spare2: 0,
    Name: "PLEASURE CRAFT ",
    Type: 37,
    Dimension: defaultDimension(),
    FixType: 1,
    Raim: false,
    Dte: false,
    AssignedMode: false,
    Spare3: 0,
    ...overrides,
  };
  return {
    MessageType: "ExtendedClassBPositionReport",
    MetaData: { ...defaultMetaData(), ...metaOverrides },
    Message: { ExtendedClassBPositionReport: payload },
  };
}

export function makeShipStaticData(
  overrides: Partial<ShipStaticData> = {},
  metaOverrides: Partial<AisMetaData> = {},
): Extract<KnownAisEnvelope, { MessageType: "ShipStaticData" }> {
  const payload: ShipStaticData = {
    MessageID: 5,
    RepeatIndicator: 0,
    UserID: 316001267,
    Valid: true,
    AisVersion: 0,
    ImoNumber: 9123456,
    CallSign: "VCZL3   ",
    Name: "SKEENA QUEEN    ",
    Type: 60,
    Dimension: { A: 30, B: 30, C: 5, D: 5 },
    FixType: 1,
    Eta: { Month: 5, Day: 7, Hour: 18, Minute: 0 },
    MaximumStaticDraught: 3.5,
    Destination: "FULFORD          ",
    Dte: false,
    Spare: false,
    ...overrides,
  };
  return {
    MessageType: "ShipStaticData",
    MetaData: { ...defaultMetaData(), ...metaOverrides },
    Message: { ShipStaticData: payload },
  };
}

export function makeStaticDataReportPartA(
  nameOverride?: string,
  metaOverrides: Partial<AisMetaData> = {},
): Extract<KnownAisEnvelope, { MessageType: "StaticDataReport" }> {
  const payload: StaticDataReport = {
    MessageID: 24,
    RepeatIndicator: 0,
    UserID: 367000000,
    Valid: true,
    Reserved: 0,
    PartNumber: false,
    ReportA: { Valid: true, Name: nameOverride ?? "S/V GANNET     " },
    ReportB: {
      Valid: false,
      ShipType: 0,
      VendorIDName: "",
      VenderIDModel: 0,
      VenderIDSerial: 0,
      CallSign: "",
      Dimension: { A: 0, B: 0, C: 0, D: 0 },
      FixType: 0,
      Spare: 0,
    },
  };
  return {
    MessageType: "StaticDataReport",
    MetaData: { ...defaultMetaData(), ...metaOverrides },
    Message: { StaticDataReport: payload },
  };
}

export function makeStaticDataReportPartB(
  overrides: { callSign?: string; shipType?: number; dimension?: Dimension } = {},
  metaOverrides: Partial<AisMetaData> = {},
): Extract<KnownAisEnvelope, { MessageType: "StaticDataReport" }> {
  const payload: StaticDataReport = {
    MessageID: 24,
    RepeatIndicator: 0,
    UserID: 367000000,
    Valid: true,
    Reserved: 0,
    PartNumber: true,
    ReportA: { Valid: false, Name: "" },
    ReportB: {
      Valid: true,
      ShipType: overrides.shipType ?? 37,
      VendorIDName: "GARMIN",
      VenderIDModel: 1,
      VenderIDSerial: 12345,
      CallSign: overrides.callSign ?? "VABC123 ",
      Dimension: overrides.dimension ?? defaultDimension(),
      FixType: 1,
      Spare: 0,
    },
  };
  return {
    MessageType: "StaticDataReport",
    MetaData: { ...defaultMetaData(), ...metaOverrides },
    Message: { StaticDataReport: payload },
  };
}
