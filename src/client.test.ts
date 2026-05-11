import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AISStreamAuthError,
  AISStreamClient,
  type WebSocketConstructor,
  type WebSocketLike,
} from "./client";

// --- Mock WebSocket harness ------------------------------------------------

type Listener<E> = (evt: E) => void;

class MockSocket implements WebSocketLike {
  static instances: MockSocket[] = [];

  url: string;
  sent: string[] = [];
  closed = false;
  private openListeners: Array<Listener<void>> = [];
  private messageListeners: Array<Listener<{ data: unknown }>> = [];
  private errorListeners: Array<Listener<unknown>> = [];
  private closeListeners: Array<Listener<{ code: number; reason: string }>> = [];

  constructor(url: string) {
    this.url = url;
    MockSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Simulate the server / runtime firing a close event after our close().
    queueMicrotask(() => this.fireClose(1000, "client close"));
  }

  addEventListener(event: "open", listener: Listener<void>): void;
  addEventListener(event: "message", listener: Listener<{ data: unknown }>): void;
  addEventListener(event: "error", listener: Listener<unknown>): void;
  addEventListener(event: "close", listener: Listener<{ code: number; reason: string }>): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addEventListener(event: string, listener: any): void {
    if (event === "open") this.openListeners.push(listener);
    else if (event === "message") this.messageListeners.push(listener);
    else if (event === "error") this.errorListeners.push(listener);
    else if (event === "close") this.closeListeners.push(listener);
  }

  // Test-side fire methods
  fireOpen(): void {
    for (const l of this.openListeners) l();
  }
  fireMessage(data: unknown): void {
    for (const l of this.messageListeners) l({ data });
  }
  fireError(e: unknown = new Error("ws error")): void {
    for (const l of this.errorListeners) l(e);
  }
  fireClose(code = 1006, reason = "abnormal closure"): void {
    if (this.closed && code === 1000) {
      // already-set close path from close()
    } else {
      this.closed = true;
    }
    for (const l of this.closeListeners) l({ code, reason });
  }
}

const MockWS = MockSocket as unknown as WebSocketConstructor;

function clearMockInstances(): void {
  MockSocket.instances.length = 0;
}

beforeEach(() => {
  clearMockInstances();
});

afterEach(() => {
  vi.useRealTimers();
});

const VALID_BOX: Array<[[number, number], [number, number]]> = [[
  [47, -125],
  [50, -122],
]];

// --- Tests ----------------------------------------------------------------

describe("AISStreamClient — constructor validation", () => {
  it("throws on empty boundingBoxes", () => {
    expect(
      () =>
        new AISStreamClient({
          apiKey: "k",
          boundingBoxes: [],
          onMessage: () => {},
          WebSocketImpl: MockWS,
        }),
    ).toThrowError(/non-empty array/);
  });

  it("throws on a box with the wrong number of corners", () => {
    expect(
      () =>
        new AISStreamClient({
          apiKey: "k",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          boundingBoxes: [[[47, -125]] as any],
          onMessage: () => {},
          WebSocketImpl: MockWS,
        }),
    ).toThrowError(/\[swLat, swLon\], \[neLat, neLon\]/);
  });

  it("throws on out-of-range latitude", () => {
    expect(
      () =>
        new AISStreamClient({
          apiKey: "k",
          boundingBoxes: [[[91, -125], [92, -122]]],
          onMessage: () => {},
          WebSocketImpl: MockWS,
        }),
    ).toThrowError(/latitude out of WGS-84 range/);
  });

  it("throws on out-of-range longitude", () => {
    expect(
      () =>
        new AISStreamClient({
          apiKey: "k",
          boundingBoxes: [[[47, -181], [50, -122]]],
          onMessage: () => {},
          WebSocketImpl: MockWS,
        }),
    ).toThrowError(/longitude out of WGS-84 range/);
  });

  it("throws on inverted lat ordering (swLat > neLat)", () => {
    expect(
      () =>
        new AISStreamClient({
          apiKey: "k",
          boundingBoxes: [[[50, -125], [47, -122]]],
          onMessage: () => {},
          WebSocketImpl: MockWS,
        }),
    ).toThrowError(/swLat .* must be <= neLat/);
  });

  it("throws on non-finite coordinate", () => {
    expect(
      () =>
        new AISStreamClient({
          apiKey: "k",
          boundingBoxes: [[[Number.NaN, -125], [50, -122]]],
          onMessage: () => {},
          WebSocketImpl: MockWS,
        }),
    ).toThrowError(/finite number/);
  });

  it("accepts a well-formed box", () => {
    expect(
      () =>
        new AISStreamClient({
          apiKey: "k",
          boundingBoxes: VALID_BOX,
          onMessage: () => {},
          WebSocketImpl: MockWS,
        }),
    ).not.toThrow();
  });
});

