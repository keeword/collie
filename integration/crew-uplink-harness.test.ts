import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { isWellFormedLocalSecret, localSecretPath } from "../bridge/local-secret.ts";
import { startFakeHerdr, type FakeHerdr } from "../bridge/crew/fake-herdr.ts";
import {
  acceptUplinkEnrollment,
  commitCrewChange,
  createTrustStore,
  CREW_PROTOCOL_VERSION,
  enrollUplinkPeer,
  mintInvite,
  selfIdentity,
} from "../bridge/crew/enrollment.ts";
import { mintIdentity } from "../bridge/crew/identity.ts";
import { TrustStore, TRUST_STORE_FILENAME } from "../bridge/crew/trust-store.ts";
import { UPLINK_PATH } from "../bridge/crew/uplink-door.ts";

// Two REAL bridges: a lead with no multiplexer and an uplink door, and a member that dials it.
// The enrollment is persisted into both trust stores before boot, so what is proven here is the
// runtime rather than the verb: the member connects outward, the lead's sweep rides that socket,
// and the lead's snapshot shows the member's pane. Nothing about the dial is faked.

const root = mkdtempSync(join(tmpdir(), "collie-uplink-harness-"));
const repoRoot = join(import.meta.dir, "..");

interface Child {
  readonly name: string;
  readonly home: string;
  readonly stateDir: string;
  port: number;
  proc: Bun.Subprocess<"ignore", "pipe", "pipe"> | null;
  log: string;
}

function makeChild(name: string): Child {
  const home = join(root, name);
  const stateDir = join(home, "state");
  mkdirSync(stateDir, { recursive: true });
  return { name, home, stateDir, port: 0, proc: null, log: "" };
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port ?? 0;
  probe.stop(true);
  if (port === 0) throw new Error("could not obtain a free port");
  return port;
}

async function waitFor(predicate: () => Promise<boolean>, budgetMs: number, message: () => string): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(150);
  }
  throw new Error(`timed out after ${budgetMs}ms: ${message()}`);
}

function drain(stream: ReadableStream<Uint8Array>, into: { log: string }): void {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        into.log += decoder.decode(next.value);
      }
    } catch {
      // The child went away mid-read.
    }
  })();
}

