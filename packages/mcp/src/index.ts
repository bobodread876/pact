#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createServer } from './server.js';

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe; stdout is the MCP transport.
  process.stderr.write('pact-mcp: ready (stdio)\n');
}

main().catch((error) => {
  process.stderr.write(`pact-mcp: fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
