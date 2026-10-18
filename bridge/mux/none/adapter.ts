// NO MULTIPLEXER, BEHIND THE CONTRACT: a collie that fronts no terminals at all.
//
// The named end state of ADR 0036 — "a member with no multiplexer at all … offers uploads, the
// journal, launchers and updates, and it offers no panes" — and the shape a public-host lead needs:
// a machine whose whole job is to hold the front door and federate the members that dial in
// (CREW_PROTOCOL.md §21). Nothing is dialled, nothing is spawned, and no endpoint is read.
//
// HONEST BY CONSTRUCTION:
//
//  • **The empty census is health, not a fault.** `reachable()` is always true and `snapshot()` is
//    always the same empty, internally-consistent answer, so the engine's first poll succeeds:
//    `bridge` reads "connected", the idle cadence is earned exactly as any connected multiplexer
//    earns it, and `/api/config` publishes this adapter's all-false declaration rather than a dead
//    Herdr's capability block. A collie with a DEAD multiplexer and a collie with NO multiplexer
//    are different states, and only the second one is this adapter.
//  • **Every verb answers the contract's `unsupported`**, naming its capability — never a throw,
//    never an invented empty value. The phone hides the meaningless and explains the expected
//    (M10/06), which is exactly right for a machine with no panes to act on.
//  • **`watch()` keeps the contract's promise vacuously**: it comes up, it never pokes (nothing can
//    change out of band — there is nothing to change), and it goes down exactly once when closed.
//    The `topologyLatency` bound is 0 ms for the same reason: no out-of-band change can ever sit
//    unseen, and a vacuous truth is still a bound the adapter keeps.
//
// This adapter has no logo on purpose: there is no mark to draw for "nothing", and the port says an
// absent mark renders exactly the text it rendered before the field existed.

import { declareCapabilities } from "../capabilities.ts";
import type { MuxAdapterFactory, MuxTarget } from "../registry.ts";
import {
  muxUnsupported,
  type MuxAck,
  type MuxAdapter,
  type MuxCreatedPane,
  type MuxGrid,
  type MuxGridRequest,
  type MuxOutcome,
  type MuxSession,
  type MuxSnapshot,
  type MuxSpaceRequest,
  type MuxSubscription,
  type MuxTabRequest,
  type MuxWatchOptions,
  type MuxWorktree,
  type MuxWorktreeCreateRequest,
  type MuxWorktreeOpenRequest,
  type MuxWorktreeOpened,
  type MuxWorktreeScope,
} from "../types.ts";

export const NONE_MUX = "none";

/** What `none` always answers: zero panes, zero spaces, zero tabs — consistent by construction. */
export const EMPTY_CENSUS: MuxSnapshot = { panes: [], spaces: [], tabs: [] };

const CAPABILITIES = declareCapabilities({
  supports: [],
  topologyLatency: { kind: "bounded", ms: 0 },
  notes: {
    paneGrid: "This collie fronts no multiplexer, so there is no screen to read.",
    typeText: "This collie fronts no multiplexer, so there is no pane to type into.",
  },
});

/** The watch handle: live on creation, down exactly once on close, and never a poke in between. */
class NoneSubscription implements MuxSubscription {
  private down = false;

  constructor(private readonly options: MuxWatchOptions) {
    // Async on purpose: a caller must be able to finish wiring its own state before "the watch is
    // live" fires, exactly as it can with every adapter whose liveness arrives over a transport.
    queueMicrotask(() => {
      if (!this.down) this.options.onUp();
    });
  }

  close(): void {
    if (this.down) return;
    this.down = true;
    this.options.onDown("closed");
  }
}

/** One collie with no multiplexer behind it. Stateless; `create` may hand out the same instance. */
export class NoneMuxAdapter implements MuxAdapter {
  readonly mux = NONE_MUX;
  readonly capabilities = CAPABILITIES;
  readonly paneless = true as const;

  reachable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  snapshot(): Promise<MuxSnapshot> {
    return Promise.resolve(EMPTY_CENSUS);
  }

  refresh(): Promise<void> {
    // "An adapter whose snapshot is always a fresh round trip keeps this promise by resolving
    // immediately" — types.ts's own words, and this snapshot is as fresh as it gets.
    return Promise.resolve();
  }

  readGrid(_paneId: string, _request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> {
    return Promise.resolve(muxUnsupported("paneGrid", "This collie fronts no multiplexer."));
  }

  typeText(_paneId: string, _text: string): Promise<MuxAck> {
    return Promise.resolve(muxUnsupported("typeText", "This collie fronts no multiplexer."));
  }

  writeKeys(_paneId: string, _keys: readonly string[]): Promise<MuxAck> {
    return Promise.resolve(muxUnsupported("sendKeys", "This collie fronts no multiplexer."));
  }

  renamePane(_paneId: string, _label: string | null): Promise<MuxAck> {
    return Promise.resolve(muxUnsupported("renamePane", "This collie fronts no multiplexer."));
  }

  closePane(_paneId: string): Promise<MuxAck> {
    return Promise.resolve(muxUnsupported("closePane", "This collie fronts no multiplexer."));
  }

  setFocus(_paneId: string): Promise<MuxAck> {
    return Promise.resolve(muxUnsupported("setFocus", "This collie fronts no multiplexer."));
  }

  createTab(_request: MuxTabRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    return Promise.resolve(muxUnsupported("createTab", "This collie fronts no multiplexer."));
  }

  renameTab(_tabId: string, _label: string): Promise<MuxAck> {
    return Promise.resolve(muxUnsupported("renameTab", "This collie fronts no multiplexer."));
  }

  closeTab(_tabId: string): Promise<MuxAck> {
    return Promise.resolve(muxUnsupported("closeTab", "This collie fronts no multiplexer."));
  }

  createSpace(_request: MuxSpaceRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    return Promise.resolve(muxUnsupported("createSpace", "This collie fronts no multiplexer."));
  }

  listWorktrees(_scope: MuxWorktreeScope): Promise<MuxOutcome<readonly MuxWorktree[]>> {
    return Promise.resolve(muxUnsupported("listWorktrees", "This collie fronts no multiplexer."));
  }

  createWorktree(_request: MuxWorktreeCreateRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    return Promise.resolve(muxUnsupported("createWorktree", "This collie fronts no multiplexer."));
  }

  openWorktree(_request: MuxWorktreeOpenRequest): Promise<MuxOutcome<MuxWorktreeOpened>> {
    return Promise.resolve(muxUnsupported("openWorktree", "This collie fronts no multiplexer."));
  }

  listSessions(): Promise<MuxOutcome<readonly MuxSession[]>> {
    return Promise.resolve(muxUnsupported("listSessions", "This collie fronts no multiplexer."));
  }

  watch(options: MuxWatchOptions): MuxSubscription {
    return new NoneSubscription(options);
  }
}

export const noneMuxFactory: MuxAdapterFactory = {
  mux: NONE_MUX,
  create(_target: MuxTarget): MuxAdapter {
    return new NoneMuxAdapter();
  },
  describeTarget(_endpoint: string): string {
    return "no multiplexer — this collie fronts none";
  },
};