async function boot(child: Child, env: Record<string, string>): Promise<void> {
  child.port = child.port === 0 ? await freePort() : child.port;
  child.proc = Bun.spawn(["bun", "run", join(repoRoot, "bridge", "index.ts")], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: child.home,
      COLLIE_HOST: "127.0.0.1",
      COLLIE_PORT: String(child.port),
      COLLIE_STATE_DIR: child.stateDir,
      COLLIE_POLL_MS: "300",
      COLLIE_POLL_IDLE_MS: "1000",
      COLLIE_MULTI_SESSION: "0",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  child.proc.unref();
  drain(child.proc.stdout, child);
  drain(child.proc.stderr, child);
  await waitFor(() => portOpen(child.port), 20_000, () => `${child.name} did not boot:\n${child.log}`);
}

async function portOpen(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

/** The bridge's own per-start read credential, which is what a read on loopback needs (ADR 0086). */
async function localAuth(child: Child): Promise<string> {
  const path = localSecretPath(child.stateDir);
  let secret = "";
  await waitFor(
    () => {
      try {
        secret = readFileSync(path, "utf8").trim();
      } catch {
        secret = "";
      }
      return Promise.resolve(isWellFormedLocalSecret(secret));
    },
    10_000,
    () => `${child.name} never wrote its local secret`,
  );
  return secret;
}

describe("an uplink member, end to end", () => {
  const lead = makeChild("lead");
  const member = makeChild("member");
  let herdr: FakeHerdr | null = null;
  let memberId = "";

  afterAll(async () => {
    lead.proc?.kill();
    member.proc?.kill();
    herdr?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  test("the lead shows the member's pane through the connection the member opened", async () => {
    const leadIdentity = mintIdentity({ commonName: "collie-lead" });
    const memberIdentity = mintIdentity({ commonName: "collie-member" });
    const uplinkPort = await freePort();

    // Both stores are built from the real enrollment, then written before either bridge boots: the
    // lead's door and the member's client both read the store once, at boot.
    const leadStore = new TrustStore(lead.stateDir);
    await leadStore.update(() => ({ next: createTrustStore(selfIdentity("lead", leadIdentity, Date.now())), result: true }));
    await commitCrewChange(leadStore, null, (data) => (data === null ? null : mintInvite(data, { now: Date.now() })));
    const enrolled = await commitCrewChange(leadStore, null, (data) =>
      data === null
        ? null
        : enrollUplinkPeer(
            data,
            { fingerprint: memberIdentity.fingerprint, certPem: memberIdentity.certPem, address: "https://collie.example.com", label: "member" },
            Date.now(),
          ),
    );
    expect(enrolled).not.toBeNull();
    memberId = enrolled!.memberId;

    const memberStore = new TrustStore(member.stateDir);
    await memberStore.update(() => ({ next: createTrustStore(selfIdentity("member", memberIdentity, Date.now())), result: true }));
    await commitCrewChange(memberStore, null, (data) =>
      data === null
        ? null
        : acceptUplinkEnrollment(data, enrolled!, `ws://127.0.0.1:${uplinkPort}${UPLINK_PATH}`, Date.now()),
    );
    // TrustStore writes through its own path; the file is what the child reads.
    expect(readFileSync(join(lead.stateDir, TRUST_STORE_FILENAME), "utf8")).toContain("uplink");

    const socketPath = join(member.home, "herdr.sock");
    herdr = startFakeHerdr({
      socketPath,
      workspaceLabel: "member",
      panes: [{ paneId: "p1", tabId: "t1", workspaceId: "w1", label: "member", text: "uplink member pane" }],
    });

    await boot(lead, {
      COLLIE_MUX: "none",
      COLLIE_CREW_UPLINK_PORT: String(uplinkPort),
      COLLIE_CREW_UPLINK_HOST: "127.0.0.1",
    });
    await boot(member, { HERDR_SOCKET_PATH: socketPath });

    const secret = await localAuth(lead);
    interface PaneRow { paneId: string; host?: string }
    interface SnapshotBody { servers?: { id: string }[]; agents?: PaneRow[]; shellPanes?: PaneRow[] }
    const loadSnapshot = async (): Promise<SnapshotBody | null> => {
      const res = await fetch(`http://127.0.0.1:${lead.port}/api/snapshot`, {
        headers: { authorization: `Bearer ${secret}` },
      });
      if (!res.ok) return null;
      // SAFETY: the body is the lead's own `/api/snapshot`, JSON by contract; the fields read below are
      // each checked for their shape before use.
      const body = (await res.json()) as SnapshotBody;
      return body;
    };
    await waitFor(
      async () => (await loadSnapshot())?.servers?.some((server) => server.id === memberId) === true,
      25_000,
      () => `the member never appeared in the lead's snapshot.\nlead:\n${lead.log}\nmember:\n${member.log}`,
    );

    // The pane read needs the member's multiplexer, which the fake Herdr serves over a unix socket.
    // On Windows the bridge dials a named pipe instead, so the pane half is proven on the Linux CI
    // lane; the server row above is the uplink itself and holds on both.
    if (process.platform !== "win32") {
      // The pane row arrives on the sweep AFTER the server row, so this is a wait, not one read.
      let lastBody: SnapshotBody | null = null;
      const panePresent = async (): Promise<boolean> => {
        lastBody = await loadSnapshot();
        return [...(lastBody?.agents ?? []), ...(lastBody?.shellPanes ?? [])].some(
          (candidate) => candidate.host === memberId,
        );
      };
      await waitFor(
        panePresent,
        15_000,
        () =>
          `the member's pane never merged.\nsnapshot: ${JSON.stringify(lastBody)}\n` +
          `lead:\n${lead.log}\nmember:\n${member.log}`,
      );
      const body = lastBody!;
      const pane = [...(body.agents ?? []), ...(body.shellPanes ?? [])].find(
        (candidate) => candidate.host === memberId,
      )!;
      const read = await fetch(`http://127.0.0.1:${lead.port}/api/pane/${pane!.paneId}?host=${memberId}`, {
        headers: { authorization: `Bearer ${secret}` },
      });
      expect(read.status).toBe(200);
      expect(await read.text()).toContain("uplink member pane");
    }
    // The protocol integer did not move: the member speaks 2, like everything else.
    expect(CREW_PROTOCOL_VERSION).toBe(2);
  }, 60_000);
});
