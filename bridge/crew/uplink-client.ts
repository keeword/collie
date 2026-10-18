// THE MEMBER'S UPLINK CLIENT (CREW_PROTOCOL.md §21.4, §21.7) — dialing out and staying out.
//
// A member enrolled over the uplink door holds its lead's URL and token in its trust store and does
// nothing else to be reached: this client connects, presents the token, sends `hello`, and then
// answers the lead's `req` frames by running them through the SAME crew handler the member's HTTPS
// listener serves. Admission is therefore unchanged — the frame carries the §6 headers the lead's
// dial built, including the dial attestation, and the handler checks them exactly as it checks a
// dialled request. This client adds no second way to be convinced.
//
// It reconnects forever, on the ladder in `uplink-frames.ts`, until {@link UplinkClient.stop}. A
// request in flight when the socket dies is simply dropped: the lead treats that as an unknowable
// outcome and replays nothing (§21.7), so this side must not either.

import { CREW_PROTOCOL_VERSION } from "./enrollment.ts";
import type { CrewHandler } from "./router.ts";
import {
  encodeUplinkFrame,
  MEMBER_CONCURRENCY,
  parseUplinkFrame,
  PING_MS,
  reconnectDelayMs,
  type UplinkFrame,
} from "./uplink-frames.ts";

/** The most bytes of a response body this client will frame back. Past it the lead hears 502. */
const RESPONSE_BODY_CAP = 32 * 1024 * 1024;

/** A socket, as the client needs it. The default is Bun's WebSocket; tests supply their own. */
export interface UplinkClientSocket {
  /** Resolves when the socket is open, rejects when the connection fails. */
  readonly ready: Promise<void>;
  send(text: string): void;
  onMessage(handler: (text: string) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

export interface UplinkClientDeps {
  /** The door's URL, `wss://` (or loopback `ws://` in development and tests). */
  readonly url: string;
  /** The long-term token from enrollment. Presented as a bearer on every connection. */
  readonly token: string;
  /** This member's own id, carried in `hello`. Informational: the token is what admits. */
  readonly self: string;
  /** The crew handler the server built. Read per frame, `null` until the server exists. */
  readonly handler: () => CrewHandler | null;
  now?: () => number;
  /** Full-jitter source, in [0, 1). Injectable so the reconnect ladder is testable. */
  random?: () => number;
  /** The wait between attempts. Injectable so tests run the ladder without sleeping. */
  sleep?: (ms: number) => Promise<void>;
  /** The socket factory. Injectable so tests dial nothing. */
  connect?: (url: string, token: string) => UplinkClientSocket;
}

export interface UplinkClient {
  start(): void;
  stop(): void;
  state(): "connecting" | "open";
}

/** Dial the door with the token. Bun's client takes the header; the DOM types don't know that. */
function bunConnect(url: string, token: string): UplinkClientSocket {
  // SAFETY: Bun's WebSocket client accepts `{ headers }` (verified on Bun 1.4.3). The DOM typing of
  // the same global only knows subprotocols, so the constructor is narrowed to the Bun signature.
  const Socket = WebSocket as new (address: string, opts?: Bun.WebSocketOptions) => WebSocket;
  const ws = new Socket(url, { headers: { authorization: `Bearer ${token}` } });
  return {
    ready: new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("uplink: connection failed")), { once: true });
    }),
    send: (text) => ws.send(text),
    onMessage: (handler) => ws.addEventListener("message", (ev) => handler(String(ev.data))),
    onClose: (handler) => ws.addEventListener("close", () => handler(), { once: true }),
    close: () => ws.close(),
  };
}

