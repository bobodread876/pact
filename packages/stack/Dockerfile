# pactd image — the Pact sidecar daemon, for self-hosting (generic Docker,
# Umbrel, Start9, etc.).
#
# Build from the REPO ROOT (build context = repo root):
#   docker build -f packages/stack/Dockerfile -t pactd .

# --- build: install deps from the manifests only (cached until a manifest
# changes), then copy sources and compile pact-core + pactd.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/mcp/package.json packages/mcp/
COPY packages/sdk/package.json packages/sdk/
COPY packages/cli/package.json packages/cli/
COPY packages/pactd/package.json packages/pactd/
RUN npm ci
COPY packages/core packages/core
COPY packages/pactd packages/pactd
RUN npm run build -w pact-core -w pact-pactd

# --- runtime: production deps for pact-core + pactd only, compiled output
# only, unprivileged user.
FROM node:22-alpine
WORKDIR /app
# Refresh the CA store in both ca-certificates packages: the base snapshot can
# predate Alpine's 20261020-r0, which distrusts the compromised eMudhra
# intermediates (emSign ECC Root CA - G3). Upgrading only -bundle regenerates
# the store from a stale source dir, so upgrade the main package too. Node gets
# NODE_OPTIONS=--use-openssl-ca so TLS trusts the refreshed store instead of its
# compiled-in roots. Assert the emSign root is gone.
RUN apk upgrade --no-cache ca-certificates ca-certificates-bundle \
 && if [ -f /etc/ssl/certs/ca-certificates.crt.apk-new ]; then mv /etc/ssl/certs/ca-certificates.crt.apk-new /etc/ssl/certs/ca-certificates.crt; fi \
 && ! grep -q MIICTjCCAdOgAwIBAgIKPPYHqWhwDtqLhDAKBggqhkjOPQQDAzBr /etc/ssl/certs/ca-certificates.crt
ENV NODE_ENV=production \
    NODE_OPTIONS=--use-openssl-ca \
    PACT_HOST=0.0.0.0 \
    PACT_PORT=8787 \
    PACT_HOME=/data/.pact
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/mcp/package.json packages/mcp/
COPY packages/sdk/package.json packages/sdk/
COPY packages/cli/package.json packages/cli/
COPY packages/pactd/package.json packages/pactd/
RUN apk add --no-cache su-exec \
 && npm ci --omit=dev -w pact-core -w pact-pactd \
 && npm cache clean --force
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/pactd/dist packages/pactd/dist
COPY LICENSE ./
COPY packages/stack/docker-entrypoint.sh /usr/local/bin/pactd-entrypoint
# In a container pactd binds 0.0.0.0, so it locks itself with a generated
# token unless PACT_TOKEN is set (see packages/pactd/README.md). The platform
# (compose/Umbrel/Start9) controls external exposure. Key + local state
# persist on the /data volume. The entrypoint chowns /data (volumes from older
# root-run images) and drops to the unprivileged `node` user.
RUN mkdir -p /data/.pact && chown -R node:node /data
VOLUME ["/data"]
EXPOSE 8787
ENTRYPOINT ["pactd-entrypoint"]
CMD ["node", "packages/pactd/dist/index.js"]
