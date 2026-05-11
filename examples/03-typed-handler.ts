/**
 * Typed handler using a discriminated-union `switch` on `MessageType`.
 * Each branch narrows the envelope to the corresponding message-specific
 * payload type, so you get full TS autocomplete and field-level type safety.
 *
 * Run:
 *   AISSTREAM_API_KEY=... pnpm tsx examples/03-typed-handler.ts
 */

import { AISStreamClient, trimAisString } from "../src/index";

const apiKey = process.env.AISSTREAM_API_KEY;
if (!apiKey) {
  console.error("Set AISSTREAM_API_KEY in your environment.");
  process.exit(1);
}

const client = new AISStreamClient({
  apiKey,
  boundingBoxes: [[[47.0, -125.0], [50.2, -122.0]]],
  onMessage: (env) => {
    switch (env.MessageType) {
      case "PositionReport": {
        // env.Message.PositionReport is typed PositionReport here.
        const m = env.Message.PositionReport;
        console.log(`PR    MMSI=${m.UserID} nav=${m.NavigationalStatus} sog=${m.Sog}`);
        break;
      }
      case "ShipStaticData": {
        const m = env.Message.ShipStaticData;
        console.log(
          `STAT  ${trimAisString(m.Name)} (${trimAisString(m.CallSign)}) type=${m.Type} dim=${m.Dimension.A + m.Dimension.B}m`,
        );
        break;
      }
      case "StandardClassBPositionReport": {
        const m = env.Message.StandardClassBPositionReport;
        console.log(`PR-B  MMSI=${m.UserID} sog=${m.Sog}`);
        break;
      }
      case "ExtendedClassBPositionReport": {
        const m = env.Message.ExtendedClassBPositionReport;
        console.log(`PR-Bx ${trimAisString(m.Name)} type=${m.Type}`);
        break;
      }
      case "StaticDataReport": {
        const m = env.Message.StaticDataReport;
        if (!m.PartNumber && m.ReportA.Valid) {
          console.log(`SDR-A ${trimAisString(m.ReportA.Name)}`);
        } else if (m.PartNumber && m.ReportB.Valid) {
          console.log(`SDR-B ${trimAisString(m.ReportB.CallSign)} type=${m.ReportB.ShipType}`);
        }
        break;
      }
    }
  },
});

await client.run();
