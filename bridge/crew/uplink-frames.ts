// THE UPLINK FRAME CODEC — the bytes of a member's reverse connection (CREW_PROTOCOL.md §21).
//
// The uplink inverts the crew link's DIALER, not its model: the lead still asks and the member
// still answers, `PeerClient` still frames every request with §6's headers and the budgets of
// §10.1, and the member still dispatches into the same `/crew/v1/*` router its HTTPS listener
// serves. What rides here is therefore exactly what rode the pinned link, repackaged as JSON TEXT
// frames on ONE long-lived WebSocket the member opened:
//
//   hello / welcome    the member's handshake and the door's answer (§21.4)
//   enroll / enrolled  the join exchange, once, before the member holds the crew secret (§21.5)
//   req / res          one `PeerClient` dial and its answer, correlated by id (§21.3)
//   cancel             the lead's AbortController fired (§21.7)
//   ping / pong        the member's 20 s heartbeat (§21.7)
//
// THE CODEC IS PURE AND STRICT. `parseUplinkFrame` answers `null` for anything malformed — an
// unknown kind, a field of the wrong shape, a bound exceeded — and both ends treat a `null` as a
// protocol fault of the connection, never of one request. Bounds are the CALLER's (the door
// derives them from its own limits) so the codec stays injectable for tests.
//
// `more` is RESERVED on `req` and `res` and NOT BUILT: if a future transport ever needs bodies
// beyond one frame's bound, it arrives as an additive-optional continuation field here (§7.1),
// not as a second framing layer. Measured on Bun 1.4.3, multi-megabyte text frames pass in both
// directions under an explicit `maxPayloadLength`, so nothing today needs it.

import type { JsonObject, JsonValue } from "../json.ts";
export type UplinkFrame =
  | { readonly kind: "hello"; readonly protocol: number; readonly member: string; readonly version?: string }
  | { readonly kind: "welcome"; readonly member: string; readonly protocol: number; readonly version?: string }
  | {
      readonly kind: "enroll";
      readonly protocol: number;
      readonly token: string;
      readonly fingerprint: string;
      readonly certPem: string;
      readonly label?: string;
      readonly address: string;
    }
  | {
      readonly kind: "enrolled";
      readonly crewName: string;
      readonly crewId: string;
      readonly secret: string;
      readonly leadMemberId: string;
      readonly leadFingerprint: string;
      readonly leadCertPem: string;
      readonly uplinkToken: string;
      readonly signedAt: number;
      readonly signature: string;
    }
  | {
      readonly kind: "req";
      readonly id: number;
      readonly method: string;
      /** Path plus query, exactly as `/crew/v1/*` spells it: `/crew/v1/snapshot?sessions=all`. */
      readonly path: string;
      /** §6's headers, names lower-cased by the sender's `Headers`. */
      readonly headers: Readonly<Record<string, string>>;
      /** The body as base64, absent for a bodiless request. */
      readonly body?: string;
    }
  | {
      readonly kind: "res";
      readonly id: number;
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
      readonly body?: string;
    }
  | { readonly kind: "cancel"; readonly id: number }
  | { readonly kind: "ping" }
  | { readonly kind: "pong" };

/** The bounds a parser enforces. The door builds them from its own limits; tests inject their own. */
export interface UplinkBounds {
  /** The most entries a `headers` map may carry. §6's set is eleven; anything past this is a fault. */
  readonly headerCount: number;
  /** The most bytes one header NAME may carry. Header names are short ASCII tokens. */
  readonly headerNameBytes: number;
  /** The most bytes one header VALUE may carry (§6's longest is a device name or an ETag). */
  readonly headerValueBytes: number;
  /** The most base64 characters a `body` may carry, derived from the upload cap the door already has. */
  readonly bodyChars: number;
}

/** Bounds wide enough for every frame §21 defines and no wider. */
export const DEFAULT_UPLINK_BOUNDS: UplinkBounds = {
  headerCount: 32,
  headerNameBytes: 64,
  headerValueBytes: 8192,
  // 64 MiB of base64 headroom: the largest honest body is a journal read or an upload under the
  // door's own cap, and a bound nobody can reach under the caps is not a bound anyone trips.
  bodyChars: 64 * 1024 * 1024,
};

