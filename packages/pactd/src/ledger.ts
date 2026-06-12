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

// --- Paid-verification invoices ---------------------------------------------
// A verification invoice is bound to one bond_id and is single-use: once
// redeemed it cannot satisfy another verification. Persisted (survives restart)
// so the paywall can't be reset by bouncing the daemon. This closes the replay
// hole — a settled invoice for one bond can't unlock unlimited verifications,
// and an unrelated settled invoice on a shared wallet can't unlock any.

interface VerificationInvoice {
  bondId: string;
  consumed: boolean;
}

function verificationsPath(): string {
  return join(pactHome(), 'verifications.json');
}

let vcache: Map<string, VerificationInvoice> | null = null;

function loadVerifications(): Map<string, VerificationInvoice> {
  if (vcache) return vcache;
  try {
    vcache = existsSync(verificationsPath())
      ? new Map(Object.entries(JSON.parse(readFileSync(verificationsPath(), 'utf8')) as Record<string, VerificationInvoice>))
      : new Map();
  } catch {
    vcache = new Map();
  }
  return vcache;
}

function persistVerifications(map: Map<string, VerificationInvoice>): void {
  try {
    mkdirSync(pactHome(), { recursive: true });
    writeFileSync(verificationsPath(), JSON.stringify(Object.fromEntries(map)), { mode: 0o600 });
  } catch {
    // best effort
  }
}

/** Record an invoice issued to gate verification of a specific bond. */
export function recordVerificationInvoice(hash: string, bondId: string): void {
  const map = loadVerifications();
  if (map.has(hash)) return;
  map.set(hash, { bondId, consumed: false });
  persistVerifications(map);
}

export type VerificationStatus = 'ok' | 'unknown' | 'wrong_bond' | 'spent';

/** Read-only pre-check: is this hash a live, unspent invoice for this bond? */
export function verificationStatus(hash: string, bondId: string): VerificationStatus {
  const v = loadVerifications().get(hash);
  if (!v) return 'unknown';
  if (v.bondId !== bondId) return 'wrong_bond';
  if (v.consumed) return 'spent';
  return 'ok';
}

/**
 * Authoritative single-use gate. Synchronous (no await between check and set),
 * so concurrent requests for the same hash serialize: the first consumes and
 * returns true, any other sees `consumed` and returns false. Call only after
 * the invoice is confirmed paid.
 */
export function consumeVerification(hash: string, bondId: string): boolean {
  const map = loadVerifications();
  const v = map.get(hash);
  if (!v || v.bondId !== bondId || v.consumed) return false;
  v.consumed = true;
  persistVerifications(map);
  return true;
}
