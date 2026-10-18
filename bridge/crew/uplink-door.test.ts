import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { commitCrewChange, createTrustStore, enrollUplinkPeer, mintInvite, selfIdentity } from "./enrollment.ts";
import { CREW, material } from "./fixtures.ts";
import { hashToken } from "./identity.ts";
import { verifyUplinkEnrollment } from "./signing.ts";
import { TrustStore } from "./trust-store.ts";
import { encodeUplinkFrame, parseUplinkFrame, type UplinkFrame } from "./uplink-frames.ts";
import { createUplinkDoor, UPLINK_PATH, uplinkDoorEnabled, type UplinkDoor } from "./uplink-door.ts";
import { UplinkNeverSent } from "./uplink-fetch.ts";

// The door over a real socket: a scratch trust store, an OS-chosen port, and Bun's own WebSocket
// client. What this pins is admission (the token, constant-time and uniform), the enrollment
// exchange (the signed answer, the burned invite), and that a live connection actually carries a
// request.

const dirs: string[] = [];

function scratchStore(): TrustStore {
  const dir = mkdtempSync(join(tmpdir(), "collie-uplink-"));
  dirs.push(dir);
  return new TrustStore(dir);
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A lead with an identity and a crew, ready to mint invites and enroll members. */
async function leadStore(): Promise<TrustStore> {
  const store = scratchStore();
  const identity = createTrustStore(selfIdentity("desk", material("desk"), Date.now()));
  await store.update(() => ({ next: { ...identity, crew: CREW }, result: true }));
  return store;
}

async function startDoor(store: TrustStore): Promise<UplinkDoor> {
  return createUplinkDoor({ store, audit: null, host: "127.0.0.1", port: 0, maxUploadBytes: 1024 * 1024 });
}

function openSocket(port: number, token?: string): Promise<WebSocket> {
  const url = `ws://127.0.0.1:${port}${UPLINK_PATH}`;
  const options = token === undefined ? undefined : { headers: { authorization: `Bearer ${token}` } };
  // SAFETY: Bun's client constructor accepts `{ headers }` (verified on Bun 1.4.3). The DOM typing of
  // the same global only knows subprotocols, so the constructor is narrowed to the Bun signature.
  const connect = WebSocket as new (address: string, opts?: Bun.WebSocketOptions) => WebSocket;
  const ws = new connect(url, options);
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", () => reject(new Error("connection refused")));
  });
}

function nextFrame(ws: WebSocket): Promise<UplinkFrame | null> {
  return new Promise((resolve) => {
    ws.addEventListener("message", (ev) => resolve(parseUplinkFrame(String(ev.data))), { once: true });
    ws.addEventListener("close", () => resolve(null), { once: true });
  });
}

describe("uplinkDoorEnabled", () => {
  test("a solo collie with a store binds, because the first member joins through the door", () => {
    expect(uplinkDoorEnabled("solo", 8791, true)).toBe(true);
    expect(uplinkDoorEnabled("lead", 8791, true)).toBe(true);
  });

  test("a peer never binds, and no port or no store binds nothing", () => {
    expect(uplinkDoorEnabled("peer", 8791, true)).toBe(false);
    expect(uplinkDoorEnabled("lead", null, true)).toBe(false);
    expect(uplinkDoorEnabled("solo", 8791, false)).toBe(false);
  });
});

