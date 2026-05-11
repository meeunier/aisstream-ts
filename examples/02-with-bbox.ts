/**
 * Filter to position reports + static data only, normalize each fix into
 * the canonical `PositionFix` / `VesselStatic` shape, log to stdout.
 *
 * Run:
 *   AISSTREAM_API_KEY=... pnpm tsx examples/02-with-bbox.ts
 */

import {
  AISStreamClient,
  toPositionFix,
  toVesselStatic,
  trimAisString,
} from "../src/index";

const apiKey = process.env.AISSTREAM_API_KEY;
if (!apiKey) {
  console.error("Set AISSTREAM_API_KEY in your environment.");
  process.exit(1);
}

// Active Pass area in the Salish Sea — a high-traffic ferry zone.
const bbox: Array<[[number, number], [number, number]]> = [
  [[48.8, -123.4], [48.95, -123.2]],
];

const client = new AISStreamClient({
  apiKey,
  boundingBoxes: bbox,
  filterMessageTypes: [
    "PositionReport",
    "ShipStaticData",
    "StandardClassBPositionReport",
    "ExtendedClassBPositionReport",
    "StaticDataReport",
  ],
  onMessage: (env) => {
    const now = new Date();

    const fix = toPositionFix(env, now);
    if (fix) {
      const name = trimAisString(env.MetaData.ShipName) ?? `MMSI ${fix.mmsi}`;
      const sog = fix.sog === null ? "—" : `${fix.sog.toFixed(1)} kn`;
      const cog = fix.cog === null ? "—" : `${fix.cog.toFixed(0)}°`;
      console.log(`fix   ${name.padEnd(20)} ${fix.lat.toFixed(4)},${fix.lon.toFixed(4)}  ${sog}  ${cog}`);
      return;
    }

    const stat = toVesselStatic(env, now);
    if (stat) {
      const label = stat.name ?? stat.callSign ?? `MMSI ${stat.mmsi}`;
      const size =
        stat.lengthM !== undefined
          ? ` ${stat.lengthM.toFixed(0)}m × ${stat.beamM?.toFixed(0) ?? "?"}m`
          : "";
      console.log(`static ${label}  type=${stat.typeCode ?? "?"}${size}`);
    }
  },
  onError: (err) => console.warn("[err]", err),
});

await client.run();
