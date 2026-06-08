# Pact — Start9 (StartOS) package *(scaffold)*

One-click install of `pactd` on [Start9 / StartOS](https://start9.com). Unlike Umbrel (plain YAML + compose), a StartOS package is compiled into a signed **`.s9pk`** with the **[start-sdk](https://docs.start9.com)** (StartOS 0.4.0 uses a TypeScript SDK). This directory is a **scaffold + build guide**, not a finished `.s9pk`.

## What the package wraps

- **Image:** `ghcr.io/bobodread876/pactd:latest` (publish first — see `../README.md`).
- **Main process:** `node packages/pactd/dist/index.js`, listening on `0.0.0.0:8787`.
- **Health check:** HTTP `GET /healthz` → `{ ok: true }`.
- **Persistence:** the `/data` volume (key + local bond store).
- **Config (StartOS config form → env):**
  - `PACT_RELAYS` — default to the user's own StartOS Nostr relay service if installed, else public relays.
  - `PACT_NWC` — Nostr Wallet Connect URI (non-custodial sats).
  - `PACT_VERIFY_PRICE_SATS` — paid-verification price.
  - `PACT_TOKEN` — bearer auth (StartOS proxies the interface in front).
- **Interface:** a UI/API interface on port 8787 (LAN + Tor address).

## Build steps (to produce the `.s9pk`)

1. Install the SDK: `npm i -g @start9labs/start-sdk` (see Start9 packaging docs for the current version).
2. Author the StartOS package per the SDK (`startos/` with `manifest.ts`, `actions`, `health checks`, `dependencies`, plus a `Makefile`). Use the wrapped image above; map config keys → the env vars listed above; health check hits `/healthz`; mount `/data`.
3. `make` → produces `pact.s9pk`.
4. `start-cli package install` (sideload) or submit to the Start9 registry / a community marketplace.

References: [Start9 service packaging](https://docs.start9.com), [hello-world-startos](https://github.com/Start9Labs/hello-world-startos) (wrapper template).

## Status

Scaffold. TODO: implement the `start-sdk` TS package (`startos/manifest.ts` + `Makefile`) and produce/publish a signed `.s9pk`. Tracked as a follow-up — the wrapped image, ports, health check, volume, and config keys above are the full spec it needs.
