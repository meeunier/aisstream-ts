/**
 * AISStream WebSocket client.
 *
 * Holds a persistent WebSocket to AISStream, dispatches incoming envelopes
 * to a caller-supplied `onMessage` handler, and reconnects with exponential
 * backoff when the connection drops.
 *
 * Production-quality behavior:
 *   - Reconnect with backoff: 1 → 2 → 4 → 8 → 16 → 32 → 60 s, capped.
 *   - Healthy-session detection: a session that ran ≥60 s post-`open` before
 *     closing resets the attempt counter, so a single transient blip after
 *     hours of clean uptime doesn't escalate the backoff.
 *   - Connect timeout: if the WebSocket never reaches `open`, force-close
 *     and reconnect via the normal backoff path.
 *   - Auth errors (server returns `{"error": "..."}`) throw `AISStreamAuthError`
 *     rather than triggering reconnect — retrying with a bad key is futile.
 *   - Optional silent-socket watchdog: when `expectMessageWithinMs` is set,
 *     a session that goes quiet beyond that window is force-closed (the
 *     underlying WebSocket can stay open against a dead NAT/cellular link
 *     without producing a `close` event).
 *   - Cancellable backoff: `stop()` interrupts an in-flight reconnect sleep
 *     so the run loop exits promptly.
 *   - Frame format-agnostic: handles WebSocket frames delivered as
 *     `string`, `Blob`, `ArrayBuffer`, or `ArrayBufferView`.
 *   - Serial `onMessage` dispatch: messages are awaited in arrival order, so
 *     stateful consumers see a deterministic stream.
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

/** A session that ran at least this long post-`open` is considered healthy on close. */
const HEALTHY_SESSION_MS = 60_000;

/** Default connect timeout — if `open` doesn't fire by this point, give up and reconnect. */
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

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

/** Public connection state. */
export type AISStreamClientState =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "stopped";

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
 * If omitted, transient errors are logged via `console.error` so they
 * are never silently swallowed.
 *
 * Security: the `apiKey` is embedded in the subscription frame sent on
 * each open. Do not log this config object, the subscription frame, or
 * the client instance — the key will be visible in plain text.
 */
export type AISStreamClientConfig = {
  /** AISStream API key. */
  apiKey: string;
  /**
   * AISStream `BoundingBoxes` parameter. Each box is `[[swLat, swLon], [neLat, neLon]]`.
   * Provide one or more; AISStream takes the union. Validated on
   * construction — invalid input throws synchronously.
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
  /**
   * Optional. Max time to wait for the WebSocket to reach `open` before
   * giving up and reconnecting. Default 30 000 ms.
   */
  connectTimeoutMs?: number;
  /**
   * Optional. Silent-socket watchdog. If set, a session that receives no
   * messages for this many milliseconds is force-closed (the underlying
   * WebSocket can stay open behind a dead NAT/cellular link without firing
   * `close`). Choose a value larger than the typical message gap in your
   * bounding box — empty mid-ocean boxes will see long silences naturally.
   * Default: disabled.
   */
  expectMessageWithinMs?: number;
  /**
   * Called for every envelope received. Async handlers are awaited
   * serially in arrival order, so stateful consumers see a deterministic
   * stream. A slow handler will produce back-pressure on the WebSocket
   * pump (messages keep queueing in memory) — keep it fast or move heavy
   * work off the hot path.
   */
  onMessage: (env: AisEnvelope) => void | Promise<void>;
  /**
   * Optional. Called for transient/recoverable errors. If omitted,
   * errors are logged via `console.error` so they are never silently
   * swallowed.
   */
  onError?: (err: unknown) => void;
};

/**
 * Validate the `boundingBoxes` config. Throws a descriptive `Error` on
 * any malformed box; returns silently if all boxes pass.
 */
