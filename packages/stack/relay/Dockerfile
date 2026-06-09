# pact-relay: a tiny, opinionated Nostr relay for Pact agent bonds.
#
# Just strfry (multi-arch: amd64 + arm64, so it runs on a Raspberry Pi / Umbrel)
# with a baked-in config: binds 0.0.0.0:7777, NIP-42 auth disabled (Pact
# publishes unauthenticated), and an LMDB at /data/strfry-db for persistence.
# Baking the config in means no config-file mount is needed — it Just Works as a
# bundled service on Umbrel/Start9/Docker where mounting arbitrary files is awkward.
FROM ghcr.io/hoytech/strfry:latest

COPY strfry.conf /app/strfry.conf

EXPOSE 7777
VOLUME ["/data"]
# Ensure the LMDB dir exists on a fresh bind-mounted /data (Umbrel/Start9 don't
# seed bind mounts from the image), then exec the relay.
ENTRYPOINT ["/bin/sh", "-c"]
CMD ["mkdir -p /data/strfry-db && exec /app/strfry relay"]
