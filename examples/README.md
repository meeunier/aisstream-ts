# Examples

Three runnable examples showing increasing levels of typing detail.

## Setup

```bash
# From the repo root:
pnpm install
export AISSTREAM_API_KEY=your-key-here   # https://aisstream.io/apikeys
```

You'll need a free [AISStream.io](https://aisstream.io) account for the API key.

## Run

```bash
pnpm exec tsx examples/01-basic.ts            # connect + log MessageType + MMSI
pnpm exec tsx examples/02-with-bbox.ts        # canonical normalization, Active Pass
pnpm exec tsx examples/03-typed-handler.ts    # discriminated-union switch handling
```

Each example runs until you Ctrl-C it. With a healthy AIS feed for the
chosen bounding box, you should see envelopes within seconds.

## What each one shows

- **`01-basic.ts`** — the smallest useful program. Subscribe to a bounding
  box, log every envelope as it arrives. ~15 LOC.
- **`02-with-bbox.ts`** — filter the subscription to position + static
  message types, normalize with `toPositionFix` / `toVesselStatic`, print
  formatted lines. Demonstrates the value-add over raw envelopes.
- **`03-typed-handler.ts`** — typed `switch (env.MessageType)` so each
  branch narrows the envelope to a specific message-payload type, giving
  full TS autocomplete and compile-time field checks.

## Notes

- All three handle Ctrl-C cleanly via the default Node signal flow; for a
  long-running deployment, wrap `client.run()` in your own signal handler
  and call `client.stop()` for graceful shutdown.
- For Node 20 (no global `WebSocket`), add `pnpm add ws` and pass
  `WebSocketImpl: WebSocket` from `ws` to the client config.
