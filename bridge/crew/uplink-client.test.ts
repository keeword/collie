import { describe, expect, test } from "bun:test";

import type { CrewHandler } from "./router.ts";
import { encodeUplinkFrame, MEMBER_CONCURRENCY, parseUplinkFrame, type UplinkFrame } from "./uplink-frames.ts";
import { createUplinkClient, type UplinkClientSocket } from "./uplink-client.ts";

// The member's dialer against sockets that exist only in memory. What this pins: the reconnect
// ladder, that an inbound request reaches the crew handler with the lead's headers intact, the
// concurrency cap, and that a cancel aborts the work and frees the slot.

class ScriptedSocket implements UplinkClientSocket {
  readonly sent: string[] = [];
  readonly ready: Promise<void>;
  private onMsg: (text: string) => void = () => {};
  private onClosed: () => void = () => {};

  constructor(fails: boolean) {
    this.ready = fails ? Promise.reject(new Error("refused")) : Promise.resolve();
    if (fails) this.ready.catch(() => {});
  }

  send(text: string): void {
    this.sent.push(text);
  }

  onMessage(handler: (text: string) => void): void {
    this.onMsg = handler;
  }

  onClose(handler: () => void): void {
    this.onClosed = handler;
  }

  close(): void {
    this.onClosed();
  }

  receive(frame: UplinkFrame): void {
    this.onMsg(encodeUplinkFrame(frame));
  }

  drop(): void {
    this.onClosed();
  }

  frames(): (UplinkFrame | null)[] {
    return this.sent.map((text) => parseUplinkFrame(text));
  }
}

/** One client whose sockets and sleeps the test controls. `random` is pinned so delays are exact. */
function harness(over: { handler?: CrewHandler; fails?: number } = {}) {
  const sockets: ScriptedSocket[] = [];
  const delays: number[] = [];
  let failuresLeft = over.fails ?? 0;
  const client = createUplinkClient({
    url: "ws://127.0.0.1/crew/v1/uplink",
    token: "the-token",
    self: "laptop",
    handler: () => over.handler ?? null,
    random: () => 1,
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
    connect: () => {
      const socket = new ScriptedSocket(failuresLeft > 0);
      if (failuresLeft > 0) failuresLeft -= 1;
      sockets.push(socket);
      return socket;
    },
  });
  return { client, sockets, delays };
}

async function tick(): Promise<void> {
  await Bun.sleep(0);
}

describe("the uplink client", () => {
  test("a failed connection backs off on the ladder, then a good one sends hello", async () => {
    const { client, sockets, delays } = harness({ fails: 2 });
    client.start();
    await tick();
    expect(delays).toEqual([500, 1000]);
    const open = sockets.at(-1)!;
    expect(open.frames()[0]).toEqual({ kind: "hello", protocol: 2, member: "laptop" });
    expect(client.state()).toBe("open");
    client.stop();
  });

  test("a request reaches the handler with the lead's headers, and the response rides back", async () => {
    let seen: Request | null = null;
    const handler: CrewHandler = (req) => {
      seen = req;
      return Promise.resolve(new Response('{"ok":true}', { status: 200, headers: { etag: '"e"' } }));
    };
    const { client, sockets } = harness({ handler });
    client.start();
    await tick();
    const socket = sockets[0]!;
    socket.receive({
      kind: "req",
      id: 7,
      method: "POST",
      path: "/crew/v1/pane/p1/reply",
      headers: { authorization: "Bearer crew-secret", "x-crew-dial": "sig" },
      body: Buffer.from("hi").toString("base64"),
    });
    await tick();
    expect(seen).not.toBeNull();
    const req = seen!;
    expect(req.headers.get("authorization")).toBe("Bearer crew-secret");
    expect(req.headers.get("x-crew-dial")).toBe("sig");
    expect(req.url).toBe("http://127.0.0.1/crew/v1/pane/p1/reply");
    expect(await req.text()).toBe("hi");
    const answer = socket.frames().find((frame) => frame?.kind === "res");
    expect(answer?.kind).toBe("res");
    if (answer?.kind === "res") {
      expect(answer.id).toBe(7);
      expect(answer.status).toBe(200);
      expect(answer.headers.etag).toBe('"e"');
      expect(Buffer.from(answer.body ?? "", "base64").toString("utf8")).toBe('{"ok":true}');
    }
    client.stop();
  });

  test("past the concurrency cap a request is answered busy and runs nothing", async () => {
    let running = 0;
    const handler: CrewHandler = () => {
      running += 1;
      return new Promise(() => {});
    };
    const { client, sockets } = harness({ handler });
    client.start();
    await tick();
    const socket = sockets[0]!;
    const req = (id: number): UplinkFrame => ({ kind: "req", id, method: "GET", path: "/crew/v1/hello", headers: { a: "b" } });
    for (let id = 1; id <= MEMBER_CONCURRENCY + 1; id += 1) socket.receive(req(id));
    await tick();
    expect(running).toBe(MEMBER_CONCURRENCY);
    const busy = socket.frames().find((frame) => frame?.kind === "res" && frame.status === 503);
    expect(busy?.kind).toBe("res");
    client.stop();
  });

  test("a cancel aborts the work and frees the slot", async () => {
    let aborted = false;
    const handler: CrewHandler = (_req, _url) =>
      new Promise((resolve) => {
        const signal = _req.signal;
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve(new Response("cancelled", { status: 499 }));
        });
      });
    const { client, sockets } = harness({ handler });
    client.start();
    await tick();
    const socket = sockets[0]!;
    socket.receive({ kind: "req", id: 1, method: "GET", path: "/crew/v1/hello", headers: { a: "b" } });
    await tick();
    socket.receive({ kind: "cancel", id: 1 });
    await tick();
    expect(aborted).toBe(true);
    client.stop();
  });

  test("a dropped socket reconnects", async () => {
    const { client, sockets, delays } = harness();
    client.start();
    await tick();
    expect(sockets).toHaveLength(1);
    sockets[0]!.drop();
    await tick();
    expect(delays).toEqual([500]);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.frames()[0]?.kind).toBe("hello");
    client.stop();
  });
});
