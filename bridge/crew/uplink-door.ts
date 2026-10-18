// THE UPLINK DOOR (CREW_PROTOCOL.md §21.2) — the lead's second listener, where members dial in.
//
// The same posture as the standby door (ADR 0028): its OWN `Bun.serve`, on its own port, bound to
// loopback by default, with TLS terminated by the operator's reverse proxy on 443. Absent
// `COLLIE_CREW_UPLINK_PORT` means no door at all — {@link uplinkPortOf} returns null and the caller
// binds nothing. It never rides the front door's `fetch`: the front door's source is forbidden from
// upgrading WebSockets (bridge/access-jwt.test.ts), and a member connection is not a browser request.
//
// TWO KINDS OF CONNECTION, and the header decides before the upgrade:
//
//  • **A bearer token** that hashes to an enrolled uplink member's `uplinkTokenHash` → an
//    authenticated connection. Its first frame must be `hello`; the door answers `welcome` and
//    registers the socket, replacing any older one for that member.
//  • **No token** → an enrollment connection. Its first frame must be `enroll`, and it has five
//    seconds. The invite is spent either way (§8.2's rule), an uplink invite enrolls the member and
//    the signed `enrolled` answer goes back, and then the connection closes — the member reconnects
//    authenticated, with the token it just received.
//
// Anything else is the uniform refusal: `401 {"error":"unauthorized"}`, whether the token is wrong,
// stale, or belongs to a member that was removed. A refusal names nothing.
//
// The door pins nothing and holds no timer of its own for liveness. `idleTimeout` closes a socket
// that goes quiet, and the member's `ping` frames are the activity that keeps a live one open.

import type { ServerWebSocket } from "bun";

import type { AuditLog } from "../audit.ts";
import {
  commitCrewChange,
  consumeInvite,
  enrollUplinkPeer,
  type UplinkEnrollment,
} from "./enrollment.ts";
import { bearerToken, hashToken, secretEquals, type RandomSource } from "./identity.ts";
import { signUplinkEnrollment } from "./signing.ts";
import { TrustStore, type TrustStoreData } from "./trust-store.ts";
import {
  DOOR_IDLE_S,
  LEAD_INFLIGHT_MAX,
  parseUplinkFrame,
  type UplinkBounds,
  type UplinkFrame,
} from "./uplink-frames.ts";
import { makeUplinkFetch, UplinkNeverSent, type UplinkSocket } from "./uplink-fetch.ts";
import type { CrewFetch } from "./peer-client.ts";

// The member's half of the exchange (acceptUplinkEnrollment) lives in enrollment.ts and runs on the
// joining machine. This module is only the lead's half.
export const UPLINK_PORT_ENV = "COLLIE_CREW_UPLINK_PORT";
export const UPLINK_HOST_ENV = "COLLIE_CREW_UPLINK_HOST";

/** The path the door upgrades. The operator's proxy must forward it WITHOUT stripping the prefix. */
export const UPLINK_PATH = "/crew/v1/uplink";

/** How long an opening connection has to send its first frame before the door closes it. */
export const ENROLL_WINDOW_MS = 5_000;

type Env = Record<string, string | undefined>;

