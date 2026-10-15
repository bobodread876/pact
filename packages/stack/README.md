# pact-stack

One-command **sovereign self-host** of Pact: `pactd` + your **own** Nostr relay, on your own box. The same bundle is wrapped for one-click installation on personal-server platforms (**Umbrel**, **Start9**).

## Generic Docker (any machine / VPS)

```bash
git clone https://github.com/bobodread876/pact && cd pact/packages/stack
cp .env.example .env          # optional: set PACT_NWC, PACT_VERIFY_PRICE_SATS
docker compose up -d
curl -s localhost:8787/healthz
```

This **pulls the published multi-arch `pactd` image** (no source build), pinned to the pactd release the compose was written for, and runs it alongside a bundled `pact-relay` (a multi-arch [strfry](https://github.com/hoytech/strfry) with a baked-in Pact config). `pactd` defaults `PACT_RELAYS` to the local relay (`ws://relay:7777`), so your bonds can live entirely on your machine. `pactd` is exposed on host **loopback only**.

**Access token.** Inside the container pactd binds `0.0.0.0`, so when `PACT_TOKEN` is empty it generates a token on first boot. Read it with `docker compose exec pactd cat /data/.pact/token` and unlock the UI with it (or open `http://localhost:8787/#token=<token>`). The token is never written into the UI page.

Config (`.env`, see `.env.example`): `PACT_HOST_PORT` (host port, default 8787 — change it if 8787 is taken), `PACT_RELAYS` (default the bundled relay; a relay set saved from the UI takes precedence), `PACT_NWC` (Nostr Wallet Connect URI for non-custodial sats; a wallet connected or disconnected in the UI takes precedence), `PACT_VERIFY_PRICE_SATS` (paid-verification price), `PACT_TOKEN` (bearer auth; generated when empty), `PACT_INTENT_SEEKING` / `PACT_INTENT_ABOUT` (opt-in: publish a bond intent at install so the node appears on the open board; empty by default — see [Discovery is opt-in](../pactd/README.md#discovery-is-opt-in)). Every pactd variable is documented in the [pactd README](../pactd/README.md#configuration).

Build `pactd` from source instead of pulling:
```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

## One-click: personal servers

| Platform | Status | Path |
|---|---|---|
| **Umbrel** | community app store ([bobodread876/pact-umbrel-store](https://github.com/bobodread876/pact-umbrel-store)) | [`umbrel/`](umbrel) is the source of truth |
| **Start9 (StartOS)** | separate repo ([bobodread876/pact-startos](https://github.com/bobodread876/pact-startos)) | [`start9/`](start9) |

Both pull the **published `pactd` image**, multi-arch (`linux/amd64` + `linux/arm64`), tagged with the pactd version:

```
ghcr.io/bobodread876/pactd:<pactd version>
```

Composes pin an exact version, never `:latest`; CI fails if a compose tag, `packages/pactd/package.json` and pactd's `VERSION` disagree.

⚠️ **Make the GHCR package public** so Umbrel/Start9 can pull it without credentials:
`github.com/users/bobodread876/packages/container/pactd/settings` → *Danger Zone → Change visibility → Public*.

Releases are built by the `release` workflow: push a `pactd-v<version>` tag and it builds + pushes the multi-arch image (and npm-publishes the workspaces when `NPM_TOKEN` is configured). Manual equivalent:
```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -f packages/stack/Dockerfile -t ghcr.io/bobodread876/pactd:<version> --push .
```

Then follow the per-platform README in `umbrel/` or `start9/`.

The image ships only pact-core + pactd compiled output and their production dependencies, and runs as the unprivileged `node` user (the entrypoint takes ownership of `/data` first, so volumes from older root-run images keep working).
