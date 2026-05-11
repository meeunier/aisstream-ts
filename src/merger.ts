/**
 * Class B two-part static-data merger.
 *
 * AIS Class B static data (message type 24, `StaticDataReport`) is split
 * across two physically separate broadcasts:
 *
 *   - Part A (`PartNumber: false`): vessel `Name` only.
 *   - Part B (`PartNumber: true`):  `CallSign`, `Type`, `Dimension`,
 *                                   vendor info.
 *
 * Both parts share an MMSI but are emitted minutes apart — and either
 * part may arrive first, may be missing entirely (e.g., a Part A whose
 * Part B never follows), or may be retransmitted.
 *
 * `ClassBStaticMerger` ingests `VesselStatic` records (from
 * `toVesselStatic`) one at a time and emits a merged record the moment
 * both halves are available for the same MMSI. Records for Class A
 * `ShipStaticData` and Class B `ExtendedClassBPositionReport` pass
 * through immediately — they're already complete.
 *
 * Memory bounding:
 *   - `pendingTtlMs` caps how long an unmatched half is retained
 *     (default 30 min — Part A/B can legitimately be ~6 min apart but
 *     longer gaps suggest the matching half was never sent).
 *   - `maxPending` caps the absolute number of MMSIs awaiting their
 *     other half (default 10 000). Oldest entries are evicted when
 *     the cap is reached, so a busy bounding box can never grow the
 *     cache without bound.
 */

import type { VesselStatic } from "./canonical";

/**
 * A vessel-static record emitted by the merger.
 *
 * `parts` indicates which AIS broadcasts contributed:
 *   - `"complete"` — both Part A and Part B merged together, OR a single
 *     Class A `ShipStaticData` (which already carries everything), OR
 *     a Class B `ExtendedClassBPositionReport` (identity is inline with
 *     position).
 *   - `"a-only"` — Part A flushed because Part B never arrived within
 *     `pendingTtlMs`. Contains `name` only.
 *   - `"b-only"` — Part B flushed for the same reason. Contains
 *     `callSign`, `typeCode`, dimensions.
 *
 * Most callers care only about `"complete"` records; `"a-only"` and
 * `"b-only"` flushes exist so a slow Part B doesn't strand the Part A
 * in cache forever.
 */
export type MergedVesselStatic = VesselStatic & {
  parts: "complete" | "a-only" | "b-only";
};

export type ClassBStaticMergerConfig = {
  /**
   * Max time to retain a half-record waiting for its other half, in ms.
   * Default 30 min. After this, the half is flushed as a partial record.
   */
  pendingTtlMs?: number;
  /**
   * Max number of MMSIs in the pending-half cache. Default 10 000.
   * When exceeded, the oldest entry is evicted (and not flushed — it
   * is dropped silently, since flushing on eviction would emit partials
   * out of order with respect to TTL).
   */
  maxPending?: number;
  /**
   * Source of "now" for TTL accounting. Defaults to `Date.now`. Override
   * in tests to drive time deterministically.
   */
  now?: () => number;
};

const DEFAULT_PENDING_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_PENDING = 10_000;

type PendingHalf = {
  /** The record's reception timestamp (from `now()`), used for TTL. */
  receivedAt: number;
  /** The half we have so far. */
  record: VesselStatic;
  /** Which half: `"a"` (name) or `"b"` (callSign/typeCode/dimensions). */
  side: "a" | "b";
};

/**
 * Heuristic for which half of a Class B `StaticDataReport` a `VesselStatic`
 * represents. Part A carries `name` and nothing else; Part B carries
 * `callSign` and/or `typeCode` and/or dimensions but no `name`.
 *
 * Returns `null` for records that are not Class B static halves (Class A
 * static, Extended Class B — those are already complete).
 */
function classifyClassBHalf(
  r: VesselStatic,
): "a" | "b" | "complete" | null {
  const hasName = r.name !== undefined;
  const hasB = r.callSign !== undefined || r.typeCode !== undefined ||
               r.lengthM !== undefined || r.beamM !== undefined;
  const hasImo = r.imo !== undefined;
  if (hasImo) return "complete"; // Class A ShipStaticData
  if (hasName && hasB) return "complete"; // ExtendedClassBPositionReport
  if (hasName) return "a";
  if (hasB) return "b";
  return null;
}

