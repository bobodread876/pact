// Local record of payment hashes this Pact node originated (invoices it
// created, payments it made). Used to scope /wallet/transactions to Pact's own
// activity, so the agent never sees unrelated transactions from other apps
// sharing the same NWC wallet/node. Sovereign: local-only, in PACT_HOME.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { pactHome } from 'pact-core';

function ledgerPath(): string {
  return join(pactHome(), 'payments.json');
}

let cache: Set<string> | null = null;

function load(): Set<string> {
  if (cache) return cache;
  try {
    cache = existsSync(ledgerPath())
      ? new Set(JSON.parse(readFileSync(ledgerPath(), 'utf8')) as string[])
      : new Set();
  } catch {
    cache = new Set();
  }
  return cache;
}

/** Record a payment hash that this Pact node originated. */
export function recordPaymentHash(hash: string | undefined | null): void {
  if (!hash) return;
  const set = load();
  if (set.has(hash)) return;
  set.add(hash);
  try {
    mkdirSync(pactHome(), { recursive: true });
    writeFileSync(ledgerPath(), JSON.stringify([...set]), { mode: 0o600 });
  } catch {
    // best effort; scoping degrades gracefully
  }
}

/** Whether this Pact node originated the given payment hash. */
export function ownsPaymentHash(hash: string | undefined | null): boolean {
  return hash ? load().has(hash) : false;
}
