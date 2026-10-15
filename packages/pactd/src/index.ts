#!/usr/bin/env node
// Sovereign default: bind to loopback only. Never expose to 0.0.0.0 without auth.
const HOST = process.env.PACT_HOST ?? '127.0.0.1';
const PORT = Number(process.env.PACT_PORT ?? 8787);
// Optional API-only listener (no UI at `/`): what a platform should publish on
// a host port for agents, while the UI stays behind its authenticating proxy.
const API_PORT = process.env.PACT_API_PORT ? Number(process.env.PACT_API_PORT) : undefined;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const truthy = (v: string | undefined) => v !== undefined && !['', '0', 'false'].includes(v.toLowerCase());

// A non-loopback bind with no token would be wide open to the network. Lock it
// with the persisted auto token instead (PACT_HOME/token). Must be decided
// before server.ts is loaded: it resolves the token at import time.
if (!LOOPBACK.has(HOST) && !process.env.PACT_TOKEN && !truthy(process.env.PACT_AUTO_TOKEN)) {
  process.env.PACT_AUTO_TOKEN = '1';
  process.stderr.write(
    `pactd: binding ${HOST} (not loopback) with no PACT_TOKEN — generated an access token at <PACT_HOME>/token. ` +
      `Read it there (e.g. \`docker compose exec pactd cat /data/.pact/token\`) or set PACT_TOKEN.\n`,
  );
}

const { hasIdentity, loadSecret } = await import('pact-core');
const { applyConfiguredIntent, configuredIntent, publishedStatus } = await import('./intentconfig.js');
const { authEnabled, createDaemon, currentRelays, VERSION } = await import('./server.js');

const auth = authEnabled() ? ' (bearer-token auth on)' : ' (no auth: loopback only)';
const server = createDaemon();
server.listen(PORT, HOST, () => {
  process.stderr.write(`pactd ${VERSION}: listening on http://${HOST}:${PORT}${auth}\n`);

  // Discovery is opt-in: nothing is published unless the operator set
  // PACT_INTENT_SEEKING. When they did, make the relays match it (idempotent).
  // Without an identity yet, POST /identity applies it at creation time.
  if (configuredIntent() && hasIdentity()) {
    applyConfiguredIntent(loadSecret(), currentRelays())
      .then((r) => {
        if (!r) return;
        const status = publishedStatus(r);
        process.stderr.write(
          status.discoverable
            ? `pactd: published configured bond intent (seeking ${r.seeking.join(', ')})\n`
            : `pactd: configured bond intent not accepted by any relay: ${status.hint}\n`,
        );
      })
      .catch((error) => process.stderr.write(`pactd: configured bond intent not published: ${String(error)}\n`));
  }
});

const apiServer = API_PORT !== undefined ? createDaemon({ serveUI: false }) : undefined;
apiServer?.listen(API_PORT, HOST, () => {
  process.stderr.write(`pactd ${VERSION}: API-only listener on http://${HOST}:${API_PORT}${auth}\n`);
});

const shutdown = () => {
  apiServer?.close();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
