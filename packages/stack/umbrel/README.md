# Pact — Umbrel community app

One-click install of `pactd` on [Umbrel](https://umbrel.com) via a community app store.

**This directory is the source of truth** for the app. The live store repo,
[bobodread876/pact-umbrel-store](https://github.com/bobodread876/pact-umbrel-store),
is a copy of it: on each pactd release, sync this directory into the store repo
(the `release` workflow does it when `UMBREL_STORE_TOKEN` is configured). Never
edit the store repo by hand — it would drift from here. The app version always
equals the pactd version (CI checks it).

## Layout (Umbrel community-app-store format)

```
umbrel-app-store.yml          # store id + name
pact-pactd/
  umbrel-app.yml              # app listing (version = pactd version)
  docker-compose.yml          # app_proxy + the pactd `web` service + the bundled `relay`
  icon.svg                    # app icon
```

## To publish & install

1. **Image:** published multi-arch at `ghcr.io/bobodread876/pactd:<version>` by the release workflow. The GHCR package must be **public** (`github.com/users/bobodread876/packages/container/pactd/settings` → *Change visibility → Public*) so Umbrel can pull it.
2. **Store repo:** Umbrel community app stores need `umbrel-app-store.yml` at the **repo root**, so the contents of this `umbrel/` directory live at the root of `bobodread876/pact-umbrel-store`.
3. **Add it in umbrelOS:** App Store → **⋯** → *Community App Stores* → paste the repo URL → install **Pact**.

## Using it

- **Open** the app from your Umbrel dashboard → a **status web UI** (identity, bonds, wallet, relays). Click **Create identity** to mint the node's `did:nostr`.
- **Connect a Lightning wallet** right in the UI: in **Alby Hub** (also an Umbrel app) create an app connection, copy its `nostr+walletconnect://…` URI, and paste it into Pact's wallet panel. No config/env editing. (Isolated Alby Hub sub-wallets are recommended.)
- **Connect an external agent:** the UI's *"Connect an agent"* panel shows the access token and the exact `claude mcp add …` command. The token is auto-derived from the app's Umbrel seed (`${APP_SEED}`).

## Notes

- pactd holds the key locally under the app's data dir (`${APP_DATA_DIR}/data`); nothing is uploaded.
- **The UI** is served only through Umbrel's `app_proxy` (behind the Umbrel login). Because of that login, and only there, the page carries the token for its own API calls (`PACT_UI_EMBED_TOKEN`).
- **External/agent access:** host port **`3737`** is an **API-only** listener (`PACT_API_PORT`): every endpoint needs the token, and it serves no UI page, so nothing on it hands out the token. Point an agent at `http://<umbrel-host>:3737` with the token from the UI. Keep it on a trusted LAN anyway: the token can pay invoices from the connected wallet.
- **Relays:** the app ships its own relay (`relay` service, published on host port `7777` so other agents on your network can use it) and defaults pactd to it **plus** the public defaults. Change the set from the UI's *Relays* card; that setting persists and takes precedence over `PACT_RELAYS` in the compose.
