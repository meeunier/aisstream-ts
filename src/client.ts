/**
 * AISStream WebSocket client.
 *
 * Holds a persistent WebSocket to AISStream, dispatches incoming envelopes
 * to a caller-supplied `onMessage` handler, and reconnects with exponential
 * backoff when the connection drops.
 *
 * Production-quality behavior:
 *   - Reconnect with backoff: 1 → 2 → 4 → 8 → 16 → 32 → 60 s, capped.
 *   - Healthy-session detection: a session that ran ≥60 s before closing
 *     resets the attempt counter, so a single transient blip after hours
 *     of clean uptime doesn't escalate the backoff.
 *   - Auth errors (server returns `{"error": "..."}`) throw `AISStreamAuthError`
 *     rather than triggering reconnect — retrying with a bad key is futile.
 *   - Frame format-agnostic: handles WebSocket frames delivered as
 *     `string`, `Blob`, or `ArrayBuffer`.
 *
 * Runtime requirements: Node 22+ has a native global `WebSocket`. For
 * Node 20 (or any environment without it), pass a `WebSocketImpl` via the
 * config — `ws.WebSocket` from the `ws` package is the standard choice.
 */

import type { AisEnvelope, KnownAisMessageType } from "./envelope";

/** Default AISStream WebSocket endpoint. */
export const DEFAULT_AISSTREAM_URL = "wss://stream.aisstream.io/v0/stream";

/**
 * Reconnect-backoff schedule, in milliseconds. Caps at the final value.
 * Picked to recover quickly from transient blips while still being polite
 * to AISStream during a sustained outage.
 */
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000] as const;

/** A session that ran at least this long is considered healthy on close. */
const HEALTHY_SESSION_MS = 60_000;

/**
 * Thrown when AISStream rejects the connection with an authentication
 * error. Retrying with the same key won't help, so the client surfaces
 * this rather than silently looping.
 */
export class AISStreamAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AISStreamAuthError";
  }
}

/**
 * A minimal interface that both the global `WebSocket` and `ws.WebSocket`
 * satisfy. Used as the constructor type for `WebSocketImpl`.
 */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(event: "open", listener: () => void): void;
  addEventListener(event: "message", listener: (evt: { data: unknown }) => void): void;
  addEventListener(event: "error", listener: (evt: unknown) => void): void;
  addEventListener(
    event: "close",
    listener: (evt: { code: number; reason: string }) => void,
  ): void;
}

/** Constructor type for any WebSocket implementation. */
export type WebSocketConstructor = new (url: string) => WebSocketLike;

/**
 * Configuration for `AISStreamClient`.
 *
 * `boundingBoxes` is required by AISStream — the server filters its feed
 * to vessels inside the union of the boxes you provide. Each box is an
 * array of two `[lat, lon]` corners: south-west and north-east.
 *
 * `filterMessageTypes` is optional. Provide a subset of AISStream message
 * types (`"PositionReport"`, `"ShipStaticData"`, etc.) to filter at the
 * server. Omit to receive all message types.
 *
 * `onError` is called for transient errors (WebSocket-level errors,
 * malformed JSON payloads, exceptions thrown by your `onMessage` handler).
 * Connection auth errors throw `AISStreamAuthError` from `run()` instead.
 */
export type AISStreamClientConfig = {
  /** AISStream API key. */
  apiKey: string;
  /**
   * AISStream `BoundingBoxes` parameter. Each box is `[[swLat, swLon], [neLat, neLon]]`.
   * Provide one or more; AISStream takes the union.
   */
  boundingBoxes: Array<[[number, number], [number, number]]>;
  /**
   * Optional. Filter to a subset of message types. Omit to receive all.
   * AISStream supports 25+ types — see https://aisstream.io/documentation.
   */
  filterMessageTypes?: ReadonlyArray<KnownAisMessageType | (string & {})>;
  /**
   * Optional. Override the default `wss://stream.aisstream.io/v0/stream`
   * endpoint. Useful for testing against a mock server.
   */
  url?: string;
  /**
   * Optional. WebSocket constructor to use. Defaults to the global
   * `WebSocket`. For Node 20 (no global), pass `ws.WebSocket`.
   */
  WebSocketImpl?: WebSocketConstructor;
  /** Called for every envelope received. Async handlers are awaited. */
  onMessage: (env: AisEnvelope) => void | Promise<void>;
  /** Optional. Called for transient/recoverable errors. */
  onError?: (err: unknown) => void;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function decodeFrame(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data as ArrayBufferView);
  }
  return String(data);
}

