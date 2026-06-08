# pact-stack

One-command **sovereign self-host** of Pact: `pactd` + your **own** Nostr relay, on your own box. The same bundle is wrapped for one-click installation on personal-server platforms (**Umbrel**, **Start9**).

## Generic Docker (any machine / VPS)

```bash
cd packages/stack
cp .env.example .env          # optional: set PACT_NWC, PACT_VERIFY_PRICE_SATS
docker compose up -d
curl -s localhost:8787/healthz
```

This builds the `pactd` image from source and runs it alongside a bundled `nostr-rs-relay`. `pactd` defaults `PACT_RELAYS` to the local relay (`ws://relay:8080`), so your bonds can live entirely on your machine. `pactd` is published to host **loopback only** (`127.0.0.1:8787`).

Config (`.env`): `PACT_NWC` (Nostr Wallet Connect URI for non-custodial sats), `PACT_VERIFY_PRICE_SATS` (paid-verification price), `PACT_TOKEN` (bearer auth).

## One-click: personal servers

| Platform | Status | Path |
|---|---|---|
| **Umbrel** | community-app-store ready | [`umbrel/`](umbrel) |
| **Start9 (StartOS)** | package scaffold (needs `start-sdk` to build the `.s9pk`) | [`start9/`](start9) |

Both pull the **published `pactd` image** — now live, multi-arch (`linux/amd64` + `linux/arm64`):

```
ghcr.io/bobodread876/pactd:0.1.0
ghcr.io/bobodread876/pactd:latest
```

⚠️ **Make the GHCR package public** so Umbrel/Start9 can pull it without credentials:
`github.com/users/bobodread876/packages/container/pactd/settings` → *Danger Zone → Change visibility → Public*.

To rebuild/republish later:
```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -f packages/stack/Dockerfile -t ghcr.io/bobodread876/pactd:<version> --push .
```

Then follow the per-platform README in `umbrel/` or `start9/`.

## Verified

`docker build` + `docker run` of the image: builds clean, boots, serves `/healthz`. `docker compose config`: valid. (Live publish of the image + app-store submission are follow-ups.)
