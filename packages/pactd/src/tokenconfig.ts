// Bearer-token resolution. PACT_TOKEN (explicit) always wins. Otherwise, when
// PACT_AUTO_TOKEN is truthy, pactd load-or-creates a persisted random token in
// PACT_HOME — so a node exposed by a platform that has no "app seed" to derive a
// secret from (e.g. StartOS) is still locked down without the operator wiring a
// token by hand. The UI surfaces the token in its "Connect an agent" card.
// Unset (the default) leaves the API open — correct for loopback-only setups.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { pactHome } from 'pact-core';

function tokenPath(): string {
  return join(pactHome(), 'token');
}

function truthy(v: string | undefined): boolean {
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
}

export function resolveToken(): string | undefined {
  if (process.env.PACT_TOKEN) return process.env.PACT_TOKEN;
  if (!truthy(process.env.PACT_AUTO_TOKEN)) return undefined;
  try {
    if (existsSync(tokenPath())) {
      const existing = readFileSync(tokenPath(), 'utf8').trim();
      if (existing) return existing;
    }
  } catch {
    // fall through and regenerate
  }
  const token = randomBytes(24).toString('base64url');
  try {
    mkdirSync(pactHome(), { recursive: true });
    writeFileSync(tokenPath(), token, { mode: 0o600 });
  } catch {
    // non-persistent token is still better than none for this run
  }
  return token;
}