function validateBoundingBoxes(
  boxes: Array<[[number, number], [number, number]]>,
): void {
  if (!Array.isArray(boxes) || boxes.length === 0) {
    throw new Error("aisstream-ts: boundingBoxes must be a non-empty array.");
  }
  for (let i = 0; i < boxes.length; i += 1) {
    const box = boxes[i];
    if (!Array.isArray(box) || box.length !== 2) {
      throw new Error(
        `aisstream-ts: boundingBoxes[${i}] must be [[swLat, swLon], [neLat, neLon]].`,
      );
    }
    const [sw, ne] = box;
    if (!Array.isArray(sw) || sw.length !== 2 || !Array.isArray(ne) || ne.length !== 2) {
      throw new Error(
        `aisstream-ts: boundingBoxes[${i}] corners must each be [lat, lon].`,
      );
    }
    const [swLat, swLon] = sw;
    const [neLat, neLon] = ne;
    for (const [name, v] of [
      ["swLat", swLat],
      ["swLon", swLon],
      ["neLat", neLat],
      ["neLon", neLon],
    ] as const) {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new Error(
          `aisstream-ts: boundingBoxes[${i}] ${name} must be a finite number (got ${String(v)}).`,
        );
      }
    }
    if (swLat < -90 || swLat > 90 || neLat < -90 || neLat > 90) {
      throw new Error(
        `aisstream-ts: boundingBoxes[${i}] latitude out of WGS-84 range [-90, 90].`,
      );
    }
    if (swLon < -180 || swLon > 180 || neLon < -180 || neLon > 180) {
      throw new Error(
        `aisstream-ts: boundingBoxes[${i}] longitude out of WGS-84 range [-180, 180].`,
      );
    }
    if (swLat > neLat) {
      throw new Error(
        `aisstream-ts: boundingBoxes[${i}] swLat (${swLat}) must be <= neLat (${neLat}).`,
      );
    }
    // Note: longitude wrap (e.g., a box across the antimeridian where
    // swLon > neLon) is not validated — AISStream itself decides how to
    // interpret that shape. We let it through and let the server respond.
  }
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
 * Format a close-event `(code, reason)` pair for inclusion in error logs.
 * Server-defined codes (4000–4999) are flagged so a reader can distinguish
 * "server kicked us" from "network dropped" (1006).
 */