/**
 * Persistent AISStream WebSocket client with reconnect-with-backoff.
 *
 * Usage:
 * ```ts
 * const client = new AISStreamClient({
 *   apiKey: process.env.AISSTREAM_API_KEY!,
 *   boundingBoxes: [[[47.0, -125.0], [50.2, -122.0]]],
 *   onMessage: (env) => console.log(env.MessageType, env.MetaData.MMSI),
 * });
 * await client.run();
 * ```
 */
export class AISStreamClient {
  private readonly config: AISStreamClientConfig;
  private readonly url: string;
  private readonly WS: WebSocketConstructor;
  private ws: WebSocketLike | null = null;
  private stopped = false;

  constructor(config: AISStreamClientConfig) {
    this.config = config;
    this.url = config.url ?? DEFAULT_AISSTREAM_URL;
    const ImplFromConfig = config.WebSocketImpl;
    const GlobalWs = (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
    if (ImplFromConfig) {
      this.WS = ImplFromConfig;
    } else if (GlobalWs) {
      this.WS = GlobalWs;
    } else {
      throw new Error(
        "No WebSocket implementation found. On Node < 22, pass `WebSocketImpl: WebSocket` from the `ws` package.",
      );
    }
  }

  /**
   * Run the AISStream session loop. Returns a never-resolving promise that
   * stays alive across reconnects; call `stop()` to terminate cleanly.
   *
   * Throws `AISStreamAuthError` if AISStream rejects the API key — that's
   * not a transient error and retrying won't help.
   */
  async run(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      const startedAt = Date.now();
      const closeReason = await this.openSession();
      if (this.stopped) return;
      const sessionMs = Date.now() - startedAt;

      // Healthy-session detection: a session that ran ≥60 s before closing
      // resets the attempt counter — prevents a single transient blip
      // after hours of clean uptime from escalating the backoff delay.
      if (sessionMs >= HEALTHY_SESSION_MS) {
        attempt = 0;
      } else {
        attempt += 1;
      }

      const idx = Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1);
      const delay = RECONNECT_BACKOFF_MS[idx] ?? 60_000;
      this.config.onError?.(
        new Error(
          `AISStream session ${sessionMs}ms; reconnecting in ${delay}ms (attempt=${attempt}, last close: ${closeReason})`,
        ),
      );
      await sleep(delay);
    }
  }

  /** Stop the run loop after the current session closes. */
  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }

  /**
   * Open one WebSocket session. Resolves with the close reason when the
   * connection ends; throws `AISStreamAuthError` if the server rejects
   * the API key.
   */
  private openSession(): Promise<string> {
    return new Promise((resolve, reject) => {
      const ws = new this.WS(this.url);
      this.ws = ws;

      ws.addEventListener("open", () => {
        const subscription: Record<string, unknown> = {
          Apikey: this.config.apiKey,
          BoundingBoxes: this.config.boundingBoxes,
        };
        if (this.config.filterMessageTypes !== undefined) {
          subscription.FilterMessageTypes = this.config.filterMessageTypes;
        }
        ws.send(JSON.stringify(subscription));
      });

      ws.addEventListener("message", async (evt) => {
        let raw: string;
        try {
          raw = await decodeFrame(evt.data);
        } catch (err) {
          this.config.onError?.(err);
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          this.config.onError?.(new Error(`AISStream: non-JSON payload (${raw.slice(0, 100)})`));
          return;
        }
        // AISStream surfaces auth + subscription errors as `{"error": "..."}`.
        if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
          const msg = String((parsed as { error: unknown }).error);
          ws.close();
          reject(new AISStreamAuthError(`AISStream rejected the connection: ${msg}`));
          return;
        }
        try {
          await this.config.onMessage(parsed as AisEnvelope);
        } catch (err) {
          this.config.onError?.(err);
        }
      });

      ws.addEventListener("error", (e) => {
        this.config.onError?.(e);
      });

      ws.addEventListener("close", (evt) => {
        this.ws = null;
        resolve(`code=${evt.code} reason="${evt.reason}"`);
      });
    });
  }
}