describe("AISStreamClient — subscription frame", () => {
  it("sends apiKey and boundingBoxes on open", () => {
    const client = new AISStreamClient({
      apiKey: "K1",
      boundingBoxes: VALID_BOX,
      onMessage: () => {},
      WebSocketImpl: MockWS,
    });
    const runP = client.run();
    expect(MockSocket.instances).toHaveLength(1);
    const sock = MockSocket.instances[0]!;
    sock.fireOpen();
    expect(sock.sent).toHaveLength(1);
    const sub = JSON.parse(sock.sent[0]!);
    expect(sub.Apikey).toBe("K1");
    expect(sub.BoundingBoxes).toEqual(VALID_BOX);
    expect(sub.FilterMessageTypes).toBeUndefined();
    client.stop();
    return runP;
  });

  it("includes FilterMessageTypes when provided", () => {
    const client = new AISStreamClient({
      apiKey: "K1",
      boundingBoxes: VALID_BOX,
      filterMessageTypes: ["PositionReport"],
      onMessage: () => {},
      WebSocketImpl: MockWS,
    });
    const runP = client.run();
    MockSocket.instances[0]!.fireOpen();
    const sub = JSON.parse(MockSocket.instances[0]!.sent[0]!);
    expect(sub.FilterMessageTypes).toEqual(["PositionReport"]);
    client.stop();
    return runP;
  });
});

describe("AISStreamClient — state", () => {
  it("progresses idle → connecting → open → reconnecting → stopped", async () => {
    const client = new AISStreamClient({
      apiKey: "k",
      boundingBoxes: VALID_BOX,
      onMessage: () => {},
      WebSocketImpl: MockWS,
      onError: () => {},
    });
    expect(client.state).toBe("idle");

    const runP = client.run();
    // Microtask boundary: run() has started, openSession constructed the socket
    await Promise.resolve();
    expect(client.state).toBe("connecting");

    MockSocket.instances[0]!.fireOpen();
    expect(client.state).toBe("open");

    MockSocket.instances[0]!.fireClose(1006, "drop");
    await Promise.resolve(); // let the close handler run + run() resume
    await Promise.resolve();
    expect(["reconnecting", "stopped"]).toContain(client.state);

    client.stop();
    await runP;
    expect(client.state).toBe("stopped");
  });
});

describe("AISStreamClient — auth error", () => {
  it("throws AISStreamAuthError when server sends an `error` envelope", async () => {
    const client = new AISStreamClient({
      apiKey: "bad",
      boundingBoxes: VALID_BOX,
      onMessage: () => {},
      WebSocketImpl: MockWS,
    });
    const runP = client.run();
    await Promise.resolve();
    const sock = MockSocket.instances[0]!;
    sock.fireOpen();
    sock.fireMessage(JSON.stringify({ error: "invalid api key" }));
    await expect(runP).rejects.toBeInstanceOf(AISStreamAuthError);
  });
});

describe("AISStreamClient — re-entry guard", () => {
  it("throws if run() is called twice", async () => {
    const client = new AISStreamClient({
      apiKey: "k",
      boundingBoxes: VALID_BOX,
      onMessage: () => {},
      WebSocketImpl: MockWS,
      onError: () => {},
    });
    const runP = client.run();
    await Promise.resolve();
    expect(() => client.run()).toThrowError(/already running/);
    client.stop();
    await runP;
  });

  it("throws if run() is called after stop()", async () => {
    const client = new AISStreamClient({
      apiKey: "k",
      boundingBoxes: VALID_BOX,
      onMessage: () => {},
      WebSocketImpl: MockWS,
      onError: () => {},
    });
    const runP = client.run();
    await Promise.resolve();
    client.stop();
    await runP;
    expect(() => client.run()).toThrowError(/stopped instance/);
  });
});

describe("AISStreamClient — cancellable stop during backoff", () => {
  it("stop() during reconnect sleep resolves run() promptly", async () => {
    vi.useFakeTimers();
    const client = new AISStreamClient({
      apiKey: "k",
      boundingBoxes: VALID_BOX,
      onMessage: () => {},
      WebSocketImpl: MockWS,
      onError: () => {},
    });
    const runP = client.run();
    await Promise.resolve();
    // First session opens then immediately closes — drops into backoff
    MockSocket.instances[0]!.fireOpen();
    MockSocket.instances[0]!.fireClose(1006, "drop");
    await Promise.resolve();
    await Promise.resolve();
    expect(client.state).toBe("reconnecting");

    // stop() should cancel the sleep immediately
    client.stop();
    // Don't need to advance timers — sleep cancellation wakes us up
    await runP;
    expect(client.state).toBe("stopped");
  });
});

describe("AISStreamClient — connect timeout", () => {
  it("force-closes the socket if open never fires", async () => {
    vi.useFakeTimers();
    const client = new AISStreamClient({
      apiKey: "k",
      boundingBoxes: VALID_BOX,
      onMessage: () => {},
      WebSocketImpl: MockWS,
      connectTimeoutMs: 5_000,
      onError: () => {},
    });
    const runP = client.run();
    await Promise.resolve();
    const sock = MockSocket.instances[0]!;
    expect(sock.closed).toBe(false);

    vi.advanceTimersByTime(5_000);
    // close handler queued via queueMicrotask in MockSocket.close
    await Promise.resolve();
    expect(sock.closed).toBe(true);

    client.stop();
    // Drain the backoff microtask before completing
    await vi.runOnlyPendingTimersAsync();
    await runP;
  });
});

