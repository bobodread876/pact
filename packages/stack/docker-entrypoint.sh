#!/bin/sh
# Drop root before starting pactd. Volumes created by earlier (root-run) images
# hold root-owned files, so take ownership of /data first; then run as `node`.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data/.pact
  chown -R node:node /data
  exec su-exec node "$@"
fi
exec "$@"
