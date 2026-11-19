# just-a-portal

Send files between your computers over Tailscale, from a browser tab.

- Works only while Tailscale is connected on **both** computers. If either side is stopped or logged
  out, nothing is sent. If either drops mid-transfer, the transfer aborts on both ends and the partial
  file is deleted.
- Encrypted twice: Tailscale's WireGuard tunnel, plus a fresh AES-256-GCM key per transfer
  (ephemeral X25519 key exchange). Every 1 MiB chunk is authenticated, and the SHA-256 of the file
  is checked on both ends.
- The receiver must click **Accept**. Files land in `~/Downloads/just-a-portal` and never overwrite
  anything.
- No runtime dependencies. Needs [Bun](https://bun.sh) 1.4+ and the Tailscale app on each computer (macOS, Windows, Linux).

## Run

On each computer, either grab the single-file build from [portal.ruxera.com](https://portal.ruxera.com),
which shows the checksum-checked commands for macOS, Linux and Windows. Run it from its own folder with
`bun --no-env-file portal.js`: Bun otherwise loads a `.env` (and `bunfig.toml`) from the current folder,
which could change the portal's settings.

or run from a checkout:

```sh
bun src/main.js        # or: bun start
```

It opens a browser tab with a link like `http://127.0.0.1:7777/#k=…`. That link carries a private
session key, so don't share it. Pick a device, drop a file, and accept it on the other computer.

## How it works

| Port | Listens on | Purpose |
|---|---|---|
| 7777 | `127.0.0.1` only | the web UI for this computer |
| 7778 | this computer's Tailscale IP only | receives files from other portals |

The sender binds its outgoing connection to its own Tailscale IP. If Tailscale is down, that address
doesn't exist, so the connection fails instead of going out over the LAN. The receiver checks each
incoming connection with `tailscale whois`, and by default only accepts devices owned by the
same Tailscale user. See [docs/DESIGN.md](docs/DESIGN.md) for the full design.

## Settings (environment variables)

| Variable | Default |
|---|---|
| `PORTAL_UI_PORT` | `7777` |
| `PORTAL_PEER_PORT` | `7778` (must match on all computers) |
| `PORTAL_DOWNLOAD_DIR` | `~/Downloads/just-a-portal` |
| `PORTAL_MAX_BYTES` | 20 GiB |
| `PORTAL_ALLOW_ANY_TAILNET_USER` | unset. Set to `1` to accept devices owned by other users on your tailnet (e.g. shared nodes) |

Optional hardening: in your tailnet ACLs, allow TCP 7778 only between your own devices.

## Test

```sh
bun test               # unit + end-to-end tests against src/
bun run test:bundle    # builds portal.js and runs the end-to-end tests against it
```

The end-to-end tests run two portals on loopback against a fake `tailscale` CLI, covering:
connect/disconnect on either side, a disconnect mid-transfer, tampered data, identity mismatch,
another user's device, hostile filenames, and the local UI's host/origin/token checks.

## Deploy portal.ruxera.com

The site is a static download page (`site/`) plus the bundled `portal.js`, served by Cloudflare
Workers static assets. The portal itself never runs on Cloudflare. Deploys use the
[`cf` CLI](https://www.npmjs.com/package/cf), configured in `cloudflare.config.ts`. `cf` runs on
Node.js (^22.23, ^24.22 or ^26.12), so deploying needs Node installed as well as Bun; the portal
itself only needs Bun.

```sh
bun install
bunx cf auth whoami          # once: bunx cf auth login
bun run build                # bundles portal.js and writes .cloudflare/output
bunx cf deploy --prebuilt --dry-run
bun run deploy               # runs both test suites, then cf deploy --prebuilt
```