/** The member's heartbeat: how often it sends `ping` (§21.7). Also what keeps NAT mappings alive. */
export const PING_MS = 20_000;

/** The door's silence limit, in whole seconds (Bun's `idleTimeout` unit): 3 missed heartbeats. */
export const DOOR_IDLE_S = 75;

/**
 * How many requests the lead will frame to one member before refusing to frame another (§21.7).
 * The refusal is `UplinkNeverSent` — nothing was sent — so the phone reads a clean refusal, and
 * nothing queues. A constant on purpose: widening it is a protocol decision, not an operator knob.
 */
export const LEAD_INFLIGHT_MAX = 8;

/**
 * How many inbound requests a member executes at once; the frames past these within the lead's own
 * cap are answered `503 busy` immediately rather than queued (§21.7). Backpressure by refusal, the
 * same shape §10.1's budget gives a slow peer.
 */
export const MEMBER_CONCURRENCY = 4;

/** The reconnect ladder: full jitter picks uniformly in [0, step], capped by the last step. */
export const RECONNECT_MS: readonly number[] = [500, 1000, 2000, 5000, 10_000, 30_000];

/**
 * The delay before attempt `attempt` (0-based) reconnects, with `random` in [0, 1) supplying the
 * full jitter. Pure, so the schedule is testable without a clock.
 */
export function reconnectDelayMs(attempt: number, random: number): number {
  const step = RECONNECT_MS[Math.max(0, Math.min(attempt, RECONNECT_MS.length - 1))]!;
  const jitter = Math.max(0, Math.min(1, random));
  return Math.round(step * jitter);
}

const KINDS = new Set([
  "hello",
  "welcome",
  "enroll",
  "enrolled",
  "req",
  "res",
  "cancel",
  "ping",
  "pong",
]);

const MAX_ID = 2 ** 31;
const MAX_STATUS = 599;

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: JsonValue | undefined, maxBytes: number): value is string {
  if (typeof value !== "string") return false;
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes;
}

/** Parse a headers map under the bounds. Every name and value must be present and bounded. */
function parseHeaders(value: JsonValue | undefined, bounds: UplinkBounds): Record<string, string> | null {
  if (!isObject(value)) return null;
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > bounds.headerCount) return null;
  const out: Record<string, string> = {};
  for (const [name, raw] of entries) {
    if (!boundedString(name, bounds.headerNameBytes)) return null;
    if (!boundedString(raw, bounds.headerValueBytes)) return null;
    out[name] = raw;
  }
  return out;
}

/**
 * Parse one text frame, or `null` when it is not a frame this build knows and can bound.
 *
 * Strictness is the whole value: a field this function does not name is a field the other end
 * invented, and `more` aside (reserved, §21.3) an unknown field is STILL refused here — an
 * additive-optional addition to the wire arrives as a change to this parser and to §21 together.
 */