export function createUplinkClient(deps: UplinkClientDeps): UplinkClient {
  const random = deps.random ?? Math.random;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const connect = deps.connect ?? bunConnect;
  let stopped = false;
  let current: "connecting" | "open" = "connecting";
  let socket: UplinkClientSocket | null = null;
  let executing = 0;
  const inflight = new Map<number, AbortController>();

  const dispatch = async (target: UplinkClientSocket, frame: Extract<UplinkFrame, { kind: "req" }>): Promise<void> => {
    if (executing >= MEMBER_CONCURRENCY) {
      reply(target, { kind: "res", id: frame.id, status: 503, headers: { "content-type": "application/json" }, body: b64('{"error":"busy"}') });
      return;
    }
    executing += 1;
    const controller = new AbortController();
    inflight.set(frame.id, controller);
    try {
      const handler = deps.handler();
      const req = requestOf(frame, controller.signal);
      const res = handler === null ? null : await handler(req, new URL(req.url));
      reply(target, await responseFrame(frame.id, res ?? new Response("not found", { status: 404 })));
    } catch {
      // The lead's cancel aborts the signal; the handler throws or just returns. Either way the
      // lead has moved on, and a late answer for a cancelled id would be a second outcome.
      if (!controller.signal.aborted) {
        reply(target, { kind: "res", id: frame.id, status: 500, headers: { "content-type": "application/json" }, body: b64('{"error":"failed"}') });
      }
    } finally {
      executing -= 1;
      inflight.delete(frame.id);
    }
  };

  const onFrame = (target: UplinkClientSocket, raw: string): void => {
    const frame = parseUplinkFrame(raw);
    if (frame === null) {
      // A frame this member cannot read is a fault of the connection, not of one request.
      target.close();
      return;
    }
    if (frame.kind === "req") {
      void dispatch(target, frame);
      return;
    }
    if (frame.kind === "cancel") {
      inflight.get(frame.id)?.abort();
      return;
    }
    // welcome and pong carry nothing this side acts on.
  };

  const session = (open: UplinkClientSocket): Promise<void> =>
    new Promise((resolve) => {
      const ping = setInterval(() => open.send(encodeUplinkFrame({ kind: "ping" })), PING_MS);
      const done = { settled: false };
      open.onClose(() => {
        // close can be observed twice — the peer's close and our own stop() — and a promise settles
        // exactly once.
        if (done.settled) return;
        done.settled = true;
        clearInterval(ping);
        for (const controller of inflight.values()) controller.abort();
        inflight.clear();
        finishSession(resolve);
      });
      open.onMessage((text) => onFrame(open, text));
      open.send(encodeUplinkFrame({ kind: "hello", protocol: CREW_PROTOCOL_VERSION, member: deps.self }));
    });

  const loop = async (): Promise<void> => {
    let attempt = 0;
    for (;;) {
      if (stopped) return;
      const opened = connect(deps.url, deps.token);
      socket = opened;
      try {
        await opened.ready;
        if (stopped) {
          opened.close();
          return;
        }
        attempt = 0;
        current = "open";
        await session(opened);
      } catch {
        // The connection never opened. Fall through to the backoff.
      }
      current = "connecting";
      if (stopped) return;
      await sleep(reconnectDelayMs(attempt, random()));
      attempt += 1;
    }
  };

  return {
    start(): void {
      if (!stopped && socket !== null) return;
      stopped = false;
      void loop();
    },
    stop(): void {
      stopped = true;
      socket?.close();
      socket = null;
    },
    state: () => current,
  };
}

/** Settle a session's promise. Split out so the promise's one resolution has exactly one call site. */
function finishSession(resolve: () => void): void {
  resolve();
}

/** A `res` frame back to the lead. Module scope: it closes over nothing. */
function reply(target: UplinkClientSocket, frame: Extract<UplinkFrame, { kind: "res" }>): void {
  target.send(encodeUplinkFrame(frame));
}

/** The lead's `req` frame as the request the crew handler already knows how to admit. */
function requestOf(frame: Extract<UplinkFrame, { kind: "req" }>, signal: AbortSignal): Request {
  const body = frame.body === undefined ? undefined : Buffer.from(frame.body, "base64");
  const init: RequestInit = { method: frame.method, headers: frame.headers, signal };
  if (body !== undefined && frame.method !== "GET" && frame.method !== "HEAD") init.body = body;
  return new Request(`http://127.0.0.1${frame.path}`, init);
}

/** A handler's response as a `res` frame, bounded. Over the cap the lead hears 502, not a truncated body. */
async function responseFrame(id: number, res: Response): Promise<Extract<UplinkFrame, { kind: "res" }>> {
  const headers: Record<string, string> = {};
  let count = 0;
  res.headers.forEach((value, name) => {
    if (count >= 32) return;
    count += 1;
    headers[name] = value;
  });
  const bytes = await readCapped(res);
  if (bytes === null) {
    return { kind: "res", id, status: 502, headers: { "content-type": "application/json" }, body: b64('{"error":"too-large"}') };
  }
  const frame: Extract<UplinkFrame, { kind: "res" }> = { kind: "res", id, status: res.status, headers };
  if (bytes.length === 0) return frame;
  return { ...frame, body: Buffer.from(bytes).toString("base64") };
}

/** The body, or `null` when it runs past {@link RESPONSE_BODY_CAP}. */
async function readCapped(res: Response): Promise<Uint8Array | null> {
  const reader = res.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > RESPONSE_BODY_CAP) {
      await reader.cancel();
      return null;
    }
    chunks.push(next.value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}