function positiveInt(raw: string | undefined): number | null {
  const parsed = Number.parseInt(raw?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** The port the door binds, or `null` — and `null` is the whole feature switched off (§21.2). */
export function uplinkPortOf(env: Env = process.env): number | null {
  const port = positiveInt(env[UPLINK_PORT_ENV]);
  return port === null || port > 65_535 ? null : port;
}

/** The bind address. Loopback by default, like every listener Collie opens. */
export function uplinkHostOf(env: Env = process.env): string {
  const host = env[UPLINK_HOST_ENV]?.trim();
  return host === undefined || host === "" ? "127.0.0.1" : host;
}

/** The largest frame the door accepts, derived from the upload cap so a body within the cap fits. */
export function uplinkPayloadLimit(maxUploadBytes: number): number {
  const FRAME_OVERHEAD_BYTES = 64 * 1024;
  return Math.ceil(((maxUploadBytes + FRAME_OVERHEAD_BYTES) * 4) / 3) + 16 * 1024;
}

export interface UplinkDoorDeps {
  readonly store: TrustStore;
  readonly audit: AuditLog | null;
  readonly host: string;
  readonly port: number;
  /** The lead's upload cap, in bytes. Bounds frames and buffered bodies. */
  readonly maxUploadBytes: number;
  now?: () => number;
  random?: RandomSource;
}

export interface UplinkDoor {
  /** The fetch `PeerClient` dials through for this member, or a fetch that fails before sending. */
  fetchFor(memberId: string): CrewFetch;
  /** Close the member's live connection now. The next reconnect is refused if the roster changed. */
  kill(memberId: string): void;
  /** Whether this member has a live, welcomed connection. */
  connected(memberId: string): boolean;
  stop(): Promise<void>;
  readonly port: number;
}

interface Slot {
  memberId: string | null;
  tokenHash: string | null;
  conn: Connection | null;
}

/** One upgraded socket plus the listeners the fetch registered on it. */
class Connection implements UplinkSocket {
  closed = false;
  private readonly resHandlers = new Set<(frame: Extract<UplinkFrame, { kind: "res" }>) => void>();
  private readonly closeHandlers = new Set<() => void>();
  private welcomed = false;

  constructor(
    private readonly ws: ServerWebSocket<Slot>,
    private readonly timer: ReturnType<typeof setTimeout>,
  ) {}

  /** The first frame arrived; the opening window no longer applies. */
  arm(): void {
    clearTimeout(this.timer);
  }

  markWelcomed(): void {
    this.welcomed = true;
  }

  get isWelcomed(): boolean {
    return this.welcomed;
  }

  send(frame: UplinkFrame): void {
    if (this.closed) return;
    this.ws.send(JSON.stringify(frame));
  }

  onRes(handler: (frame: Extract<UplinkFrame, { kind: "res" }>) => void): () => void {
    this.resHandlers.add(handler);
    return () => this.resHandlers.delete(handler);
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  deliverRes(frame: Extract<UplinkFrame, { kind: "res" }>): void {
    for (const handler of this.resHandlers) handler(frame);
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    for (const handler of this.closeHandlers) handler();
    this.closeHandlers.clear();
    this.resHandlers.clear();
  }

  closeSocket(): void {
    this.ws.close();
  }
}

const UNAUTHORIZED = JSON.stringify({ error: "unauthorized" });

/**
 * The member a bearer token names, found in constant time over the whole uplink roster: no return
 * before the last row, so a guess learns nothing about which token was close.
 */
function memberForToken(data: TrustStoreData | null, token: string): { memberId: string } | null {
  if (data === null) return null;
  const hash = hashToken(token);
  let found: string | null = null;
  for (const peer of data.peers) {
    if (peer.transport !== "uplink" || peer.status !== "enrolled" || peer.uplinkTokenHash === undefined) continue;
    if (secretEquals(hash, peer.uplinkTokenHash)) found = peer.memberId;
  }
  return found === null ? null : { memberId: found };
}

/** Build and bind the door. */
export function createUplinkDoor(deps: UplinkDoorDeps): UplinkDoor {
  const now = deps.now ?? ((): number => Date.now());
  const random = deps.random;
  const payloadLimit = uplinkPayloadLimit(deps.maxUploadBytes);
  const bounds: UplinkBounds = {
    headerCount: 32,
    headerNameBytes: 64,
    headerValueBytes: 8192,
    bodyChars: Math.ceil((deps.maxUploadBytes * 4) / 3) + 1024,
  };
  const connections = new Map<string, Connection>();

  const enroll = async (conn: Connection, frame: Extract<UplinkFrame, { kind: "enroll" }>): Promise<void> => {
    const spent = await commitCrewChange(deps.store, deps.audit, (data) => {
      if (data === null) return null;
      const change = consumeInvite(data, frame.token, now());
      if (change === null || change.result === null) return null;
      if (change.result.transport !== "uplink") {
        // Burned, and said so: a dialable invite is spent and enrolls nobody (§21.5).
        return { ...change, result: null };
      }
      return change;
    });
    if (spent === null || spent.transport !== "uplink") {
      conn.closeSocket();
      return;
    }
    const enrolled = await commitCrewChange(deps.store, deps.audit, (data) => {
      if (data === null) return null;
      return enrollUplinkPeer(
        data,
        { fingerprint: frame.fingerprint, certPem: frame.certPem, address: frame.address, label: frame.label ?? null },
        now(),
        random,
      );
    });
    if (enrolled === null) {
      conn.closeSocket();
      return;
    }
    answerEnrollment(conn, enrolled);
  };

  const answerEnrollment = (conn: Connection, enrolled: UplinkEnrollment): void => {
    const current = deps.store.current();
    if (current === null) {
      conn.closeSocket();
      return;
    }
    const signedAt = now();
    const answer: UplinkFrame = {
      kind: "enrolled",
      crewName: enrolled.crewName,
      crewId: enrolled.crewId,
      secret: enrolled.crewSecret,
      memberId: enrolled.memberId,
      secretGeneration: enrolled.secretGeneration,
      leadMemberId: enrolled.leadMemberId,
      leadFingerprint: enrolled.leadFingerprint,
      leadCertPem: enrolled.leadCertPem,
      uplinkToken: enrolled.uplinkToken,
      signedAt,
      signature: signUplinkEnrollment(current.self.keyPem, { tokenHash: hashToken(enrolled.uplinkToken), timestamp: signedAt }),
    };
    conn.send(answer);
    conn.closeSocket();
  };

  const server = Bun.serve({
    hostname: deps.host,
    port: deps.port,
    idleTimeout: DOOR_IDLE_S,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname !== UPLINK_PATH) return new Response("not found", { status: 404 });
      const token = bearerToken(req.headers.get("authorization"));
      if (token === null) {
        const slot: Slot = { memberId: null, tokenHash: null, conn: null };
        if (srv.upgrade(req, { data: slot })) return undefined;
        return new Response("upgrade failed", { status: 500 });
      }
      const member = memberForToken(deps.store.current(), token);
      if (member === null) return new Response(UNAUTHORIZED, { status: 401, headers: { "content-type": "application/json" } });
      const slot: Slot = { memberId: member.memberId, tokenHash: hashToken(token), conn: null };
      if (srv.upgrade(req, { data: slot })) return undefined;
      return new Response("upgrade failed", { status: 500 });
    },
    websocket: {
      // SAFETY: a type witness only. `ws.data` is the slot passed to `server.upgrade`, never this
      // value; the empty object exists so the handler's generic resolves to `Slot`.
      data: {} as Slot,
      maxPayloadLength: payloadLimit,
      open(ws) {
        const timer = setTimeout(() => ws.close(), ENROLL_WINDOW_MS);
        const conn = new Connection(ws, timer);
        ws.data.conn = conn;
      },
      message(ws, raw) {
        const conn = ws.data.conn;
        if (conn === null || typeof raw !== "string") {
          ws.close();
          return;
        }
        const frame = parseUplinkFrame(raw, bounds);
        if (frame === null) {
          ws.close();
          return;
        }
        if (ws.data.memberId === null) {
          if (frame.kind !== "enroll") {
            ws.close();
            return;
          }
          conn.arm();
          void enroll(conn, frame);
          return;
        }
        if (frame.kind === "hello") {
          conn.arm();
          conn.markWelcomed();
          const previous = connections.get(ws.data.memberId);
          if (previous !== undefined && previous !== conn) previous.closeSocket();
          connections.set(ws.data.memberId, conn);
          const current = deps.store.current();
          const welcome: UplinkFrame = {
            kind: "welcome",
            member: current?.self.memberId ?? "",
            protocol: frame.protocol,
          };
          conn.send(welcome);
          return;
        }
        if (frame.kind === "ping") {
          conn.send({ kind: "pong" });
          return;
        }
        if (frame.kind === "res") {
          conn.deliverRes(frame);
          return;
        }
        // A member sends hello, ping and res. Anything else is a fault of the connection.
        ws.close();
      },
      close(ws) {
        const conn = ws.data.conn;
        if (conn === null) return;
        conn.end();
        if (ws.data.memberId !== null && connections.get(ws.data.memberId) === conn) {
          connections.delete(ws.data.memberId);
        }
      },
    },
  });

  return {
    port: server.port ?? deps.port,
    fetchFor(memberId: string): CrewFetch {
      const conn = connections.get(memberId);
      if (conn === undefined || !conn.isWelcomed) {
        return () => Promise.reject(new UplinkNeverSent("uplink: member not connected"));
      }
      return makeUplinkFetch(conn, { inflightMax: LEAD_INFLIGHT_MAX, bodyBytesMax: deps.maxUploadBytes });
    },
    kill(memberId: string): void {
      const conn = connections.get(memberId);
      if (conn === undefined) return;
      connections.delete(memberId);
      conn.closeSocket();
    },
    connected(memberId: string): boolean {
      return connections.get(memberId)?.isWelcomed === true;
    },
    stop(): Promise<void> {
      for (const conn of connections.values()) conn.closeSocket();
      connections.clear();
      return server.stop(true);
    },
  };
}
