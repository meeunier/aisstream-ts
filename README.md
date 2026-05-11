# aisstream-ts

A small, typed TypeScript client for [AISStream.io](https://aisstream.io).
Connects, subscribes, normalizes the wire-format quirks, reconnects when
the socket drops. Lets you write maritime-data code that handles the AIS
edge cases out of the box.

```bash
pnpm add aisstream-ts
```

```ts
import { AISStreamClient, toPositionFix, trimAisString } from "aisstream-ts";

const client = new AISStreamClient({
  apiKey: process.env.AISSTREAM_API_KEY!,
  boundingBoxes: [[[47.0, -125.0], [50.2, -122.0]]],  // Pacific Northwest
  filterMessageTypes: ["PositionReport", "ShipStaticData"],
  onMessage: (env) => {
    const fix = toPositionFix(env, new Date());
    if (!fix) return;
    const name = trimAisString(env.MetaData.ShipName) ?? `MMSI ${fix.mmsi}`;
    console.log(name, fix.lat, fix.lon, fix.sog, "kn");
  },
});

await client.run();   // Runs forever; reconnects with exponential backoff.
```

## What it is (and what it isn't)

**For**: cloud-side apps consuming the AISStream feed — Telegram bots,
web dashboards, data pipelines, research scripts, alerting systems.
Anything that lives in a Node service and doesn't run a full
[Signal K](https://signalk.org/) server onboard a boat.

**Not for**:
- On-boat data integration (use Signal K — it's the right tool for
  unifying NMEA 0183, NMEA 2000, AIS, and instrument data on a vessel's
  local network).
- Decoding raw NMEA AIVDM sentences from a physical AIS receiver (use
  [`ais-nmea-decoder`](https://www.npmjs.com/package/ais-nmea-decoder)
  or [`ais-stream-decoder`](https://www.npmjs.com/package/ais-stream-decoder)).
- Browser environments. AISStream blocks direct browser WebSocket
  connections per their security policy — server-side only.

Not affiliated with AISStream.io.

## API

The public surface is small enough to fit in a glance:

```ts
import {
  // WebSocket client
  AISStreamClient,           // class
  AISStreamAuthError,        // thrown on bad API key
  DEFAULT_AISSTREAM_URL,     // "wss://stream.aisstream.io/v0/stream"

  // Canonical extractors (envelope → clean record)
  toPositionFix,             // (env, ts) => PositionFix | null
  toVesselStatic,            // (env, ts) => VesselStatic | null

  // Class B two-part static-data merger
  ClassBStaticMerger,        // class — merges Part A + Part B by MMSI

  // Sentinel-aware normalizers
  trimAisString,             // (s) => string | undefined
  normalizeSog,              // (sog) => number | null    (handles 102.3)
  normalizeCog,              // (cog) => number | null    (handles 360)
  normalizeHeading,          // (h) => number | null      (handles 511)
  dimToLengthBeamM,          // (Dimension) => { lengthM, beamM }
  parseAisTimestamp,         // (time_utc) => Date | null

  // Sentinel constants if you want to reference them
  SOG_NA, COG_NA, HEADING_NA,
} from "aisstream-ts";

import type {
  AisEnvelope,               // discriminated union of the 5 known types
  KnownAisEnvelope,          // alias for AisEnvelope
  RawAisEnvelope,            // for unknown message types (cast manually)
  AisMetaData,
  Dimension,
  PositionReport,
  ShipStaticData,
  StandardClassBPositionReport,
  ExtendedClassBPositionReport,
  StaticDataReport,
  PositionFix,               // canonical output of toPositionFix
  VesselStatic,              // canonical output of toVesselStatic
  MergedVesselStatic,        // canonical output of ClassBStaticMerger.ingest
  ClassBStaticMergerConfig,
  AISStreamClientConfig,
  AISStreamClientState,      // "idle" | "connecting" | "open" | "reconnecting" | "stopped"
  WebSocketLike,             // structural type for custom WebSocket impls
  WebSocketConstructor,
} from "aisstream-ts";
```

The client's config:

```ts
type AISStreamClientConfig = {
  apiKey: string;
  boundingBoxes: Array<[[number, number], [number, number]]>;   // [[swLat, swLon], [neLat, neLon]] — validated on construction
  filterMessageTypes?: ReadonlyArray<string>;                   // omit for all
  url?: string;                                                  // override endpoint (e.g. for testing)
  WebSocketImpl?: WebSocketConstructor;                          // for Node < 22
  connectTimeoutMs?: number;                                     // default 30 000
  expectMessageWithinMs?: number;                                // silent-socket watchdog; default off
  onMessage: (env: AisEnvelope) => void | Promise<void>;         // called serially in arrival order
  onError?: (err: unknown) => void;                              // defaults to console.error
};
```

Security: the `apiKey` is included in the subscription frame sent on
each connect. Do not log the config object, the subscription frame, or
the `AISStreamClient` instance — the key will be visible in plain text.

## Why this exists

The AISStream.io documentation gives you the wire format and a hello-world
example. What it doesn't make obvious is a handful of quirks that bite
when you put real code in production. This package encodes them so you
don't re-discover each one through bug-hunting.

### 1. Sentinel values that look like real data

AIS encodes "not available" with magic numbers:

| Field | Sentinel | What it means |
|---|---|---|
| Speed over ground | `102.3` | "speed not available" |
| Course over ground | `360` | "course not available" |
| True heading | `511` | "heading not available" |
| Latitude | `91` | "position not available" |
| Longitude | `181` | "position not available" |

If you take the raw values from AISStream's JSON without normalizing,
you'll see vessels apparently moving at 102.3 knots heading 511°. The
extractors (`toPositionFix`) and the unit normalizers (`normalizeSog` etc.)
all return `null` for these sentinels.

### 2. Class B static data arrives in two parts

`StaticDataReport` (Class B AIS message type 24) is split into two parts
on the wire. Each emit carries exactly one:

- **Part A** (`PartNumber: false`): vessel `Name` only.
- **Part B** (`PartNumber: true`): `CallSign`, `ShipType`, `Dimension`.

The two parts can arrive minutes apart, sometimes interleaved with other
messages, and either may be missing entirely.

`toVesselStatic` returns whatever the single message carried; the
`ClassBStaticMerger` helper takes those single-half records and emits a
merged `MergedVesselStatic` the moment both halves are seen for a given
MMSI. It bounds memory with a per-MMSI TTL (default 30 min) and a hard
cap on the pending-half cache (default 10 000 MMSIs).

```ts
import { AISStreamClient, ClassBStaticMerger, toVesselStatic } from "aisstream-ts";

const merger = new ClassBStaticMerger();

const client = new AISStreamClient({
  // ...
  onMessage: (env) => {
    const merged = merger.ingest(toVesselStatic(env, new Date()));
    if (merged && merged.parts === "complete") {
      // Use merged.name, merged.callSign, merged.typeCode, merged.lengthM, merged.beamM
    }
  },
});

// Periodically flush halves whose partner never arrived:
setInterval(() => {
  for (const partial of merger.flushExpired()) {
    // partial.parts is "a-only" or "b-only" — use if a partial is acceptable.
  }
}, 60_000);
```

### 3. Vessel size is encoded as four offsets

AIS doesn't send length and beam directly. It sends four distances from
the vessel's GNSS antenna reference point:

```
       bow
        |
   A (distance from bow to antenna)
        |
        × ← antenna
        |
   B (distance from stern to antenna)
        |
      stern

  C ← distance from port    D ← distance from starboard
```

Length = `A + B`. Beam = `C + D`. `dimToLengthBeamM` handles this,
including returning `undefined` for "not reported" zero values.

### 4. Reconnect with healthy-session detection

`AISStreamClient` reconnects with exponential backoff (1 → 2 → 4 → 8 →
16 → 32 → 60 s, capped). Critically: a session that ran for at least 60
seconds before closing resets the attempt counter. Without this, a
single transient blip after hours of clean uptime would escalate the
backoff and slow recovery from later glitches. With it, the client
recovers quickly from production-normal disconnects.

### 5. Auth errors are distinct from transient errors

AISStream surfaces invalid API keys and quota errors as
`{"error": "..."}` JSON on the WebSocket. The client throws
`AISStreamAuthError` for these — retrying with the same key won't help,
so the run loop terminates rather than burning quota on doomed reconnects.

```ts
try {
  await client.run();
} catch (err) {
  if (err instanceof AISStreamAuthError) {
    // bad key, log it and stop
  } else {
    throw err;
  }
}
```

## Discriminated-union message handling

`AisEnvelope` is a discriminated union of the five fully-typed message
types. A `switch (env.MessageType)` narrows each branch:

```ts
import type { AisEnvelope } from "aisstream-ts";

function handle(env: AisEnvelope) {
  switch (env.MessageType) {
    case "PositionReport":
      // env.Message.PositionReport is fully typed PositionReport here
      console.log(env.Message.PositionReport.Sog);
      break;
    case "ShipStaticData":
      // env.Message.ShipStaticData is fully typed ShipStaticData here
      console.log(env.Message.ShipStaticData.Name.trim());
      break;
    case "StandardClassBPositionReport":
    case "ExtendedClassBPositionReport":
    case "StaticDataReport":
      // handle each as needed
      break;
  }
}
```

For AISStream message types the package doesn't fully type
(`AidsToNavigationReport`, `BaseStationReport`, `SafetyBroadcastMessage`,
etc.), cast the raw parsed message to `RawAisEnvelope` and read fields
manually, or set `filterMessageTypes` to receive only the typed ones.

## Node compatibility

Node 22+ has a native global `WebSocket`. For Node 20:

```bash
pnpm add ws
```

```ts
import { WebSocket } from "ws";
import { AISStreamClient } from "aisstream-ts";

const client = new AISStreamClient({
  // ...
  WebSocketImpl: WebSocket as never,   // satisfies WebSocketConstructor
});
```

## What's deliberately not included

By design, the package stays focused on "consume AISStream cleanly":

- No CPA / TCPA math
- No voyage segmentation, terminal discovery, or other analytical primitives
- No NMEA 0183 decoding
- No Signal K integration
- No MMSI country lookup or AIS-Type-code → label table
- No subscription updates after connection (would require a runtime API
  AISStream supports but is rarely needed)
- No schema validation library (envelopes are typed, not runtime-validated)

These are different problems with different scopes; pulling them in
would bloat the package without sharpening it.

## License

[MIT](./LICENSE) © 2026 Antoine Meunier
