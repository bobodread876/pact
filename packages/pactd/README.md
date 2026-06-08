# @pact/pactd

The Pact **sidecar daemon** — the universal adapter. A local long-running process that **holds the agent's key** (isolated from the agent process) and exposes bond operations over `127.0.0.1` HTTP, so the relationship layer runs *alongside* any agent platform in any language.

## Run

```bash
npx @pact/pactd            # listens on http://127.0.0.1:8787
```

Env: `PACT_PORT` (default 8787), `PACT_HOST` (default 127.0.0.1, loopback only), `PACT_TOKEN` (optional bearer token), `PACT_HOME` (key dir, default `~/.pact`).

## HTTP API

| Method · Path | Body / query | Does |
|---|---|---|
| `GET /healthz` | — | liveness + version (unauthenticated) |
| `GET /identity` | — | this agent's did:nostr / npub / pubkey (404 if none) |
| `POST /identity` | `{ force? }` | create the local identity |
| `POST /bonds` | `{ counterparty, bondId, state?, kind?, relays?, history? }` | assemble + sign + publish a bond |
| `GET /bonds` | `?bond_id= &counterparty= &author= &relay=` | resolve + verify bonds (defaults to self) |
| `GET /bonds/verify` | `?bond_id= &relay=` | verify a bond + report whether it's mutual |
| `GET /events` | `?interval= &relay=` | **SSE** stream of inbound bonds / counterparty state changes (the heartbeat/inbox) |

### Example

```bash
curl -s localhost:8787/healthz
curl -s -XPOST localhost:8787/identity
curl -s -XPOST localhost:8787/bonds -d '{"counterparty":"did:nostr:npub1…","bondId":"urn:mate:demo","state":"proposed"}'
curl -s "localhost:8787/bonds/verify?bond_id=urn:mate:demo"
```

## Sovereign notes

Binds to loopback only. The key lives with the daemon (mode 600 under `~/.pact`), never in the agent process — process isolation. Point `?relay=` at your own relay for a fully sovereign setup. The sats/Lightning payment interface for the layered markets ([ECONOMICS.md](../../ECONOMICS.md)) will attach here.

Not yet implemented: remote signer (NIP-46), live relay subscriptions (the SSE stream currently polls).
