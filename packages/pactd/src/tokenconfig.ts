// Bearer-token resolution. Auth is DEFAULT-ON: without a token the loopback
// HTTP surface is a write API reachable by any webpage the operator opens.
//
// Precedence: PACT_TOKEN (explicit) wins. Otherwise pactd load-or-creates a
// persisted random token in PACT_HOME (file mode 600) — same-machine clients
// (the UI, pact-mcp, local agents) read it from there. PACT_AUTO_TOKEN is
// retained for backward compatibility but is now simply the default behavior.
// PACT_NO_AUTH=1 is the explicit, dev-only escape hatch (the server logs a
// loud warning at startup when it is set).

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { pactHome, writeSecretFile } from 'pact-core';

export function tokenPath(): string {
  return join(pactHome(), 'token');
}

function truthy(v: string | undefined): boolean {
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
}

/** Explicit dev-only opt-out of auth. The daemon warns loudly at startup. */
export function noAuthRequested(): boolean {
  return truthy(process.env.PACT_NO_AUTH);
}

function loadOrCreateToken(): string {
  try {
    if (existsSync(tokenPath())) {
      const existing = readFileSync(tokenPath(), 'utf8').trim();
      if (existing) {
        // Heal a planted loose mode on the read path — the file may predate the
        // hardened writer.
        try {
          chmodSync(tokenPath(), 0o600);
        } catch {
          // best effort: a foreign-owned file is still usable
        }
        return existing;
      }
    }
  } catch {
    // fall through and regenerate
  }
  const token = randomBytes(24).toString('base64url');
  try {
    writeSecretFile(tokenPath(), token);
  } catch {
    // non-persistent token is still better than none for this run
  }
  return token;
}

export function resolveToken(): string | undefined {
  if (process.env.PACT_TOKEN) return process.env.PACT_TOKEN;
  if (noAuthRequested()) return undefined;
  if (truthy(process.env.PACT_AUTO_TOKEN)) return loadOrCreateToken(); // legacy spell
  return loadOrCreateToken(); // the default
}
