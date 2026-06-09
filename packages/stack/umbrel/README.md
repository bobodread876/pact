# Pact — Umbrel community app

One-click install of `pactd` on [Umbrel](https://umbrel.com) via a community app store.

## Layout (Umbrel community-app-store format)

```
umbrel-app-store.yml          # store id + name
pact-pactd/
  umbrel-app.yml              # app listing
  docker-compose.yml          # app_proxy + the pactd `web` service
  icon.svg                    # (add an icon)
```

## To publish & install

1. **Image:** already published (multi-arch) at `ghcr.io/bobodread876/pactd:latest`. **Make it public** at `github.com/users/bobodread876/packages/container/pactd/settings` → *Change visibility → Public* (required so Umbrel can pull it).
2. **Create the store repo:** Umbrel community app stores must have `umbrel-app-store.yml` at the **repo root**. Copy the contents of this `umbrel/` directory into a dedicated public repo (e.g. `bobodread876/pact-umbrel-store`).
3. **Add it in umbrelOS:** App Store → **⋯** → *Community App Stores* → paste the repo URL → install **Pact**.

## Using it

- **Open** the app from your Umbrel dashboard → a **status web UI** (identity, bonds, wallet, capabilities). Click **Create identity** to mint the node's `did:nostr`.
- **Connect a Lightning wallet** right in the UI: in **Alby Hub** (also an Umbrel app) create an app connection, copy its `nostr+walletconnect://…` URI, and paste it into Pact's wallet panel. No config/env editing. (Isolated Alby Hub sub-wallets are recommended.)
- **Connect an external agent:** the UI's *"Connect an agent"* panel shows the access token and the exact `claude mcp add …` command. The token is auto-derived from the app's Umbrel seed (`${APP_SEED}`).

## Notes

- pactd holds the key locally under the app's data dir (`${APP_DATA_DIR}/data`); nothing is uploaded.
- **External/agent access:** the daemon is exposed on host port **`3737`** (token-required). Point an agent at `http://<umbrel-host>:3737` with the token from the UI. Keep this on a **trusted LAN** — the direct port serves the UI (which shows the token) without Umbrel's login in front of it.
- The Umbrel app URL (port 8787) is behind Umbrel's `app_proxy` login — good for the browser UI, but it blocks programmatic agents, which is why the direct `3737` port + token exists.
- For a fully sovereign relay, set `PACT_RELAYS` to your own Nostr relay in `docker-compose.yml`; otherwise public relays are used.
