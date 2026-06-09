# Pact — Start9 (StartOS) package

One-click, self-sovereign install of `pactd` on [Start9 / StartOS](https://start9.com).

Unlike Umbrel (plain YAML + compose), a StartOS service is compiled into a
signed **`.s9pk`** with the **[start-sdk](https://docs.start9.com)** (TypeScript).
This directory **is** that package — authored against `@start9labs/start-sdk@1.5.3`
(StartOS 0.3.6). It wraps the published multi-arch image
`ghcr.io/bobodread876/pactd` (x86_64 + aarch64), so there's no source build.

## What it does

- Runs `pactd` as the service's primary daemon (`node packages/pactd/dist/index.js`).
- Exposes one **UI/API interface** on port `8787` (StartOS gives it LAN + Tor addresses).
- Persists key, bonds, wallet config, and token on the **`main`** volume (`/data`).
- Health check: the daemon's port is listening.
- Security: pactd runs with `PACT_AUTO_TOKEN=true` — it generates and persists a
  bearer token (StartOS has no app-seed to derive one from). The token is shown
  in the Web UI's "Connect an agent" card and required for API access.

## Build the `.s9pk`

Requires the StartOS dev toolchain — **`start-cli`** (a Rust binary; see
[Installing the SDK](https://docs.start9.com/latest/developer-guide/sdk/installing-the-sdk)),
**Docker**, **Node/npm**, and `jq`.

```bash
cd packages/stack/start9
npm ci
make            # type-checks, ncc-bundles startos/, then `start-cli s9pk pack`
# → pactd.s9pk (universal) or pactd_x86_64.s9pk / pactd_aarch64.s9pk per arch
```

First build inits a developer signing key (`start-cli init-key`). The bundle +
type-check steps (`npm run check && npm run build`) run with just Node and are
what's validated in this repo; only the final `start-cli s9pk pack` needs the
Rust toolchain + Docker.

### Build via CI

`.github/workflows/build.yml` uses Start9's `shared-workflows` to build the
`.s9pk` on push/PR (set a `DEV_KEY` secret = your StartOS developer key). To use
it, this package can be split into its own repo (as the Umbrel app store was),
since GitHub Actions only reads workflows at a repo root.

## Install

```bash
# define `host: http://<your-server>.local` in ~/.startos/config.yaml, then:
make install        # sideloads the .s9pk to your StartOS server
```

Or in the StartOS web UI: **System → Sideload Service** and upload the `.s9pk`.

## Bundled relay

This first cut is **pactd only** and defaults to public Nostr relays (change them
in the Web UI's Relays card). Bundling a relay (as the Umbrel app does, via a
second daemon) is a planned follow-up.