function formatCloseReason(code: number, reason: string): string {
  const tag = code >= 4000 && code < 5000 ? " server-defined" : "";
  return `code=${code}${tag} reason="${reason}"`;
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
  private readonly connectTimeoutMs: number;
  private readonly expectMessageWithinMs: number | undefined;
  private readonly onError: (err: unknown) => void;

  private ws: WebSocketLike | null = null;
  private stopped = false;
  private running = false;
  private _state: AISStreamClientState = "idle";

  /** Resolver for the cancellable backoff sleep, when one is in flight. */
  private sleepWake: (() => void) | null = null;

  /** Tail of the onMessage serialization chain. */
  private messageChain: Promise<void> = Promise.resolve();

  constructor(config: AISStreamClientConfig) {
    validateBoundingBoxes(config.boundingBoxes);
    this.config = config;
    this.url = config.url ?? DEFAULT_AISSTREAM_URL;
    this.connectTimeoutMs = config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.expectMessageWithinMs = config.expectMessageWithinMs;
    this.onError =
      config.onError ??
      ((err) => {
        // eslint-disable-next-line no-console
        console.error("[aisstream-ts]", err);
      });

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

  /** Current connection state. */
  get state(): AISStreamClientState {
    return this._state;
  }

  /**
   * Run the AISStream session loop. Returns when `stop()` is called.
   *
   * Throws synchronously if called twice on the same instance or after
   * `stop()` (one run loop per client). The returned promise rejects with
   * `AISStreamAuthError` if AISStream rejects the API key — that's not a
   * transient error and retrying won't help.
   */
  run(): Promise<void> {
    if (this.running) {
      throw new Error("AISStreamClient.run() is already running on this instance.");
    }
    if (this.stopped) {
      throw new Error(
        "AISStreamClient.run() called on a stopped instance — construct a new client.",
      );
    }
    this.running = true;
    return this.runLoop();
  }

  private async runLoop(): Promise<void> {
    try {
      let attempt = 0;
      while (!this.stopped) {
        this._state = "connecting";
        const { sessionMs, closeReason } = await this.openSession();
        if (this.stopped) {
          this._state = "stopped";
          return;
        }

        // Healthy-session detection: a session whose `open`-to-`close`
        // duration meets the threshold resets the attempt counter. If
        // `open` never fired (connect timeout, immediate error), the
        // measured sessionMs is 0 and we escalate the backoff.
        if (sessionMs >= HEALTHY_SESSION_MS) {
          attempt = 0;
        } else {
          attempt += 1;
        }

        const idx = Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1);
        const delay = RECONNECT_BACKOFF_MS[idx] ?? 60_000;
        this.onError(
          new Error(
            `AISStream session ${sessionMs}ms; reconnecting in ${delay}ms (attempt=${attempt}, last close: ${closeReason})`,
          ),
        );

        this._state = "reconnecting";
        await this.cancellableSleep(delay);
      }
      this._state = "stopped";
    } finally {
      this.running = false;
    }
  }

  /**
   * Stop the run loop. Closes the active socket, cancels any in-flight
   * reconnect backoff, and causes `run()` to return. Idempotent.
   */
  stop(): void {
    this.stopped = true;
    this.sleepWake?.();
    this.sleepWake = null;
    try {
      this.ws?.close();
    } catch {
      // ignore — socket may already be closing
    }
  }

  /**
   * Resolve after `ms` milliseconds OR when `stop()` is called, whichever
   * comes first. Multiple concurrent waiters are not supported (the loop
   * is single-threaded).
   */
  private cancellableSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.sleepWake = null;
        resolve();
      }, ms);
      this.sleepWake = () => {
        clearTimeout(timer);
        this.sleepWake = null;
        resolve();
      };
    });
  }

  /**
   * Open one WebSocket session. Resolves with the measured session
   * duration (from `open` event to `close`, or 0 if `open` never fired)
   * and a printable close reason. Throws `AISStreamAuthError` if the
   * server rejects the API key.
   */
  private openSession(): Promise<{ sessionMs: number; closeReason: string }> {
    return new Promise((resolve, reject) => {
      const ws = new this.WS(this.url);
      this.ws = ws;

      let openedAt: number | null = null;
      let connectTimer: ReturnType<typeof setTimeout> | null = null;
      let silentTimer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;

      const clearTimers = () => {
        if (connectTimer !== null) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
        if (silentTimer !== null) {
          clearTimeout(silentTimer);
          silentTimer = null;
        }
      };

      const resetSilentTimer = () => {
        if (this.expectMessageWithinMs === undefined) return;
        if (silentTimer !== null) clearTimeout(silentTimer);
        silentTimer = setTimeout(() => {
          // No traffic in the expected window — assume the socket is
          // dead behind a NAT/cellular link and force-close it. The
          // close handler will trigger the normal reconnect path.
          try {
            ws.close();
          } catch {
            // ignore
          }
        }, this.expectMessageWithinMs);
      };

      // Connect timeout: if `open` doesn't fire within the window,
      // force-close the socket. The `close` handler will resolve.
      connectTimer = setTimeout(() => {
        connectTimer = null;
        try {
          ws.close();
        } catch {
          // ignore
        }
      }, this.connectTimeoutMs);

      ws.addEventListener("open", () => {
        openedAt = Date.now();
        if (connectTimer !== null) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
        this._state = "open";
        const subscription: Record<string, unknown> = {
          Apikey: this.config.apiKey,
          BoundingBoxes: this.config.boundingBoxes,
        };
        if (this.config.filterMessageTypes !== undefined) {
          subscription.FilterMessageTypes = this.config.filterMessageTypes;
        }
        ws.send(JSON.stringify(subscription));
        resetSilentTimer();
      });

      ws.addEventListener("message", async (evt) => {
        resetSilentTimer();
        let raw: string;
        try {
          raw = await decodeFrame(evt.data);
        } catch (err) {
          this.onError(err);
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          this.onError(new Error(`AISStream: non-JSON payload (${raw.slice(0, 100)})`));
          return;
        }
        // AISStream surfaces auth + subscription errors as `{"error": "..."}`.
        if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
          const msg = String((parsed as { error: unknown }).error);
          if (!settled) {
            settled = true;
            clearTimers();
            try {
              ws.close();
            } catch {
              // ignore
            }
            reject(new AISStreamAuthError(`AISStream rejected the connection: ${msg}`));
          }
          return;
        }
        // Serialize onMessage dispatch via a per-client promise chain so
        // consumers see envelopes in arrival order.
        this.messageChain = this.messageChain.then(async () => {
          try {
            await this.config.onMessage(parsed as AisEnvelope);
          } catch (err) {
            this.onError(err);
          }
        });
      });

      ws.addEventListener("error", (e) => {
        this.onError(e);
      });

      ws.addEventListener("close", (evt) => {
        clearTimers();
        this.ws = null;
        if (settled) return;
        settled = true;
        const sessionMs = openedAt === null ? 0 : Date.now() - openedAt;
        resolve({
          sessionMs,
          closeReason: formatCloseReason(evt.code, evt.reason),
        });
      });
    });
  }
}
