/**
 * Minimal example: connect to AISStream, subscribe to a bounding box,
 * and log every envelope as it arrives.
 *
 * Run:
 *   AISSTREAM_API_KEY=... pnpm tsx examples/01-basic.ts
 */

import { AISStreamClient } from "../src/index";

const apiKey = process.env.AISSTREAM_API_KEY;
if (!apiKey) {
  console.error("Set AISSTREAM_API_KEY in your environment.");
  process.exit(1);
}

const client = new AISStreamClient({
  apiKey,
  // Pacific Northwest. Any non-empty bbox works.
  boundingBoxes: [[[47.0, -125.0], [50.2, -122.0]]],
  onMessage: (env) => {
    console.log(env.MessageType, "MMSI", env.MetaData.MMSI);
  },
  onError: (err) => {
    console.warn("transient error:", err);
  },
});

await client.run();
