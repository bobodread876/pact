// The paywall's security property lives in the verification-invoice ledger:
// invoices are bound to one bond and single-use, and survive restart. These
// unit tests prove the replay hole (any settled invoice → unlimited verifies)
// is closed, without standing up a wallet.

import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dir: string;
let ledger: typeof import('../packages/pactd/src/ledger.js');

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pact-ledger-'));
  process.env.PACT_HOME = dir;
  vi.resetModules();
  ledger = await import('../packages/pactd/src/ledger.js');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.PACT_HOME;
});

describe('verification invoice ledger (paywall)', () => {
  it('binds an invoice to its bond and accepts a correct first redemption', () => {
    ledger.recordVerificationInvoice('hashA', 'urn:mate:1');
    expect(ledger.verificationStatus('hashA', 'urn:mate:1')).toBe('ok');
    expect(ledger.consumeVerification('hashA', 'urn:mate:1')).toBe(true);
  });

  it('is single-use: a second redemption is rejected (closes the replay hole)', () => {
    ledger.recordVerificationInvoice('hashA', 'urn:mate:1');
    expect(ledger.consumeVerification('hashA', 'urn:mate:1')).toBe(true);
    expect(ledger.consumeVerification('hashA', 'urn:mate:1')).toBe(false);
    expect(ledger.verificationStatus('hashA', 'urn:mate:1')).toBe('spent');
  });

  it('rejects a hash issued for a different bond', () => {
    ledger.recordVerificationInvoice('hashA', 'urn:mate:1');
    expect(ledger.verificationStatus('hashA', 'urn:mate:2')).toBe('wrong_bond');
    expect(ledger.consumeVerification('hashA', 'urn:mate:2')).toBe(false);
    // and the real bond is still redeemable
    expect(ledger.consumeVerification('hashA', 'urn:mate:1')).toBe(true);
  });

  it('rejects an unknown hash (e.g. an unrelated settled invoice on a shared wallet)', () => {
    expect(ledger.verificationStatus('foreign', 'urn:mate:1')).toBe('unknown');
    expect(ledger.consumeVerification('foreign', 'urn:mate:1')).toBe(false);
  });

  it('survives a daemon restart: a consumed invoice stays consumed', async () => {
    ledger.recordVerificationInvoice('hashA', 'urn:mate:1');
    expect(ledger.consumeVerification('hashA', 'urn:mate:1')).toBe(true);
    // simulate restart: fresh module instance, same PACT_HOME on disk
    vi.resetModules();
    const reloaded = await import('../packages/pactd/src/ledger.js');
    expect(reloaded.verificationStatus('hashA', 'urn:mate:1')).toBe('spent');
    expect(reloaded.consumeVerification('hashA', 'urn:mate:1')).toBe(false);
  });

  it('only one of two racing redemptions of the same hash wins', () => {
    ledger.recordVerificationInvoice('hashA', 'urn:mate:1');
    const results = [
      ledger.consumeVerification('hashA', 'urn:mate:1'),
      ledger.consumeVerification('hashA', 'urn:mate:1'),
    ];
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe('fail-closed persistence (write errors must not silently succeed)', () => {
  // The ledger directory (not the file) goes read-only: atomic tmp+rename
  // persistence can then neither create its tmp file nor rename — so writes
  // must throw and in-memory state must NOT drift ahead of the disk.
  it('consumeVerification throws when the persist fails, and the redemption stays live', () => {
    ledger.recordVerificationInvoice('hashA', 'urn:mate:1');
    chmodSync(dir, 0o555);
    try {
      expect(() => ledger.consumeVerification('hashA', 'urn:mate:1')).toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
    // flag reverted in memory — the redemption never happened
    expect(ledger.verificationStatus('hashA', 'urn:mate:1')).toBe('ok');
    expect(ledger.consumeVerification('hashA', 'urn:mate:1')).toBe(true);
  });

  it('a failed consume leaves the on-disk record untouched and drops no tmp litter', () => {
    ledger.recordVerificationInvoice('hashA', 'urn:mate:1');
    chmodSync(dir, 0o555);
    try {
      expect(() => ledger.consumeVerification('hashA', 'urn:mate:1')).toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
    const onDisk = JSON.parse(readFileSync(join(dir, 'verifications.json'), 'utf8')) as Record<string, { consumed: boolean }>;
    expect(onDisk['hashA'].consumed).toBe(false);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
  });

  it('recordVerificationInvoice and recordPaymentHash propagate write failures', () => {
    chmodSync(dir, 0o555);
    try {
      expect(() => ledger.recordVerificationInvoice('hashB', 'urn:mate:1')).toThrow();
      expect(() => ledger.recordPaymentHash('hashB')).toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
    // and once the dir is writable again, recording works
    ledger.recordVerificationInvoice('hashB', 'urn:mate:1');
    expect(ledger.verificationStatus('hashB', 'urn:mate:1')).toBe('ok');
  });

  it('a failed consume survives a simulated restart as unspent', async () => {
    ledger.recordVerificationInvoice('hashA', 'urn:mate:1');
    chmodSync(dir, 0o555);
    try {
      expect(() => ledger.consumeVerification('hashA', 'urn:mate:1')).toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
    vi.resetModules();
    const reloaded = await import('../packages/pactd/src/ledger.js');
    // the PoC'd replay window stays CLOSED: no silent in-memory burn
    expect(reloaded.verificationStatus('hashA', 'urn:mate:1')).toBe('ok');
  });
});

describe('pending-invoice queries (issuance cap / per-bond reuse)', () => {
  it('pendingVerificationForBond returns the live invoice for a bond, not a consumed one', () => {
    ledger.recordVerificationInvoice('hashA', 'urn:mate:1', 'lnbc1a');
    expect(ledger.pendingVerificationForBond('urn:mate:1')).toEqual({ hash: 'hashA', invoice: 'lnbc1a' });
    expect(ledger.consumeVerification('hashA', 'urn:mate:1')).toBe(true);
    expect(ledger.pendingVerificationForBond('urn:mate:1')).toBeNull();
    expect(ledger.pendingVerificationForBond('urn:mate:other')).toBeNull();
  });

  it('countPendingVerifications counts only unconsumed records', () => {
    ledger.recordVerificationInvoice('hashA', 'urn:mate:1');
    ledger.recordVerificationInvoice('hashB', 'urn:mate:2');
    expect(ledger.countPendingVerifications()).toBe(2);
    expect(ledger.consumeVerification('hashA', 'urn:mate:1')).toBe(true);
    expect(ledger.countPendingVerifications()).toBe(1);
  });
});
