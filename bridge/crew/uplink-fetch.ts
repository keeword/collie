// THE LEAD'S CREW FETCH OVER AN UPLINK SOCKET (CREW_PROTOCOL.md §21.3, §21.7).
//
// `PeerClient.dial` frames every crew request as an HTTP call and hands it to a `CrewFetch`. For an
// uplink member that function writes one `req` frame on the member's live socket and reads the `res`
// frame back, and the rest of `dial` — the budgets, the abort timer, the version check, the
// receipts — is untouched. This file is that function.
//
// THREE REFUSALS, AND WHICH ONE IS WHICH:
//
//  • **Nothing was sent** throws {@link UplinkNeverSent}: no live socket, or the per-member in-flight
//    cap is already full. `PeerClient` reads the `neverSent` flag and reports `attempted: false`, so
//    the phone gets a clean refusal instead of an unknown outcome.
//  • **The lead's own deadline fired** rejects with the abort reason AFTER sending `cancel`. The
//    member stops the work; the lead reports a timeout. Nothing is retried.
//  • **The socket died mid-request** rejects with a plain error. Whether the request had reached the
//    member is unknowable, so `attempted` stays absent and a write surfaces as `write_outcome_unknown`
//    — §10.3's rule, extended to the connection. Nothing is queued for the reconnect.

import type { CrewFetch } from "./peer-client.ts";
import type { CrewRequestInit } from "./transport.ts";
import { encodeUplinkFrame, parseUplinkFrame, type UplinkFrame } from "./uplink-frames.ts";

/** A live uplink connection, as the fetch needs it. The door implements it over its socket. */
export interface UplinkSocket {
  send(frame: UplinkFrame): void;
  /** Fires for every `res` frame. Returns the unsubscribe. */
  onRes(handler: (frame: Extract<UplinkFrame, { kind: "res" }>) => void): () => void;
  /** Fires once, when the connection is gone. Returns the unsubscribe. */
  onClose(handler: () => void): () => void;
  readonly closed: boolean;
}

/**
 * A request that never reached the member. `PeerClient` reads {@link neverSent} and reports the
 * attempt as not made, which is what keeps a refusal from looking like an unknown outcome (§10.3).
 */
export class UplinkNeverSent extends Error {
  readonly neverSent = true as const;

  constructor(message: string) {
    super(message);
    this.name = "UplinkNeverSent";
  }
}

export interface UplinkFetchOptions {
  /** How many requests may be in flight to this member before the next is refused. */
  readonly inflightMax: number;
  /** The most bytes a request body may carry. Past it, nothing is framed. */
  readonly bodyBytesMax: number;
}

/** One `CrewFetch` bound to one member's socket. */
export function makeUplinkFetch(socket: UplinkSocket, opts: UplinkFetchOptions): CrewFetch {
  let inflight = 0;
  let nextId = 1;
  return async (url: string, init: CrewRequestInit): Promise<Response> => {
    if (socket.closed) throw new UplinkNeverSent("uplink: member not connected");
    if (inflight >= opts.inflightMax) throw new UplinkNeverSent("uplink: too many requests in flight");
    const id = nextId;
    nextId += 1;
    inflight += 1;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      inflight -= 1;
    };
    try {
      const frame = await requestFrame(id, url, init, opts.bodyBytesMax);
      return await new Promise<Response>((resolve, reject) => {
        const offRes = socket.onRes((res) => {
          if (res.id !== id) return;
          cleanup();
          resolve(responseOf(res));
        });
        const offClose = socket.onClose(() => {
          cleanup();
          // The request MAY have reached the member. §10.3: an unresolvable ambiguity is surfaced,
          // never guessed, so this is a plain error and `attempted` stays absent.
          reject(new Error("uplink: connection closed"));
        });
        const signal = init.signal;
        const onAbort = (): void => {
          // Best effort: the member stops, but the deadline is the lead's own clock either way.
          socket.send({ kind: "cancel", id });
          cleanup();
          reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
        };
        const cleanup = (): void => {
          finish();
          offRes();
          offClose();
          signal?.removeEventListener("abort", onAbort);
        };
        if (signal?.aborted === true) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        socket.send(frame);
      });
    } catch (err) {
      finish();
      throw err;
    }
  };
}

/** The `req` frame for one dial. Throws {@link UplinkNeverSent} when the body exceeds the cap. */
async function requestFrame(
  id: number,
  url: string,
  init: CrewRequestInit,
  bodyBytesMax: number,
): Promise<Extract<UplinkFrame, { kind: "req" }>> {
  const parsed = new URL(url);
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => {
    // The peer hop carries identity bytes (ADR 0023); the member compresses nothing for us.
    if (name === "accept-encoding") return;
    headers[name] = value;
  });
  const body = await bodyOf(init.body, bodyBytesMax);
  const frame: Extract<UplinkFrame, { kind: "req" }> = {
    kind: "req",
    id,
    method: init.method ?? "GET",
    path: `${parsed.pathname}${parsed.search}`,
    headers,
  };
  if (body === null) return frame;
  return { ...frame, body };
}

/** A request body as base64, `null` when there is none. */
async function bodyOf(body: BodyInit | null | undefined, maxBytes: number): Promise<string | null> {
  if (body === undefined || body === null) return null;
  if (typeof body !== "string") {
    // A streamed upload (forward.ts, `duplex: "half"`). Read it bounded: past the cap, frame nothing.
    const bytes = await readBounded(body, maxBytes);
    if (bytes === null) throw new UplinkNeverSent("uplink: request body exceeds the cap");
    if (bytes.length === 0) return null;
    return Buffer.from(bytes).toString("base64");
  }
  if (Buffer.byteLength(body, "utf8") > maxBytes) throw new UplinkNeverSent("uplink: request body exceeds the cap");
  if (body.length === 0) return null;
  return Buffer.from(body, "utf8").toString("base64");
}

/** Read a stream up to `maxBytes`, or `null` when it runs past the cap. */
async function readBounded(body: BodyInit, maxBytes: number): Promise<Uint8Array | null> {
  const reader = new Response(body).body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
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

/** The `Response` `PeerClient` expects, rebuilt from a `res` frame. Status and headers pass through. */
function responseOf(frame: Extract<UplinkFrame, { kind: "res" }>): Response {
  const body = frame.body === undefined ? null : Buffer.from(frame.body, "base64");
  return new Response(body, { status: frame.status, headers: frame.headers });
}

/**
 * Encode a frame for the wire. Thin, but the one place a caller sends, so a test can substitute the
 * socket without knowing the encoding.
 */
export function frameText(frame: UplinkFrame): string {
  return encodeUplinkFrame(frame);
}

/** Parse one inbound frame, or `null` when it is not one. A `null` is a fault of the connection. */
export function frameFromText(raw: string): UplinkFrame | null {
  return parseUplinkFrame(raw);
}
