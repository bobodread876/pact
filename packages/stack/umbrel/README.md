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

## Notes

- pactd holds the key locally under the app's data dir (`${APP_DATA_DIR}/data`); nothing is uploaded.
- For a fully sovereign setup, set `PACT_RELAYS` to your own Nostr relay (e.g. another Umbrel app) in `docker-compose.yml`. Otherwise it uses public relays.
- For non-custodial sats + paid verification, set `PACT_NWC` (and `PACT_VERIFY_PRICE_SATS`).
- MVP: pactd serves a JSON API (no web UI yet), so the Umbrel "Open" button shows the API. A status UI is a follow-up. A bundled relay (currently separate) can be added to this compose later.
