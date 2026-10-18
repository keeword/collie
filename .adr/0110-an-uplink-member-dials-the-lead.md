# 0110 — An uplink member dials the lead

- **Status:** Accepted
- **Date:** 2026-10-18
- **Amends in scope:** [ADR 0075](./0075-windows-is-a-supported-host.md), the line that a Windows machine
  cannot join a crew
- **Trail:** a request for Collie with no inbound port, SSH, VPN or Tailscale on the member machines,
  the lead on a public host · the roads argued against: members opening inbound ports, running Herdr on
  that host, and a push channel (ADR 0073 and CREW_PROTOCOL.md §16 already reserve streaming and leave it
  unbuilt) · `bridge/crew/peer-client.ts` (`CrewFetch`) · `bridge/crew/uplink-door.ts` ·
  `bridge/crew/uplink-client.ts` · `bridge/mux/none/adapter.ts` ·
  [ADR 0013](./0013-a-peer-listens-without-becoming-a-front-door.md) ·
  [ADR 0028](./0028-the-standby-door-is-a-second-listener.md) ·
  [ADR 0036](./0036-the-map-of-machines-is-collies-a-mux-reports-one-machine.md) ·
  [ADR 0103](./0103-the-wire-has-two-transports-a-private-socket-or-tls-with-a-token.md)

## Context

The crew link assumes the lead can dial every member. A member behind a network with no inbound path
cannot be in a crew at all, and the obvious fixes are the wrong ones. Opening a port on the member
re-creates the front door ADR 0013 exists to avoid. Running Herdr on the public host strands the journal, the
uploads and the audit log on the wrong machine, which is the argument of ADR 0011. A push channel would
be the streaming freshness CREW_PROTOCOL.md §16 reserves and deliberately does not build.

What the code already has is a fetch-shaped seam (`CrewFetch`) and a peer surface that re-exposes the
phone's own routes. The dial direction is the only thing that has to change.

## Decision

**A member may enroll with `transport: "uplink"` and dial the lead, over a WebSocket the member
opens. The lead's existing crew machinery runs over that socket unchanged, and a lead may run
`COLLIE_MUX=none`.**

1. **The door is a second listener.** It binds `COLLIE_CREW_UPLINK_PORT` (absent means no door), on
   loopback by default, speaking plain HTTP. TLS ends at the operator's reverse proxy, which forwards
   `/crew/v1/uplink` without stripping it. This is the standby door's posture (ADR 0028), and it does
   not ride the front door: the front door does not upgrade WebSockets.
2. **The token is the pairwise factor.** Each uplink member holds a 256-bit token, minted at
   enrollment and stored by the lead as a SHA-256 only. It is presented once, on the connection. The
   crew secret still rides every frame and the member's admission still checks it per frame, so the
   two factors of CREW_PROTOCOL.md §8.1 keep their jobs and change their carriers. Revocation is
   `crew remove`: the lead restarts, the door drops the connection, and the token no longer matches.
3. **The enrollment answer is signed.** The joiner holds no pin yet, so the lead signs the answer and
   the joiner verifies it against the certificate named by the invite before saving anything. There is
   no certificate pin on the WebSocket client; this signature is what stands in for it, and the gap is
   named here rather than papered over.
4. **Nothing about the model changes.** The lead polls (§10.1), the budgets are unchanged, a request
   that cannot be framed fails before it is sent, and a socket that dies with requests in flight
   reports them unknowable and replays nothing (§10.3). The member caps its own concurrency and
   answers the overflow `busy`. Uploads are buffered rather than streamed, under the same cap.
5. **`COLLIE_MUX=none` is a collie with no multiplexer.** Its census is empty and healthy, and every
   pane verb answers `unsupported` by name. This is the member with no multiplexer that ADR 0036 named
   and left unbuilt. A lead runs it so its own machine reads connected instead of broken.
6. **Windows may join and may not lead.** A Windows machine may `collie join` an uplink door, because
   the member opens nothing. The verbs that lead, add or reshape a crew stay refused (ADR 0075). The
   deputy, the standby door and takeover are not available for an uplink member: they need a member
   the lead can dial.

## Consequences

- A crew no longer requires inbound reachability on every member. The lead must be reachable, and the
  operator's proxy is the TLS boundary.
- The door is a new listener and a new credential. It is off unless the port is set, it binds loopback,
  and the token is hashed at rest on the lead. A leaked lead store yields a hash, not a token.
- An uplink member cannot be a deputy and cannot be dialled for `crew leave`. Leave happens locally on
  the member and by `crew remove` on the lead.
- Admission on the member is the existing crew handler. The frame carries the headers a dial would
  have, including the dial attestation, so there is no second admission path to drift.
- Revisit this if a host cannot terminate TLS in front of the door, or if uplink members need the
  deputy. Both are additive: a native TLS listener would be a new door, and a dialable deputy already
  works beside uplink members.
