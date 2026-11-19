# just-a-portal — design

Send files between PCs on the same Tailscale tailnet from a browser UI.

## Goals

1. Web UI to send a file to another PC on the tailnet and receive files from them.
2. No transfer is possible unless Tailscale is connected on **both** ends.
3. Transfers are encrypted and authenticated end to end.

## Architecture

Every PC runs the same Node.js app (zero npm dependencies; Node >= 22, runs on macOS / Windows / Linux).
The app opens two listeners:

| Listener | Bind address | Who talks to it |
|---|---|---|
| **UI server** | `127.0.0.1:7777` only | the local browser |
| **Peer server** | this node's Tailscale IPv4 (`100.x.y.z:7778`) only | other portal nodes, over the tailnet |

```
 Browser A ──http──▶ UI server A (127.0.0.1)            UI server B ◀──http── Browser B
                         │                                   ▲ (SSE: "incoming offer")
                         ▼                                   │
                    Peer client A ══ WireGuard (tailnet) ══▶ Peer server B (100.x only)
```

The browser never talks to the remote PC directly; it hands the file to its own local server,
which streams it to the peer's server over the tailnet.

## "Tailscale must be connected" enforcement

- `tailscale status --json` must report `BackendState == "Running"` (note: `TailscaleIPs` is still
  populated when stopped, so IPs alone are not trusted).
- The peer server binds only to the Tailscale IP. If Tailscale goes down, the app closes the peer
  listener; a watchdog re-checks every 5 s and re-binds when Tailscale is back.
- Sender checks status before an offer and before streaming; the target must be a peer listed in
  `status.Peer` with `Online == true`, and the destination address is taken from that peer's
  `TailscaleIPs` (never from free-form user input).
- Receiver checks status on every request and runs `tailscale whois` on the remote address of every
  incoming connection; requests from IPs that are not tailnet nodes are rejected (403).
