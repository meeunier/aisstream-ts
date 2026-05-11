import { describe, expect, it } from "vitest";

import { ClassBStaticMerger } from "./merger";
import { toVesselStatic } from "./canonical";
import {
  makeExtendedClassBPositionReport,
  makeShipStaticData,
  makeStaticDataReportPartA,
  makeStaticDataReportPartB,
} from "./__fixtures__/index";

const TS = new Date("2026-05-07T18:17:50Z");

function partA(mmsi: number, name: string) {
  return toVesselStatic(makeStaticDataReportPartA(name, { MMSI: mmsi }), TS);
}

function partB(mmsi: number, callSign: string, shipType = 37) {
  return toVesselStatic(
    makeStaticDataReportPartB(
      { callSign, shipType, dimension: { A: 6, B: 6, C: 1.5, D: 1.5 } },
      { MMSI: mmsi },
    ),
    TS,
  );
}

describe("ClassBStaticMerger — basic pairing", () => {
  it("returns null on first half, complete on second half (A then B)", () => {
    const m = new ClassBStaticMerger();
    expect(m.ingest(partA(123, "GANNET    "))).toBeNull();
    expect(m.pendingCount).toBe(1);
    const merged = m.ingest(partB(123, "VABC123 "));
    expect(merged?.parts).toBe("complete");
    expect(merged?.name).toBe("GANNET");
    expect(merged?.callSign).toBe("VABC123");
    expect(merged?.lengthM).toBe(12);
    expect(m.pendingCount).toBe(0);
  });

  it("merges in either arrival order (B then A)", () => {
    const m = new ClassBStaticMerger();
    expect(m.ingest(partB(456, "VXYZ555 "))).toBeNull();
    const merged = m.ingest(partA(456, "BLUE HERON     "));
    expect(merged?.parts).toBe("complete");
    expect(merged?.name).toBe("BLUE HERON");
    expect(merged?.callSign).toBe("VXYZ555");
    expect(merged?.typeCode).toBe(37);
  });

  it("does not cross MMSIs", () => {
    const m = new ClassBStaticMerger();
    m.ingest(partA(111, "ONE       "));
    expect(m.ingest(partB(222, "VTWO222 "))).toBeNull();
    expect(m.pendingCount).toBe(2);
  });
});

describe("ClassBStaticMerger — pass-through for already-complete records", () => {
  it("passes Class A ShipStaticData through immediately as complete", () => {
    const m = new ClassBStaticMerger();
    const result = m.ingest(toVesselStatic(makeShipStaticData(), TS));
    expect(result?.parts).toBe("complete");
    expect(result?.imo).toBe(9123456);
    expect(m.pendingCount).toBe(0);
  });

  it("passes ExtendedClassBPositionReport through immediately as complete", () => {
    const m = new ClassBStaticMerger();
    const result = m.ingest(toVesselStatic(makeExtendedClassBPositionReport(), TS));
    expect(result?.parts).toBe("complete");
    expect(result?.name).toBe("PLEASURE CRAFT");
    expect(result?.typeCode).toBe(37);
    expect(m.pendingCount).toBe(0);
  });
});

describe("ClassBStaticMerger — duplicate halves", () => {
  it("replaces a pending half with a newer same-side update", () => {
    const m = new ClassBStaticMerger();
    m.ingest(partA(123, "OLD NAME      "));
    m.ingest(partA(123, "NEW NAME      "));
    expect(m.pendingCount).toBe(1);
    const merged = m.ingest(partB(123, "VAAA111 "));
    expect(merged?.name).toBe("NEW NAME");
  });
});

describe("ClassBStaticMerger — TTL flush", () => {
  it("flushes a-only half after pendingTtlMs", () => {
    let now = 1_000_000;
    const m = new ClassBStaticMerger({ pendingTtlMs: 60_000, now: () => now });

    m.ingest(partA(123, "STRANDED A     "));
    now += 30_000;
    expect(m.flushExpired()).toHaveLength(0);

    now += 31_000; // total 61s — past TTL
    const flushed = m.flushExpired();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.parts).toBe("a-only");
    expect(flushed[0]?.name).toBe("STRANDED A");
    expect(m.pendingCount).toBe(0);
  });

  it("flushes b-only half after pendingTtlMs", () => {
    let now = 1_000_000;
    const m = new ClassBStaticMerger({ pendingTtlMs: 60_000, now: () => now });

    m.ingest(partB(456, "VLOST22 "));
    now += 61_000;
    const flushed = m.flushExpired();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.parts).toBe("b-only");
    expect(flushed[0]?.callSign).toBe("VLOST22");
  });

  it("does not flush halves that have already merged", () => {
    let now = 1_000_000;
    const m = new ClassBStaticMerger({ pendingTtlMs: 60_000, now: () => now });

    m.ingest(partA(123, "OK            "));
    m.ingest(partB(123, "VOK1234 "));
    now += 1_000_000;
    expect(m.flushExpired()).toHaveLength(0);
  });
});

describe("ClassBStaticMerger — bounded memory", () => {
  it("evicts oldest pending half when maxPending is reached", () => {
    const m = new ClassBStaticMerger({ maxPending: 2 });
    m.ingest(partA(1, "FIRST         "));
    m.ingest(partA(2, "SECOND        "));
    m.ingest(partA(3, "THIRD         ")); // evicts MMSI=1 to make room
    expect(m.pendingCount).toBe(2);

    // MMSI=1's Part A was evicted; its Part B arrives but finds nothing to pair with.
    expect(m.ingest(partB(1, "VONE111 "))).toBeNull();
    // Inserting MMSI=1's B evicts the next-oldest (MMSI=2) to stay at the cap.
    expect(m.pendingCount).toBe(2);
  });
});

describe("ClassBStaticMerger — null and empty inputs", () => {
  it("passes null through unchanged", () => {
    const m = new ClassBStaticMerger();
    expect(m.ingest(null)).toBeNull();
  });
});
