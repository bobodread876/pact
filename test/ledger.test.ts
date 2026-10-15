// The paywall's security property lives in the verification-invoice ledger:
// invoices are bound to one bond and single-use, and survive restart. These
// unit tests prove the replay hole (any settled invoice → unlimited verifies)
// is closed, without standing up a wallet.

import { mkdtempSync, rmSync } from 'node:fs';
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

  it('prunes unredeemed entries past retention but keeps redeemed ones', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      ledger.recordVerificationInvoice('stale', 'urn:mate:1');
      ledger.recordVerificationInvoice('spent', 'urn:mate:1');
      expect(ledger.consumeVerification('spent', 'urn:mate:1')).toBe(true);
      vi.setSystemTime(new Date('2026-01-04T00:00:00Z'));
      ledger.recordVerificationInvoice('new', 'urn:mate:1'); // a write prunes
      expect(ledger.verificationStatus('stale', 'urn:mate:1')).toBe('unknown');
      expect(ledger.verificationStatus('spent', 'urn:mate:1')).toBe('spent');
      expect(ledger.verificationStatus('new', 'urn:mate:1')).toBe('ok');
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts only unredeemed invoices that can still be paid as pending', () => {
    const now = Date.now();
    ledger.recordVerificationInvoice('fresh', 'urn:mate:1', now);
    ledger.recordVerificationInvoice('expired', 'urn:mate:1', now - 2 * ledger.VERIFICATION_INVOICE_EXPIRY_SECS * 1000);
    ledger.recordVerificationInvoice('used', 'urn:mate:1', now);
    ledger.consumeVerification('used', 'urn:mate:1');
    expect(ledger.pendingVerificationCount(now)).toBe(1);
  });
});
