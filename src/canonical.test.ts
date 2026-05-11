import { describe, expect, it } from "vitest";

import { toPositionFix, toVesselStatic } from "./canonical";
import {
  makeExtendedClassBPositionReport,
  makePositionReport,
  makeShipStaticData,
  makeStandardClassBPositionReport,
  makeStaticDataReportPartA,
  makeStaticDataReportPartB,
} from "./__fixtures__/index";

const TS = new Date("2026-05-07T18:17:50Z");

describe("toPositionFix — Class A PositionReport", () => {
  it("extracts a clean fix with all fields", () => {
    const env = makePositionReport({ Sog: 12.3, Cog: 320.5, TrueHeading: 320 });
    const fix = toPositionFix(env, TS);
    expect(fix).not.toBeNull();
    expect(fix?.lat).toBe(48.69);
    expect(fix?.lon).toBe(-123.41);
    expect(fix?.sog).toBe(12.3);
    expect(fix?.cog).toBe(320.5);
    expect(fix?.heading).toBe(320);
  });

  it("normalizes all sentinel values to null", () => {
    const env = makePositionReport({
      Sog: 102.3,
      Cog: 360,
      TrueHeading: 511,
    });
    const fix = toPositionFix(env, TS);
    expect(fix?.sog).toBeNull();
    expect(fix?.cog).toBeNull();
    expect(fix?.heading).toBeNull();
  });

  it("preserves NavigationalStatus from Class A", () => {
    const env = makePositionReport({ NavigationalStatus: 5 }); // 5 = moored
    expect(toPositionFix(env, TS)?.navStatus).toBe(5);
  });

  it("returns null for invalid position (lat=91, lon=181 sentinels)", () => {
    const env = makePositionReport({ Latitude: 91, Longitude: 181 });
    expect(toPositionFix(env, TS)).toBeNull();
  });

  it("returns null when Valid is false", () => {
    const env = makePositionReport({ Valid: false });
    expect(toPositionFix(env, TS)).toBeNull();
  });

  it("uses the caller-supplied timestamp", () => {
    const env = makePositionReport();
    const customTs = new Date("2024-01-01T00:00:00Z");
    expect(toPositionFix(env, customTs)?.ts).toBe(customTs);
  });
});

describe("toPositionFix — Class B reports", () => {
  it("StandardClassBPositionReport: navStatus is null (Class B doesn't broadcast it)", () => {
    const env = makeStandardClassBPositionReport({ Sog: 4.5 });
    const fix = toPositionFix(env, TS);
    expect(fix?.navStatus).toBeNull();
    expect(fix?.sog).toBe(4.5);
  });

  it("StandardClassBPositionReport: returns null when Valid is false", () => {
    const env = makeStandardClassBPositionReport({ Valid: false });
    expect(toPositionFix(env, TS)).toBeNull();
  });

  it("ExtendedClassBPositionReport: navStatus is null (Class B doesn't broadcast it)", () => {
    const env = makeExtendedClassBPositionReport({ Sog: 5.5 });
    const fix = toPositionFix(env, TS);
    expect(fix?.navStatus).toBeNull();
    expect(fix?.sog).toBe(5.5);
  });

  it("ExtendedClassBPositionReport: returns null when Valid is false", () => {
    const env = makeExtendedClassBPositionReport({ Valid: false });
    expect(toPositionFix(env, TS)).toBeNull();
  });
});

describe("toPositionFix — non-position messages", () => {
  it("returns null for ShipStaticData", () => {
    const env = makeShipStaticData();
    expect(toPositionFix(env, TS)).toBeNull();
  });

  it("returns null for StaticDataReport", () => {
    const env = makeStaticDataReportPartA();
    expect(toPositionFix(env, TS)).toBeNull();
  });
});

describe("toVesselStatic — Class A ShipStaticData", () => {
  it("extracts name, callSign, IMO, type, dimensions", () => {
    const env = makeShipStaticData({
      Name: "SKEENA QUEEN    ",
      CallSign: "VCZL3   ",
      ImoNumber: 9123456,
      Type: 60,
      Dimension: { A: 30, B: 30, C: 5, D: 5 },
    });
    const v = toVesselStatic(env, TS);
    expect(v?.name).toBe("SKEENA QUEEN");
    expect(v?.callSign).toBe("VCZL3");
    expect(v?.imo).toBe(9123456);
    expect(v?.typeCode).toBe(60);
    expect(v?.lengthM).toBe(60);
    expect(v?.beamM).toBe(10);
  });

  it("returns null for Valid: false", () => {
    const env = makeShipStaticData({ Valid: false });
    expect(toVesselStatic(env, TS)).toBeNull();
  });

  it("returns undefined for missing IMO (ImoNumber = 0)", () => {
    const env = makeShipStaticData({ ImoNumber: 0 });
    expect(toVesselStatic(env, TS)?.imo).toBeUndefined();
  });
});

describe("toVesselStatic — Class B two-part StaticDataReport", () => {
  it("Part A: gives Name only, leaves callSign/type/dimensions undefined", () => {
    const env = makeStaticDataReportPartA("S/V GANNET     ");
    const v = toVesselStatic(env, TS);
    expect(v?.name).toBe("S/V GANNET");
    expect(v?.callSign).toBeUndefined();
    expect(v?.typeCode).toBeUndefined();
    expect(v?.lengthM).toBeUndefined();
    expect(v?.beamM).toBeUndefined();
  });

  it("Part B: gives callSign + ShipType + Dimension, leaves Name undefined", () => {
    const env = makeStaticDataReportPartB({
      callSign: "VABC123 ",
      shipType: 37, // pleasure craft
      dimension: { A: 6, B: 6, C: 1.5, D: 1.5 },
    });
    const v = toVesselStatic(env, TS);
    expect(v?.name).toBeUndefined();
    expect(v?.callSign).toBe("VABC123");
    expect(v?.typeCode).toBe(37);
    expect(v?.lengthM).toBe(12);
    expect(v?.beamM).toBe(3);
  });
});

describe("toVesselStatic — ExtendedClassBPositionReport (identity inline)", () => {
  it("extracts name, type, dimensions but not callSign (not in this message type)", () => {
    const env = makeExtendedClassBPositionReport({
      Name: "PLEASURE CRAFT ",
      Type: 37,
      Dimension: { A: 8, B: 4, C: 2, D: 2 },
    });
    const v = toVesselStatic(env, TS);
    expect(v?.name).toBe("PLEASURE CRAFT");
    expect(v?.typeCode).toBe(37);
    expect(v?.callSign).toBeUndefined();
    expect(v?.lengthM).toBe(12);
    expect(v?.beamM).toBe(4);
  });
});

describe("toVesselStatic — non-static messages", () => {
  it("returns null for PositionReport", () => {
    const env = makePositionReport();
    expect(toVesselStatic(env, TS)).toBeNull();
  });

  it("returns null for StandardClassBPositionReport (no identity inline)", () => {
    const env = makeStandardClassBPositionReport();
    expect(toVesselStatic(env, TS)).toBeNull();
  });
});