describe("the uplink door", () => {
  test("a wrong token is refused and a right one is welcomed", async () => {
    const store = await leadStore();
    const enrolled = (await commitCrewChange(store, null, (data) =>
      data === null
        ? null
        : enrollUplinkPeer(data, { fingerprint: material("nas").fingerprint, certPem: material("nas").certPem, address: "https://collie.example.com", label: "nas" }, Date.now()),
    ))!;
    const door = await startDoor(store);
    try {
      await expect(openSocket(door.port, "not-the-token")).rejects.toThrow("connection refused");
      const ws = await openSocket(door.port, enrolled.uplinkToken);
      const welcomed = nextFrame(ws);
      ws.send(encodeUplinkFrame({ kind: "hello", protocol: 2, member: enrolled.memberId }));
      const frame = await welcomed;
      expect(frame?.kind).toBe("welcome");
      if (frame?.kind === "welcome") expect(frame.member).toBe("desk");
      expect(door.connected(enrolled.memberId)).toBe(true);
      ws.close();
    } finally {
      await door.stop();
    }
  });

  test("an uplink invite enrolls the member and the answer verifies", async () => {
    const store = await leadStore();
    const minted = (await commitCrewChange(store, null, (data) =>
      data === null ? null : mintInvite(data, { now: Date.now(), transport: "uplink", label: "laptop" }),
    ))!;
    const door = await startDoor(store);
    try {
      const ws = await openSocket(door.port);
      const answered = nextFrame(ws);
      const laptop = material("laptop");
      ws.send(encodeUplinkFrame({
        kind: "enroll",
        protocol: 2,
        token: minted.token,
        fingerprint: laptop.fingerprint,
        certPem: laptop.certPem,
        address: "https://collie.example.com",
        label: "laptop",
      }));
      const frame = await answered;
      expect(frame?.kind).toBe("enrolled");
      if (frame?.kind !== "enrolled") return;
      expect(verifyUplinkEnrollment(frame.leadCertPem, frame.signature, {
        tokenHash: hashToken(frame.uplinkToken),
        timestamp: frame.signedAt,
      })).toBe(true);
      const member = store.current()?.peers.find((peer) => peer.transport === "uplink");
      expect(member?.uplinkTokenHash).toBe(hashToken(frame.uplinkToken));
      expect(member?.address).toBe("https://collie.example.com");
      // The invite is spent.
      expect(store.current()?.invites ?? []).toHaveLength(0);
      ws.close();
    } finally {
      await door.stop();
    }
  });

  test("a dialable invite is burned and enrolls nobody", async () => {
    const store = await leadStore();
    const minted = (await commitCrewChange(store, null, (data) =>
      data === null ? null : mintInvite(data, { now: Date.now(), label: "laptop" }),
    ))!;
    const door = await startDoor(store);
    try {
      const ws = await openSocket(door.port);
      const closed = new Promise((resolve) => ws.addEventListener("close", () => resolve("closed"), { once: true }));
      const laptop = material("laptop");
      ws.send(encodeUplinkFrame({
        kind: "enroll",
        protocol: 2,
        token: minted.token,
        fingerprint: laptop.fingerprint,
        certPem: laptop.certPem,
        address: "https://collie.example.com",
      }));
      expect(await closed).toBe("closed");
      expect(store.current()?.peers ?? []).toHaveLength(0);
      expect(store.current()?.invites ?? []).toHaveLength(0);
    } finally {
      await door.stop();
    }
  });

  test("a request rides the connection, and a dead one sends nothing", async () => {
    const store = await leadStore();
    const enrolled = (await commitCrewChange(store, null, (data) =>
      data === null
        ? null
        : enrollUplinkPeer(data, { fingerprint: material("nas").fingerprint, certPem: material("nas").certPem, address: "https://collie.example.com", label: "nas" }, Date.now()),
    ))!;
    const door = await startDoor(store);
    try {
      await expect(door.fetchFor(enrolled.memberId)("https://collie.example.com/crew/v1/hello", {})).rejects.toBeInstanceOf(
        UplinkNeverSent,
      );
      const ws = await openSocket(door.port, enrolled.uplinkToken);
      ws.addEventListener("message", (ev) => {
        const frame = parseUplinkFrame(String(ev.data));
        if (frame?.kind !== "req") return;
        ws.send(encodeUplinkFrame({
          kind: "res",
          id: frame.id,
          status: 200,
          headers: { etag: '"snap"' },
          body: Buffer.from('{"ok":true}').toString("base64"),
        }));
      });
      const welcomed = nextFrame(ws);
      ws.send(encodeUplinkFrame({ kind: "hello", protocol: 2, member: enrolled.memberId }));
      expect((await welcomed)?.kind).toBe("welcome");
      const res = await door.fetchFor(enrolled.memberId)("https://collie.example.com/crew/v1/snapshot?sessions=all", {
        method: "GET",
        headers: { authorization: "Bearer crew-secret" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("etag")).toBe('"snap"');
      expect(await res.json()).toEqual({ ok: true });
      door.kill(enrolled.memberId);
      expect(door.connected(enrolled.memberId)).toBe(false);
    } finally {
      await door.stop();
    }
  });

  test("concurrent dials share one id space, so an answer never crosses a request", async () => {
    const store = await leadStore();
    const enrolled = (await commitCrewChange(store, null, (data) =>
      data === null
        ? null
        : enrollUplinkPeer(data, { fingerprint: material("nas").fingerprint, certPem: material("nas").certPem, address: "https://collie.example.com", label: "nas" }, Date.now()),
    ))!;
    const door = await startDoor(store);
    try {
      const ws = await openSocket(door.port, enrolled.uplinkToken);
      const seen: number[] = [];
      ws.addEventListener("message", (ev) => {
        const frame = parseUplinkFrame(String(ev.data));
        if (frame?.kind !== "req") return;
        seen.push(frame.id);
        const answer: Extract<UplinkFrame, { kind: "res" }> = {
          kind: "res",
          id: frame.id,
          status: 200,
          // A real answer always carries headers; a headerless frame is refused by the parser.
          headers: { "content-type": "text/plain" },
          body: Buffer.from(`path:${frame.path}`).toString("base64"),
        };
        // The FIRST request is held back so the second answer lands first: a per-dial id space
        // (every fetch numbering from 1 again) would hand each caller the other's body.
        if (seen.length === 1) setTimeout(() => ws.send(encodeUplinkFrame(answer)), 30);
        else ws.send(encodeUplinkFrame(answer));
      });
      const welcomed = nextFrame(ws);
      ws.send(encodeUplinkFrame({ kind: "hello", protocol: 2, member: enrolled.memberId }));
      expect((await welcomed)?.kind).toBe("welcome");

      // §6 headers, as a real dial always carries them (the parser refuses a headerless frame), and a
      // fetch PER DIAL, as the bridge asks for one (index.ts's fetchFor callback): the bug this pins
      // was a fresh id space per fetch, so two concurrent dials both numbered their requests 1.
      const init = { method: "GET", headers: { authorization: "Bearer crew-secret" } };
      const [slow, fast] = await Promise.all([
        door.fetchFor(enrolled.memberId)("https://collie.example.com/crew/v1/snapshot", init),
        door.fetchFor(enrolled.memberId)("https://collie.example.com/crew/v1/api/launchers", init),
      ]);
      expect(seen.length).toBe(2);
      expect(seen[0]).not.toBe(seen[1]);
      expect(await slow.text()).toBe("path:/crew/v1/snapshot");
      expect(await fast.text()).toBe("path:/crew/v1/api/launchers");
      ws.close();
    } finally {
      await door.stop();
    }
  });
});
