#!/usr/bin/env node
import { hasIdentity, loadSecret } from 'pact-core';

import { applyConfiguredIntent, configuredIntent, publishedStatus } from './intentconfig.js';
import { createDaemon, currentRelays, VERSION } from './server.js';

// Sovereign default: bind to loopback only. Never expose to 0.0.0.0 without auth.
const HOST = process.env.PACT_HOST ?? '127.0.0.1';
const PORT = Number(process.env.PACT_PORT ?? 8787);

const server = createDaemon();
server.listen(PORT, HOST, () => {
  const auth = process.env.PACT_TOKEN ? ' (bearer-token auth on)' : '';
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

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
