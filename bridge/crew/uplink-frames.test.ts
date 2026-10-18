import { describe, expect, test } from "bun:test";

import {
  DEFAULT_UPLINK_BOUNDS,
  encodeUplinkFrame,
  parseUplinkFrame,
  RECONNECT_MS,
  reconnectDelayMs,
  type UplinkBounds,
  type UplinkFrame,
} from "./uplink-frames.ts";

// The codec of the uplink wire (CREW_PROTOCOL.md §21.3): strict, bounded, and the inverse of
// itself. What these tests pin is the refusal boundary — a frame that is almost right is not a
// frame — and the reconnect ladder, which is pure so it can be proven without a clock.

/** The bounds the door actually uses, so a test that tightens one names which. */
function bounds(over: Partial<UplinkBounds> = {}): UplinkBounds {
  return { ...DEFAULT_UPLINK_BOUNDS, ...over };
}

describe("parseUplinkFrame", () => {
  test("every frame this build sends round-trips", () => {
    const frames: UplinkFrame[] = [
      { kind: "ping" },
      { kind: "pong" },
      { kind: "hello", protocol: 2, member: "peer-1" },
      { kind: "hello", protocol: 2, member: "peer-1", version: "1.22.5" },
      { kind: "welcome", member: "lead-1", protocol: 2, version: "1.22.5" },
      { kind: "cancel", id: 7 },
      {
        kind: "req",
        id: 1,
        method: "GET",
        path: "/crew/v1/snapshot?sessions=all",
        headers: { authorization: "Bearer secret" },
      },
      {
        kind: "req",
        id: 2,
        method: "POST",
        path: "/crew/v1/pane/abc/reply",
        headers: { "content-type": "application/json" },
        body: Buffer.from("hello").toString("base64"),
      },
      { kind: "res", id: 1, status: 304, headers: { etag: '"abc"' } },
      { kind: "res", id: 2, status: 200, headers: { etag: '"abc"' }, body: "e30=" },
      {
        kind: "enroll",
        protocol: 2,
        token: "tok",
        fingerprint: "fp",
        certPem: "-----BEGIN CERTIFICATE-----\nMII\n-----END CERTIFICATE-----",
        address: "https://collie.example.com",
        label: "laptop",
      },
      {
        kind: "enrolled",
        crewName: "home",
        crewId: "crew-1",
        secret: "secret",
        memberId: "laptop",
        secretGeneration: 1,
        leadMemberId: "lead-1",
        leadFingerprint: "fp",
        leadCertPem: "pem",
        uplinkToken: "token",
        signedAt: 1_700_000_000_000,
        signature: "sig",
      },
    ];
    for (const frame of frames) {
      expect(parseUplinkFrame(encodeUplinkFrame(frame)), frame.kind).toEqual(frame);
    }
  });

  test("not JSON, not an object, and an unknown kind are refused", () => {
    expect(parseUplinkFrame("")).toBeNull();
    expect(parseUplinkFrame("not json")).toBeNull();
    expect(parseUplinkFrame("[]")).toBeNull();
    expect(parseUplinkFrame("42")).toBeNull();
    expect(parseUplinkFrame(JSON.stringify({ kind: "stream" }))).toBeNull();
  });

  test("the reserved continuation field is refused — it is not built", () => {
    expect(parseUplinkFrame(JSON.stringify({ kind: "ping", more: true }))).toBeNull();
  });

  test("a req frame is bounded and shaped", () => {
    const good = { kind: "req", id: 1, method: "GET", path: "/crew/v1/hello", headers: { a: "b" } };
    expect(parseUplinkFrame(JSON.stringify({ ...good, id: 0 }))).toBeNull();
    expect(parseUplinkFrame(JSON.stringify({ ...good, id: 1.5 }))).toBeNull();
    expect(parseUplinkFrame(JSON.stringify({ ...good, method: "GET /" }))).toBeNull();
    expect(parseUplinkFrame(JSON.stringify({ ...good, path: "crew/v1/hello" }))).toBeNull();
    expect(parseUplinkFrame(JSON.stringify({ ...good, headers: {} }))).toBeNull();
    expect(parseUplinkFrame(JSON.stringify({ ...good, body: "" }))).toBeNull();
  });

  test("a res frame's status is an HTTP status", () => {
    const good = { kind: "res", id: 1, status: 200, headers: { a: "b" } };
    expect(parseUplinkFrame(JSON.stringify(good))?.kind).toBe("res");
    expect(parseUplinkFrame(JSON.stringify({ ...good, status: 101 }))).toBeNull();
    expect(parseUplinkFrame(JSON.stringify({ ...good, status: 600 }))).toBeNull();
  });

  test("a header map past its bounds is refused", () => {
    const frame = (headers: Record<string, string>): string =>
      JSON.stringify({ kind: "req", id: 1, method: "GET", path: "/crew/v1/hello", headers });
    expect(parseUplinkFrame(frame({ a: "b" }), bounds({ headerCount: 1 }))).not.toBeNull();
    expect(parseUplinkFrame(frame({ a: "b", c: "d" }), bounds({ headerCount: 1 }))).toBeNull();
    expect(parseUplinkFrame(frame({ ["n".repeat(65)]: "b" }), bounds({ headerNameBytes: 64 }))).toBeNull();
    expect(parseUplinkFrame(frame({ a: "v".repeat(9) }), bounds({ headerValueBytes: 8 }))).toBeNull();
  });

  test("a body past its bound is refused", () => {
    const frame = JSON.stringify({
      kind: "res",
      id: 1,
      status: 200,
      headers: { a: "b" },
      body: "abcd",
    });
    expect(parseUplinkFrame(frame, bounds({ bodyChars: 4 }))).not.toBeNull();
    expect(parseUplinkFrame(frame, bounds({ bodyChars: 3 }))).toBeNull();
  });

  test("hello and welcome require a protocol integer and a member", () => {
    expect(parseUplinkFrame(JSON.stringify({ kind: "hello", protocol: 0, member: "m" }))).toBeNull();
    expect(parseUplinkFrame(JSON.stringify({ kind: "hello", protocol: 2 }))).toBeNull();
    expect(parseUplinkFrame(JSON.stringify({ kind: "welcome", member: "m", protocol: 2.5 }))).toBeNull();
    expect(parseUplinkFrame(JSON.stringify({ kind: "hello", protocol: 2, member: "m", version: "x".repeat(65) }))).toBeNull();
  });

  test("enroll and enrolled require every field", () => {
    const enroll = { kind: "enroll", protocol: 2, token: "t", fingerprint: "f", certPem: "c", address: "a" };
    expect(parseUplinkFrame(JSON.stringify(enroll))?.kind).toBe("enroll");
    expect(parseUplinkFrame(JSON.stringify({ ...enroll, address: "" }))).toBeNull();
    const enrolled = {
      kind: "enrolled",
      crewName: "n",
      crewId: "c",
      secret: "s",
      memberId: "m",
      secretGeneration: 1,
      leadMemberId: "l",
      leadFingerprint: "f",
      leadCertPem: "p",
      uplinkToken: "t",
      signedAt: 1,
      signature: "g",
    };
    expect(parseUplinkFrame(JSON.stringify(enrolled))?.kind).toBe("enrolled");
    expect(parseUplinkFrame(JSON.stringify({ ...enrolled, signature: "" }))).toBeNull();
    expect(parseUplinkFrame(JSON.stringify({ ...enrolled, signedAt: Number.NaN }))).toBeNull();
  });
});

describe("reconnectDelayMs", () => {
  test("the ladder is the documented one, and the last step caps it", () => {
    expect(RECONNECT_MS).toEqual([500, 1000, 2000, 5000, 10_000, 30_000]);
    for (const [attempt, step] of RECONNECT_MS.entries()) {
      expect(reconnectDelayMs(attempt, 1)).toBe(step);
      expect(reconnectDelayMs(attempt, 0)).toBe(0);
    }
    expect(reconnectDelayMs(100, 1)).toBe(30_000);
  });

  test("jitter is uniform over the step and never past it", () => {
    expect(reconnectDelayMs(2, 0.5)).toBe(1000);
    expect(reconnectDelayMs(2, 2)).toBe(2000);
    expect(reconnectDelayMs(-1, 0.5)).toBe(250);
  });
});
