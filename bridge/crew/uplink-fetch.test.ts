import { describe, expect, test } from "bun:test";

import type { CrewRequestInit } from "./transport.ts";
import {
  encodeUplinkFrame,
  parseUplinkFrame,
  type UplinkFrame,
} from "./uplink-frames.ts";
import { makeUplinkFetch, UplinkNeverSent, type UplinkSocket } from "./uplink-fetch.ts";

// The lead's fetch over an uplink socket, against a socket that exists only in memory. What this
// pins is the three refusals: nothing sent (neverSent), the lead's own deadline (cancel), and a
// socket that died mid-request (a plain error, so the outcome stays unknowable).

class FakeSocket implements UplinkSocket {
  readonly sent: UplinkFrame[] = [];
  closed = false;
  private readonly resHandlers = new Set<(frame: Extract<UplinkFrame, { kind: "res" }>) => void>();
  private readonly closeHandlers = new Set<() => void>();

  send(frame: UplinkFrame): void {
    this.sent.push(frame);
  }

  onRes(handler: (frame: Extract<UplinkFrame, { kind: "res" }>) => void): () => void {
    this.resHandlers.add(handler);
    return () => this.resHandlers.delete(handler);
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  reply(frame: Extract<UplinkFrame, { kind: "res" }>): void {
    for (const handler of this.resHandlers) handler(frame);
  }

  die(): void {
    this.closed = true;
    for (const handler of this.closeHandlers) handler();
  }
}

const OPTS = { inflightMax: 2, bodyBytesMax: 1024 };

/** The fetch sends only after its first await, so a test settles that tick before it looks. */
function tick(): Promise<void> {
  return Bun.sleep(0);
}

function dial(socket: FakeSocket, init: CrewRequestInit = {}): Promise<Response> {
  return makeUplinkFetch(socket, OPTS)("https://collie.example.com/crew/v1/snapshot?sessions=all", init);
}

describe("makeUplinkFetch", () => {
  test("a request frames the path, the headers and the body, and the response comes back whole", async () => {
    const socket = new FakeSocket();
    const pending = dial(socket, {
      method: "POST",
      headers: { authorization: "Bearer secret", "accept-encoding": "gzip" },
      body: "hello",
    });
    await tick();
    const req = socket.sent[0];
    expect(req?.kind).toBe("req");
    if (req?.kind !== "req") return;
    expect(req.path).toBe("/crew/v1/snapshot?sessions=all");
    expect(req.method).toBe("POST");
    expect(req.headers.authorization).toBe("Bearer secret");
    // The peer hop carries identity bytes (ADR 0023); the member compresses nothing.
    expect(req.headers["accept-encoding"]).toBeUndefined();
    expect(Buffer.from(req.body ?? "", "base64").toString("utf8")).toBe("hello");
    socket.reply({ kind: "res", id: req.id, status: 200, headers: { etag: '"e"' }, body: Buffer.from("{}").toString("base64") });
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe('"e"');
    expect(await res.text()).toBe("{}");
  });

  test("a bodyless response round-trips, as a 304 must", async () => {
    const socket = new FakeSocket();
    const pending = dial(socket);
    await tick();
    const req = socket.sent[0];
    if (req?.kind !== "req") throw new Error("no request framed");
    socket.reply({ kind: "res", id: req.id, status: 304, headers: { etag: '"e"' } });
    const res = await pending;
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
  });

  test("no socket and a full cap both refuse before anything is sent", async () => {
    const closed = new FakeSocket();
    closed.closed = true;
    await expect(dial(closed)).rejects.toBeInstanceOf(UplinkNeverSent);

    const socket = new FakeSocket();
    const fetch = makeUplinkFetch(socket, OPTS);
    const url = "https://collie.example.com/crew/v1/snapshot?sessions=all";
    const first = fetch(url, {});
    const second = fetch(url, {});
    await tick();
    // The cap is per connection: the third request is refused before it is framed.
    await expect(fetch(url, {})).rejects.toBeInstanceOf(UplinkNeverSent);
    expect(socket.sent).toHaveLength(2);
    // Settle the two that were framed so the test ends clean.
    for (const frame of socket.sent) {
      if (frame.kind === "req") socket.reply({ kind: "res", id: frame.id, status: 204, headers: { a: "b" } });
    }
    await Promise.all([first, second]);
  });

  test("a body past the cap frames nothing", async () => {
    const socket = new FakeSocket();
    await expect(dial(socket, { method: "POST", body: "x".repeat(OPTS.bodyBytesMax + 1) })).rejects.toBeInstanceOf(
      UplinkNeverSent,
    );
    expect(socket.sent).toHaveLength(0);
  });

  test("the lead's deadline sends cancel and rejects", async () => {
    const socket = new FakeSocket();
    const controller = new AbortController();
    const pending = dial(socket, { signal: controller.signal });
    await tick();
    expect(socket.sent).toHaveLength(1);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(socket.sent.at(-1)).toEqual({ kind: "cancel", id: 1 });
  });

  test("a socket that dies mid-request is a plain error, not a never-sent", async () => {
    const socket = new FakeSocket();
    const pending = dial(socket);
    await tick();
    socket.die();
    let caught: Error | null = null;
    try {
      await pending;
    } catch (err) {
      if (err instanceof Error) caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(UplinkNeverSent);
  });
});

describe("the frame helpers agree with the codec", () => {
  test("a frame survives the wire encoding the door uses", () => {
    const frame: UplinkFrame = { kind: "ping" };
    expect(parseUplinkFrame(encodeUplinkFrame(frame))).toEqual(frame);
  });
});
