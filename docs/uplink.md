# Uplink members

A member can dial **out** to the lead instead of the lead dialing in. The lead runs on a
publicly reachable host, and each member opens one connection to it. The member needs no
open port, no SSH, no VPN and no Tailscale. The phone still talks only to the lead.

> **Note.** This is the crew link with the dial direction reversed. The lead still polls, budgets and
> refusals are unchanged, and a request is never replayed after a disconnect. See
> [CREW_PROTOCOL.md](../CREW_PROTOCOL.md) §21 for the contract.

## The lead

On that host, run a Collie that fronts no multiplexer and bind the uplink door:

```bash
COLLIE_MUX=none
COLLIE_SKIP_SERVE=1
COLLIE_PUBLIC_HOSTS=collie.example.com
COLLIE_ALLOWED_ORIGINS=https://collie.example.com
COLLIE_CREW_UPLINK_PORT=8791
```

`COLLIE_MUX=none` is a collie with nothing behind it: an empty, healthy census, so the phone reads
connected instead of permanently reconnecting. The door binds loopback. Your reverse proxy
terminates TLS on 443 and forwards the uplink path to it.

| Key | Default | What it does |
| --- | --- | --- |
| `COLLIE_CREW_UPLINK_PORT` | *(unset)* | The door's port. Unset binds nothing: the feature is off. |
| `COLLIE_CREW_UPLINK_HOST` | `127.0.0.1` | The address the door binds. Leave it on loopback. |
| `COLLIE_MUX` | `herdr` | `none` on a lead whose machines all dial in. |

Caddy, with the path forwarded unchanged:

```caddy
collie.example.com {
	handle /crew/v1/uplink* {
		reverse_proxy 127.0.0.1:8791
	}
	handle {
		reverse_proxy 127.0.0.1:8787
	}
}
```

> **Note.** The proxy must not strip `/crew/v1/uplink` and must not buffer the WebSocket upgrade.
> Caddy does neither. The phone's pairing, the host allow-list and an optional signed-identity gate
> (Cloudflare Access) apply to the front door exactly as they do for any lead.

Mint an invite and give the printed command to the member:

```bash
collie crew invite --uplink --address collie.example.com
```

## A member

On the member, Linux or Windows:

```bash
collie join wss://collie.example.com/crew/v1/uplink
```

Paste the token the lead printed. The member checks the lead's certificate against the fingerprint
in the token and checks the lead's signature, and it saves nothing until both hold. It then
reconnects on its own. The lead does not restart.

`ws://` is refused except to localhost, because the token would otherwise cross the network
unencrypted.

On Windows the install is `install.ps1` and the service is the Task Scheduler task `herdr.collie`.
Joining over an uplink door is the one crew verb a Windows machine may run. `crew invite`,
`crew add`, `crew deputy` and `collie promote` stay refused there.

## Revoking a member

```bash
collie crew remove <member>
```

The lead restarts and the door goes with it, which drops the member's connection. Its next
reconnect presents a token the lead no longer holds and is refused. There is a gap of a few seconds
between the revoke and the restart; the door re-checks the token on every reconnect, so a revoked
member cannot come back.

## What to expect

| | |
| --- | --- |
| Heartbeat | The member pings every 20 seconds. A silent connection is closed after 75. |
| Reconnect | The member retries forever, from half a second out to 30, with jitter. |
| A slow member | A poll gives up at the usual budget. A forwarded write gives up at 5 seconds. |
| Backpressure | The lead frames at most 8 requests to one member at a time. The member runs at most 4 and answers the rest `busy`. Nothing queues. |
| A dropped connection | In-flight requests fail. A write is reported as an unknown outcome, never retried. Re-read the pane and decide. |
| Uploads | An upload is buffered on the uplink rather than streamed, under the same size cap. |

## Boundaries

- **No deputy, no standby door, no takeover** for an uplink member. Those need a member the lead can
  dial and a door a phone can reach. Name a dialable member as deputy.
- **A member cannot dial the lead back for `crew leave`.** Leave locally: `collie crew leave` on the
  member drops its own enrollment, and `collie crew remove` on the lead drops it there.
- **One door per lead.** The door is a second listener beside the front door, and `crew status`
  shows which members use it.
