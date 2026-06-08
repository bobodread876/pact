# @pact/pactd

The Pact **sidecar daemon** — the universal adapter. A local long-running process that **holds the agent's key** (isolated from the agent process) and exposes bond operations over `127.0.0.1` HTTP, so the relationship layer runs *alongside* any agent platform in any language.

## Run

```bash
npx @pact/pactd            # listens on http://127.0.0.1:8787
```

Env: `PACT_PORT` (default 8787), `PACT_HOST` (default 127.0.0.1, loopback only), `PACT_TOKEN` (optional bearer token), `PACT_HOME` (key dir, default `~/.pact`), `PACT_NWC` (wallet-connect URI), `PACT_VERIFY_PRICE_SATS` (paid-verification price; default 0 = free).

## HTTP API

| Method · Path | Body / query | Does |
|---|---|---|
| `GET /healthz` | — | liveness + version (unauthenticated) |
| `GET /identity` | — | this agent's did:nostr / npub / pubkey (404 if none) |
| `POST /identity` | `{ force? }` | create the local identity |
| `POST /bonds` | `{ counterparty, bondId, state?, kind?, relays?, history? }` | assemble + sign + publish a bond |
| `GET /bonds` | `?bond_id= &counterparty= &author= &relay=` | resolve + verify bonds (defaults to self) |
| `GET /bonds/verify` | `?bond_id= &relay= &payment_hash=` | verify a bond + mutual check (returns **402 + invoice** if `PACT_VERIFY_PRICE_SATS` is set + wallet connected) |
| `GET /events` | `?interval= &relay=` | **SSE** stream of inbound bonds / counterparty state changes (the heartbeat/inbox) |
| `GET /wallet` | — | wallet connection status + balance (sats) |
| `POST /wallet/invoice` | `{ amountSats, description? }` | create a Lightning invoice |
| `GET /wallet/invoice` | `?payment_hash= \| ?invoice=` | look up an invoice (paid?) |
| `POST /wallet/pay` | `{ invoice }` | pay a bolt11 invoice |

### Example

```bash
curl -s localhost:8787/healthz
curl -s -XPOST localhost:8787/identity
curl -s -XPOST localhost:8787/bonds -d '{"counterparty":"did:nostr:npub1…","bondId":"urn:mate:demo","state":"proposed"}'
curl -s "localhost:8787/bonds/verify?bond_id=urn:mate:demo"
```

## Sats / Lightning (Nostr Wallet Connect)

`pactd` moves sats **non-custodially** via [NWC (NIP-47)](https://github.com/nostr-protocol/nips/blob/master/47.md): it connects to **your own** Lightning wallet over Nostr and relays signed, NIP-04-encrypted requests to it. **pactd never holds funds or wallet keys.**

Works with any **NWC-compatible wallet** — **[Phoenix](https://phoenix.acinq.co)** (verified ✓), **[Alby](https://getalby.com), [Coinos](https://coinos.io), [Primal](https://primal.net)**, etc. **Note: lnflash does not support NWC yet**, so it can't be used through this provider; a direct lnflash provider (via its API) is planned (see below).

```bash
export PACT_NWC="nostr+walletconnect://<wallet-pubkey>?relay=wss://…&secret=<hex>"
npx @pact/pactd
curl -s localhost:8787/wallet                                   # status + balance
curl -s -XPOST localhost:8787/wallet/invoice -d '{"amountSats":100,"description":"bond fee"}'
curl -s -XPOST localhost:8787/wallet/pay -d '{"invoice":"lnbc…"}'
```

This is the rail every [ECONOMICS.md](../../ECONOMICS.md) market settles on:
- **storage/relay fees** — pay relays to persist bond history
- **verification fees** — charge to verify a bond (`/wallet/invoice` gates `/bonds/verify`)
- **bonding / surety** — escrow sats against a bond (hold-invoice; future)
- **agent-labor** — pay a bonded counterparty for work (resolve their Lightning address, `/wallet/pay`)

### Paid verification (the first live market)

`GET /bonds/verify` becomes a **paid endpoint** when `PACT_VERIFY_PRICE_SATS > 0` and a wallet is connected — the verifier earns sats for the work ([L402](https://docs.lightning.engineering/the-lightning-network/l402)-style HTTP 402 flow). Free (unchanged) otherwise.

```
GET /bonds/verify?bond_id=X                      → 402 { invoice, payment_hash, price_sats }
# (client pays the invoice with their wallet)
GET /bonds/verify?bond_id=X&payment_hash=<hash>  → 200 { paid:true, mutual, bonds, … }
```

pactd issues the invoice on the operator's own wallet and gates the result on `lookup_invoice`. Run a verifier node, set a price, earn sats — the flywheel's first turn.

*(MVP limitation: the paid `payment_hash` is not yet bound to a specific `bond_id` and could be reused; a real deployment scopes it via L402 macaroon caveats.)*

This first cut ships the **rail + primitives** (invoice / pay / lookup / balance) plus **paid verification**. The other markets above build on these.

## Sovereign notes

Binds to loopback only. The key lives with the daemon (mode 600 under `~/.pact`), never in the agent process — process isolation. Point `?relay=` at your own relay for a fully sovereign setup.

Not yet implemented: **direct lnflash provider** (lnflash has no NWC yet), remote signer (NIP-46), live relay subscriptions (the SSE stream currently polls), NIP-44 NWC encryption (uses NIP-04), bonding/escrow + agent-labor market endpoints.
