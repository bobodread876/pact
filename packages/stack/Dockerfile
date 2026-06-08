# pactd image — the Pact sidecar daemon, for self-hosting (generic Docker,
# Umbrel, Start9, etc.).
#
# Build from the REPO ROOT (build context = repo root):
#   docker build -f packages/stack/Dockerfile -t pactd .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
RUN npm ci
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PACT_HOST=0.0.0.0 \
    PACT_PORT=8787 \
    PACT_HOME=/data/.pact
# In a container pactd binds 0.0.0.0; the platform (compose/Umbrel/Start9)
# controls external exposure. Key + local store persist on the /data volume.
COPY --from=build /app /app
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "packages/pactd/dist/index.js"]
