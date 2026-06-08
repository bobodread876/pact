#!/usr/bin/env node
import { createDaemon, VERSION } from './server.js';

// Sovereign default: bind to loopback only. Never expose to 0.0.0.0 without auth.
const HOST = process.env.PACT_HOST ?? '127.0.0.1';
const PORT = Number(process.env.PACT_PORT ?? 8787);

const server = createDaemon();
server.listen(PORT, HOST, () => {
  const auth = process.env.PACT_TOKEN ? ' (bearer-token auth on)' : '';
  process.stderr.write(`pactd ${VERSION}: listening on http://${HOST}:${PORT}${auth}\n`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
