// Local record of payment hashes this Pact node originated (invoices it
// created, payments it made). Used to scope /wallet/transactions to Pact's own
// activity, so the agent never sees unrelated transactions from other apps
// sharing the same NWC wallet/node. Sovereign: local-only, in PACT_HOME.
//
// Atomicity: every write goes to a tmp file that is rename()d into place, so a
// crash mid-write never corrupts the ledger. Fail-CLOSED: a failed write
// propagates to the caller — a ledger that cannot persist must not pretend the
// money moved.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { pactHome } from 'pact-core';

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(pactHome(), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // the tmp file may never have been created
    }
    throw error;
  }
}

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

/** Record a payment hash that this Pact node originated. Throws if the write fails. */
export function recordPaymentHash(hash: string | undefined | null): void {
  if (!hash) return;
  const set = load();
  if (set.has(hash)) return;
  set.add(hash);
  atomicWriteJson(ledgerPath(), [...set]);
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
  /** When the invoice was issued (ms since epoch). Absent on pre-0.20.1 entries. */
  issuedAt?: number;
  /** Client address the invoice was issued to (per-client pending cap). Absent on older entries. */
  client?: string;
  /** The bolt11 string, stored so a re-ask for the same bond reuses this invoice. */
  invoice?: string;
}

/** Expiry requested for verification invoices (seconds). */
export const VERIFICATION_INVOICE_EXPIRY_SECS = 3600;
/**
 * How long an unredeemed entry is kept after issue. Longer than the invoice
 * expiry, so a buyer who paid just before it expired can still redeem; after
 * this the invoice can no longer be paid and the entry is dead weight.
 */
const UNREDEEMED_RETENTION_MS = (VERIFICATION_INVOICE_EXPIRY_SECS + 24 * 3600) * 1000;

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

/**
 * Persist the verification ledger atomically (temp file + rename). Throws on
 * failure: the single-use guarantee is only as good as this write, so a
 * read-only or full PACT_HOME must fail the request, not silently degrade to
 * an in-memory ledger that a restart forgets.
 */
function persistVerifications(map: Map<string, VerificationInvoice>): void {
  pruneVerifications(map, Date.now());
  atomicWriteJson(verificationsPath(), Object.fromEntries(map));
}

/**
 * Drop unredeemed entries past retention, so anonymous 402 requests can't grow
 * the ledger (and every rewrite of it) without bound. Redeemed entries stay:
 * they are what makes an invoice single-use. Legacy entries with no issuedAt
 * are stamped now, so they age out on the same clock.
 */
function pruneVerifications(map: Map<string, VerificationInvoice>, now: number): void {
  for (const [hash, v] of map) {
    if (v.consumed) continue;
    if (v.issuedAt === undefined) v.issuedAt = now;
    else if (now - v.issuedAt > UNREDEEMED_RETENTION_MS) map.delete(hash);
  }
}

/** Unredeemed verification invoices that can still be paid (issued within the expiry). */
export function pendingVerificationCount(now = Date.now()): number {
  return pendingVerificationCountFor(undefined, now);
}

/**
 * Unredeemed, unexpired invoices issued to one client address — or to anyone
 * when `client` is undefined. One address may hold only a small share of the
 * global pool, so it can't lock every other buyer out by filling it.
 */
export function pendingVerificationCountFor(client: string | undefined, now = Date.now()): number {
  let n = 0;
  for (const v of loadVerifications().values()) {
    if (v.consumed) continue;
    if (v.issuedAt !== undefined && now - v.issuedAt > VERIFICATION_INVOICE_EXPIRY_SECS * 1000) continue;
    if (client !== undefined && v.client !== client) continue;
    n++;
  }
  return n;
}

/** Record an invoice issued to gate verification of a specific bond. */
export function recordVerificationInvoice(hash: string, bondId: string, now = Date.now(), client?: string): void {
  const map = loadVerifications();
  if (map.has(hash)) return;
  map.set(hash, { bondId, consumed: false, issuedAt: now, ...(client ? { client } : {}) });
  try {
    persistVerifications(map);
  } catch (error) {
    map.delete(hash);
    throw error;
  }
}

/** The live (unspent) invoice previously issued for this bond, for reuse in 402 answers. */
export function pendingVerificationForBond(bondId: string): { hash: string; invoice?: string } | null {
  for (const [hash, v] of loadVerifications()) {
    if (v.bondId === bondId && !v.consumed) return { hash, invoice: v.invoice };
  }
  return null;
}

/** How many issued verification invoices remain outstanding (unredeemed). */
export function countPendingVerifications(): number {
  let n = 0;
  for (const v of loadVerifications().values()) if (!v.consumed) n++;
  return n;
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
 * returns true, any other sees `consumed` and returns false. Throws when the
 * consumption can't be persisted. Call only after the invoice is confirmed paid.
 */
export function consumeVerification(hash: string, bondId: string): boolean {
  const map = loadVerifications();
  const v = map.get(hash);
  if (!v || v.bondId !== bondId || v.consumed) return false;
  v.consumed = true;
  try {
    persistVerifications(map);
  } catch (error) {
    // Not durably consumed → don't serve it (a restart would let it redeem
    // again). Roll back so a retry after the disk recovers still works.
    v.consumed = false;
    throw error;
  }
  return true;
}
