#!/usr/bin/env node
import { createDaemon, HOST, isLoopbackHost, PUBLIC_MODE, TOKEN, VERSION } from './server.js';
import { noAuthRequested, tokenPath } from './tokenconfig.js';

// Sovereign default: bind to loopback only. Never expose to 0.0.0.0 without auth.
const PORT = Number(process.env.PACT_PORT ?? 8787);

const server = createDaemon();
server.listen(PORT, HOST, () => {
  process.stderr.write(`pactd ${VERSION}: listening on http://${HOST}:${PORT}\n`);
  if (noAuthRequested()) {
    process.stderr.write(
      'pactd: WARNING — PACT_NO_AUTH=1: API auth is DISABLED. Dev-only; every process and webpage that can reach this port can drive it.\n',
    );
    return;
  }
  if (TOKEN) {
    if (process.env.PACT_TOKEN) {
      process.stderr.write('pactd: bearer-token auth on (token from PACT_TOKEN)\n');
    } else {
      process.stderr.write(`pactd: bearer-token auth on — token stored at ${tokenPath()} (file mode 600)\n`);
    }
    if (!isLoopbackHost(HOST) && !PUBLIC_MODE) {
      // Non-loopback bind without public posture (the Umbrel-style power path,
      // where the UI is behind a login): the operator retrieves the token from
      // these logs.
      process.stderr.write(`pactd: non-loopback bind, PUBLIC_MODE off — API token: ${TOKEN}\n`);
    }
  }
  if (!isLoopbackHost(HOST) && PUBLIC_MODE) {
    process.stderr.write(
      'pactd: PUBLIC MODE — non-loopback bind. All API routes require the bearer token; the served UI never contains it.\n',
    );
  }
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