export function parseUplinkFrame(raw: string, bounds: UplinkBounds = DEFAULT_UPLINK_BOUNDS): UplinkFrame | null {
  let parsed: JsonValue;
  try {
    // SAFETY: `JSON.parse` returns a JSON value by definition; `JsonValue` is the name for that type.
    parsed = JSON.parse(raw) as JsonValue;
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  // Reserved (§21.3): a future continuation field. Present frames never carry it.
  if (parsed.more !== undefined) return null;
  const kind = parsed.kind;
  if (typeof kind !== "string" || !KINDS.has(kind)) return null;

  if (kind === "ping" || kind === "pong") {
    const frame: UplinkFrame = { kind };
    return frame;
  }

  if (kind === "hello" || kind === "welcome") {
    const protocol = parsed.protocol;
    const member = parsed.member;
    if (typeof protocol !== "number" || !Number.isInteger(protocol) || protocol <= 0) return null;
    if (typeof member !== "string" || member.length === 0 || member.length > 64) return null;
    const version = parsed.version;
    if (version !== undefined && (typeof version !== "string" || version.length > 64)) return null;
    if (version === undefined) return { kind, protocol, member };
    return { kind, protocol, member, version };
  }

  if (kind === "cancel") {
    const id = parsed.id;
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0 || id > MAX_ID) return null;
    return { kind, id };
  }

  if (kind === "req") {
    const id = parsed.id;
    const method = parsed.method;
    const path = parsed.path;
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0 || id > MAX_ID) return null;
    if (typeof method !== "string" || !/^[A-Za-z]{1,16}$/u.test(method)) return null;
    if (typeof path !== "string" || !path.startsWith("/") || Buffer.byteLength(path, "utf8") > 2048) return null;
    const headers = parseHeaders(parsed.headers, bounds);
    if (headers === null) return null;
    const body = parsed.body;
    if (body !== undefined && (typeof body !== "string" || body.length === 0 || body.length > bounds.bodyChars)) {
      return null;
    }
    if (body === undefined) return { kind, id, method, path, headers };
    return { kind, id, method, path, headers, body };
  }

  if (kind === "res") {
    const id = parsed.id;
    const status = parsed.status;
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0 || id > MAX_ID) return null;
    if (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status > MAX_STATUS) return null;
    const headers = parseHeaders(parsed.headers, bounds);
    if (headers === null) return null;
    const body = parsed.body;
    if (body !== undefined && (typeof body !== "string" || body.length === 0 || body.length > bounds.bodyChars)) {
      return null;
    }
    if (body === undefined) return { kind, id, status, headers };
    return { kind, id, status, headers, body };
  }

  if (kind === "enroll") {
    const protocol = parsed.protocol;
    const token = parsed.token;
    const fingerprint = parsed.fingerprint;
    const certPem = parsed.certPem;
    const label = parsed.label;
    const address = parsed.address;
    if (typeof protocol !== "number" || !Number.isInteger(protocol) || protocol <= 0) return null;
    if (typeof token !== "string" || token.length === 0 || token.length > 512) return null;
    if (typeof fingerprint !== "string" || fingerprint.length === 0 || fingerprint.length > 128) return null;
    if (typeof certPem !== "string" || certPem.length === 0 || certPem.length > 8192) return null;
    if (label !== undefined && (typeof label !== "string" || label.length > 64)) return null;
    if (typeof address !== "string" || address.length === 0 || address.length > 2048) return null;
    if (label === undefined) return { kind, protocol, token, fingerprint, certPem, address };
    return { kind, protocol, token, fingerprint, certPem, address, label };
  }

  // kind === "enrolled" — every other kind returned above, and one that did not is not a frame.
  if (kind !== "enrolled") return null;
  const crewName = parsed.crewName;
  const crewId = parsed.crewId;
  const secret = parsed.secret;
  const leadMemberId = parsed.leadMemberId;
  const leadFingerprint = parsed.leadFingerprint;
  const leadCertPem = parsed.leadCertPem;
  const uplinkToken = parsed.uplinkToken;
  const signedAt = parsed.signedAt;
  const signature = parsed.signature;
  if (typeof crewName !== "string" || crewName.length === 0 || crewName.length > 64) return null;
  if (typeof crewId !== "string" || crewId.length === 0 || crewId.length > 128) return null;
  if (typeof secret !== "string" || secret.length === 0 || secret.length > 512) return null;
  if (typeof leadMemberId !== "string" || leadMemberId.length === 0 || leadMemberId.length > 64) return null;
  if (typeof leadFingerprint !== "string" || leadFingerprint.length === 0 || leadFingerprint.length > 128) return null;
  if (typeof leadCertPem !== "string" || leadCertPem.length === 0 || leadCertPem.length > 8192) return null;
  if (typeof uplinkToken !== "string" || uplinkToken.length === 0 || uplinkToken.length > 512) return null;
  if (typeof signedAt !== "number" || !Number.isFinite(signedAt)) return null;
  if (typeof signature !== "string" || signature.length === 0 || signature.length > 512) return null;
  return { kind, crewName, crewId, secret, leadMemberId, leadFingerprint, leadCertPem, uplinkToken, signedAt, signature };
}

/** Encode one frame. The inverse of {@link parseUplinkFrame} over every frame this build sends. */
export function encodeUplinkFrame(frame: UplinkFrame): string {
  return JSON.stringify(frame);
}