- Optional allow-list: `PORTAL_ALLOW_USERS` / same-user-only by default (the remote node's
  `UserProfile.ID` must equal the local node's `UserID`, unless `PORTAL_ALLOW_ANY_TAILNET_USER=1`).

## Encryption & integrity

Layer 1 — transport: Tailscale WireGuard (Noise IK, Curve25519, ChaCha20-Poly1305). Node keys are
authenticated by the tailnet coordination server, so the peer IP genuinely identifies the device.

Layer 2 — application (defense in depth, independent of Tailscale):
- Per-transfer ephemeral X25519 key exchange (sender sends its ephemeral pubkey in the offer,
  receiver returns its ephemeral pubkey when the user accepts).
- `HKDF-SHA256(shared, salt = transferId, info = "just-a-portal v1")` → 32-byte AES-256-GCM key
  plus a 4-byte nonce prefix.
- File is split into 1 MiB chunks; each chunk is sealed with AES-256-GCM, nonce = prefix || u64 counter,
  AAD = transferId || chunkIndex || isFinal. Frame = u32 length || ciphertext || tag. Reordering,
  truncation and chunk swapping are detected; the final chunk is flagged so truncation fails.
- Whole-file SHA-256 is computed by sender and verified by receiver after decryption.
- Received data is written to a `.part` file in the download dir and renamed only after the final
  chunk and hash verify. Failure deletes the `.part`.
- Ephemeral keys are kept in memory only and dropped after the transfer.

Honest caveat: the ephemeral pubkeys are exchanged over the WireGuard channel, so layer 2's
authentication relies on Tailscale's node authentication. It protects against plaintext exposure if
the transport were ever downgraded/misconfigured (e.g. a proxy), and gives per-transfer forward
secrecy and integrity, but it is not a replacement for Tailscale identity.

## Receive flow (user must accept)

1. Sender UI: pick peer + file → `POST /api/send` (local, streamed body).
2. Sender server → `POST http://<peer-ip>:7778/v1/offer` with `{transferId, name, size, sha256?, senderPub}`.
3. Receiver server whois-checks, stores the pending offer, pushes it to its UI via SSE.
4. Receiver user clicks Accept/Decline → receiver returns its pubkey via the long-poll
   `GET /v1/offer/:id` the sender is waiting on (timeout 2 min).
5. On accept, sender streams encrypted frames to `POST /v1/data/:id`. Receiver decrypts, writes,
   verifies, responds `{ok, sha256}`.
6. Both UIs show progress via SSE.

## Local UI hardening

- UI server binds 127.0.0.1 only.
- `Host` header must be `127.0.0.1:<port>` or `localhost:<port>` (blocks DNS rebinding).
- State-changing requests require a per-run random token (`X-Portal-Token`) that the page receives
  embedded in the HTML; cross-origin pages can't read it. `Origin`, when present, must match.
- Strict CSP, no inline scripts from untrusted input, filenames rendered via `textContent`.

## Receiver file safety

- Filename sanitised: basename only, strip control chars / path separators / `..`, Windows reserved
  names, length cap; collisions get ` (1)`, ` (2)` suffixes; never overwrite.
- Max size configurable (`PORTAL_MAX_BYTES`, default 20 GiB); declared size enforced while streaming.
- Download dir: `~/Downloads/just-a-portal` (configurable via `PORTAL_DOWNLOAD_DIR`).

## Testability

`PORTAL_TAILSCALE_BIN` lets tests substitute a fake `tailscale` script, and ports are configurable, so
two instances can be exercised end-to-end on one machine with `node --test`.

## Changes after review round 1 (Sol)

Accepted and implemented:
- Sender binds `localAddress` to its own Tailscale IPv4 for every peer connection, so if Tailscale
  disappears between the status check and the connect, the connect fails instead of routing the
  traffic over another interface.
- Receiver requires: socket `localAddress` == own Tailscale IP, remote IP == a listed peer's IP,
  and `whois` StableID == that peer's ID. Each offer is bound to that StableID; the data upload must
  come from the same node. Same-user policy needs a positive numeric match on both sides.
- On disconnect or a Tailscale IP change, the watchdog destroys every peer socket and outgoing
  request, aborts in-flight pipelines, fails all non-terminal transfers and deletes `.part` files.
  Idle timeout of 30 s on every peer socket; the held-open offer trickles whitespace as a keepalive.
- One upload per acceptance (atomic state switch), accept window of 60 s, offer window of 120 s.
- The browser uploads the file body to its local server only after the receiver accepts.
- Limits: pending offers (16 total / 4 per peer), active receives (4), active sends (8), peer
  connections (32), concurrent CLI lookups (8), offer body 4 KiB, header size 8 KiB, disk-space check
  (including bytes reserved by other in-flight receives) before accepting, stale `.part` cleanup on start.
- Offer metadata (transfer id, name, size) is hashed into the HKDF info.
- Token is no longer embedded in the page: it arrives only in the URL fragment printed in the
  terminal and is kept in `sessionStorage`. The event stream uses `fetch` with a header instead of
  `EventSource`. `Origin` is required on mutations, `Sec-Fetch-Site` must be same-origin, CSP
  `frame-ancestors 'none'`, `no-store` everywhere.

Rejected:
- "Drop the app-layer encryption once WireGuard is enforced": an app on a laptop can't fully
  enforce the WireGuard path (no per-socket interface pinning from Node), so the app layer is what
  keeps a misrouted connection from carrying plaintext. It's cheap and tested, so it stays. Its
  limit is still as described above: key exchange authenticity relies on Tailscale.

## Changes after review round 2 (Sol, implementation)

Fixed (each verified by reading the code; regression tests where feasible):
- Terminal states are immutable (`update()` refuses changes once done/failed/cancelled/…). The receiver
  re-checks state after publishing and removes the file if a cancel/disconnect won the race; the
  sender's abort also destroys the in-flight request while it waits for the receiver's acknowledgement.
- Concurrent accepts: capacity and disk reservation are re-checked synchronously after the last await.
- `server.setTimeout()` on the peer server, because Node resets a kept-alive socket's timeout to
  `server.timeout` on its next request.
- Bounded lookup queue (503 when full), HTTP objects released on settlement, history capped at 200.
- Publishing: link() then a best-effort unlink (an unlink failure can no longer publish a second copy);
  the no-hard-link fallback claims the name with an exclusive placeholder and renames over it.
- Tailscale user IDs are parsed as exact decimal strings (int64 safe) and must be positive.
- CLI discovery: `TAILSCALE_BE_CLI=1` for the macOS app binary, and a Windows Program Files fallback.
- UI: placeholders have empty values and the chosen device survives reconnects (never auto-retargets);
  snapshots carry a monotonic `rev` so stale responses can't roll state back; transfers resync whenever
  the event stream reconnects; sending is gated on the peer listener being bound and the bind error is
  shown; dropped folders are detected properly and zero-byte files are allowed.

## Changes after review round 3 (Sol, fix verification)

- Receiver: if the sender's connection closes before the receiver has replied, the transfer fails
  and the published file is removed (both sides now agree on cancel/disconnect during publish).
- Accept: disk reservation counts every receive that was active at the free-space sample *or* is
  active now (conservative across the await).
- Fallback publish: a placeholder `close()` failure also removes the placeholder.
- UI: status snapshots carry a revision too, so a slow `/api/status` reply can't overwrite newer
  listener state; a local upload failure beats a same-revision server snapshot; a staged file is
  dropped when the offer is already terminal; resync drops rows the server pruned; the tab keeps at most
  200 rows.

## Changes after review round 4

- Disk check: free space minus bytes written by any receive since the sample (running counter)
  must cover all still-incoming bytes plus the new file plus a 64 MiB margin.
- Status revision also bumps on listener bind/close/bind-failure, so a status read mid-refresh is
  always older than the event that follows it.
- UI keeps the newest revision per transfer id even after a row is removed; `/api/status` returns
  `transfersRev`, and resync removes only rows that snapshot covers (`rev <= transfersRev`).

## Known limitation

The guarantee "nothing leaves this machine outside WireGuard" depends on the OS routing `100.x`
traffic into the Tailscale interface while that address is assigned. Node cannot pin a socket to an
interface, so a conflicting route (e.g. another VPN claiming the same CGNAT range) could misroute a
connection. In that case the app-layer encryption still keeps file contents from going out in
plaintext, but an active attacker on that misrouted path could substitute the ephemeral keys, because
they are not signed by a long-term device identity. Closing this fully needs device-key pinning
(trust on first use, with a fingerprint shown in the UI). That's a candidate for v2.