/**
 * Merge a Part A and a Part B that share the same MMSI. The `ts` of the
 * merged record is the most recent of the two (the merged record reflects
 * the freshest data we have for the vessel).
 */
function mergeHalves(a: VesselStatic, b: VesselStatic): VesselStatic {
  return {
    mmsi: a.mmsi,
    ts: a.ts.getTime() >= b.ts.getTime() ? a.ts : b.ts,
    name: a.name ?? b.name,
    callSign: a.callSign ?? b.callSign,
    imo: a.imo ?? b.imo,
    typeCode: a.typeCode ?? b.typeCode,
    lengthM: a.lengthM ?? b.lengthM,
    beamM: a.beamM ?? b.beamM,
  };
}

/**
 * Two-part static-data merger for Class B AIS `StaticDataReport` messages.
 *
 * Usage:
 * ```ts
 * const merger = new ClassBStaticMerger();
 * const merged = merger.ingest(toVesselStatic(envelope, ts));
 * if (merged && merged.parts === "complete") { ... }
 * // Periodically flush stale halves:
 * for (const stale of merger.flushExpired()) { ... }
 * ```
 */
export class ClassBStaticMerger {
  private readonly pendingTtlMs: number;
  private readonly maxPending: number;
  private readonly now: () => number;

  /** MMSI → pending half awaiting its partner. */
  private readonly pending = new Map<number, PendingHalf>();

  constructor(config: ClassBStaticMergerConfig = {}) {
    this.pendingTtlMs = config.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
    this.maxPending = config.maxPending ?? DEFAULT_MAX_PENDING;
    this.now = config.now ?? Date.now;
  }

  /**
   * Ingest a `VesselStatic` record. Returns:
   *   - `null` if it's a Class B half and we are still waiting for the
   *     other half.
   *   - A `MergedVesselStatic` with `parts: "complete"` if this call
   *     completes a pair, OR if the input was already complete (Class A
   *     static, or Extended Class B position report).
   *
   * Pass `null` through unchanged — convenient for chaining off of
   * `toVesselStatic(env, ts)` which itself can return `null`.
   */
  ingest(record: VesselStatic | null): MergedVesselStatic | null {
    if (record === null) return null;

    const side = classifyClassBHalf(record);
    if (side === null) return null; // empty record, nothing to do
    if (side === "complete") {
      // Already-complete records pass through immediately. Any pending
      // half for this MMSI stays in cache — the just-passed complete
      // record came from a different message type (Class A static or
      // Extended Class B) and doesn't pair with the StaticDataReport
      // halves we're tracking here.
      return { ...record, parts: "complete" };
    }

    const existing = this.pending.get(record.mmsi);
    if (existing && existing.side !== side) {
      // Pair found — merge and clear the slot.
      this.pending.delete(record.mmsi);
      const a = side === "a" ? record : existing.record;
      const b = side === "b" ? record : existing.record;
      return { ...mergeHalves(a, b), parts: "complete" };
    }

    // No pair yet (or duplicate of same side — newer record wins).
    this.evictIfFull();
    this.pending.set(record.mmsi, {
      receivedAt: this.now(),
      record,
      side,
    });
    return null;
  }

  /**
   * Emit any pending half whose age exceeds `pendingTtlMs`. Call this
   * periodically (e.g., every minute) so partial records don't sit in
   * the cache forever after their matching half failed to arrive.
   *
   * Each emitted record carries `parts: "a-only"` or `"b-only"` so the
   * consumer can decide whether a partial is useful (a Class B with no
   * Name but full dimensions is still better than nothing).
   */
  flushExpired(): MergedVesselStatic[] {
    const cutoff = this.now() - this.pendingTtlMs;
    const out: MergedVesselStatic[] = [];
    for (const [mmsi, half] of this.pending) {
      if (half.receivedAt <= cutoff) {
        this.pending.delete(mmsi);
        out.push({
          ...half.record,
          parts: half.side === "a" ? "a-only" : "b-only",
        });
      }
    }
    return out;
  }

  /** Current number of half-records awaiting their partner. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Drop all pending halves silently. */
  clear(): void {
    this.pending.clear();
  }

  private evictIfFull(): void {
    if (this.pending.size < this.maxPending) return;
    // Map preserves insertion order; the first key is the oldest.
    const oldestKey = this.pending.keys().next().value;
    if (oldestKey !== undefined) {
      this.pending.delete(oldestKey);
    }
  }
}