describe("AISStreamClient — silent-socket watchdog", () => {
  it("force-closes a session that goes silent", async () => {
    vi.useFakeTimers();
    const client = new AISStreamClient({
      apiKey: "k",
      boundingBoxes: VALID_BOX,
      onMessage: () => {},
      WebSocketImpl: MockWS,
      expectMessageWithinMs: 3_000,
      onError: () => {},
    });
    const runP = client.run();
    await Promise.resolve();
    const sock = MockSocket.instances[0]!;
    sock.fireOpen();
    expect(sock.closed).toBe(false);

    vi.advanceTimersByTime(3_000);
    await Promise.resolve();
    expect(sock.closed).toBe(true);

    client.stop();
    await vi.runOnlyPendingTimersAsync();
    await runP;
  });

  it("does not close while messages keep arriving", async () => {
    vi.useFakeTimers();
    const client = new AISStreamClient({
      apiKey: "k",
      boundingBoxes: VALID_BOX,
      onMessage: () => {},
      WebSocketImpl: MockWS,
      expectMessageWithinMs: 3_000,
      onError: () => {},
    });
    const runP = client.run();
    await Promise.resolve();
    const sock = MockSocket.instances[0]!;
    sock.fireOpen();

    // Keep firing messages every 1s for 10s — should not trigger watchdog.
    for (let t = 0; t < 10; t += 1) {
      vi.advanceTimersByTime(1_000);
      sock.fireMessage(JSON.stringify({ MessageType: "Heartbeat", MetaData: {}, Message: {} }));
    }
    expect(sock.closed).toBe(false);

    client.stop();
    await vi.runOnlyPendingTimersAsync();
    await runP;
  });
});

describe("AISStreamClient — onMessage serialization", () => {
  it("invokes onMessage in arrival order, awaiting each before the next", async () => {
    const calls: number[] = [];
    let release1: () => void = () => {};
    const slowFirst = new Promise<void>((r) => {
      release1 = r;
    });

    const client = new AISStreamClient({
      apiKey: "k",
      boundingBoxes: VALID_BOX,
      onMessage: async (env) => {
        const seq = (env.MetaData as unknown as { seq: number }).seq;
        if (seq === 1) {
          await slowFirst;
        }
        calls.push(seq);
      },
      WebSocketImpl: MockWS,
      onError: () => {},
    });
    const runP = client.run();
    await Promise.resolve();
    const sock = MockSocket.instances[0]!;
    sock.fireOpen();

    sock.fireMessage(JSON.stringify({ MessageType: "PositionReport", MetaData: { seq: 1 }, Message: {} }));
    sock.fireMessage(JSON.stringify({ MessageType: "PositionReport", MetaData: { seq: 2 }, Message: {} }));
    sock.fireMessage(JSON.stringify({ MessageType: "PositionReport", MetaData: { seq: 3 }, Message: {} }));

    // None should have run yet — first is awaiting slowFirst, and the
    // chain ensures the others wait too.
    await Promise.resolve();
    expect(calls).toEqual([]);

    release1();
    // Drain the chain: each link is `then(async () => { await onMessage; })`
    // which produces multiple microtasks per element. 30 passes is ample.
    for (let i = 0; i < 30; i += 1) {
      await Promise.resolve();
    }
    expect(calls).toEqual([1, 2, 3]);

    client.stop();
    await runP;
  });
});

describe("AISStreamClient — default onError", () => {
  it("uses console.error when onError is not provided", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = new AISStreamClient({
      apiKey: "k",
      boundingBoxes: VALID_BOX,
      onMessage: () => {},
      WebSocketImpl: MockWS,
    });
    const runP = client.run();
    await Promise.resolve();
    const sock = MockSocket.instances[0]!;
    sock.fireOpen();
    sock.fireMessage("not json {{{");
    await Promise.resolve();
    expect(spy).toHaveBeenCalled();
    expect(String(spy.mock.calls[0]?.[0])).toContain("aisstream-ts");
    spy.mockRestore();
    client.stop();
    await runP;
  });
});

describe("AISStreamClient — close code interpretation", () => {
  it("flags 4xxx server-defined codes in the reconnect message", async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const client = new AISStreamClient({
      apiKey: "k",
      boundingBoxes: VALID_BOX,
      onMessage: () => {},
      WebSocketImpl: MockWS,
      onError: (e) => errors.push(e),
    });
    const runP = client.run();
    await Promise.resolve();
    const sock = MockSocket.instances[0]!;
    sock.fireOpen();
    sock.fireClose(4001, "rate limited");
    await Promise.resolve();
    await Promise.resolve();
    const msg = String((errors[0] as Error).message);
    expect(msg).toMatch(/code=4001/);
    expect(msg).toMatch(/server-defined/);
    client.stop();
    await vi.runOnlyPendingTimersAsync();
    await runP;
  });
});
