// Money-path security regressions for pactd's paid /bonds/verify (the P0 audit
// cluster 4/9/10/11). Each test mirrors a reproduced attack, driven end-to-end
// against the REAL daemon, the REAL NWC provider, and a wire-correct mock NWC
// wallet (test/mock-nwc.ts) + mock bond relay (test/mock-relay.ts):
//
//   #4 NWC capture-replay — forged envelopes (wallet-spoofed pubkey, junk sig,
//      correct #e) replaying a captured settled response; settled_at:0 called
//      paid; echoing back a different payment_hash; paying with a preimage
//      whose sha256 doesn't match the invoice.
//   #9 Ledger persistence fail-open — silent write failure re-opened the replay
//      window after a restart. Writes are atomic and consume fails closed.
//  #10 Consume-before-fulfill — a relay failure burned a paid redemption into
//      an ambiguous 200/count:0. Now: verify payment, fulfill, consume LAST,
//      with a 409 in-flight guard against concurrent duplicate redemptions.
//  #11 Unbounded invoice issuance — every anonymous 402 minted a fresh wallet
//      invoice. Now: a bond re-ask returns the SAME invoice, and a global cap
//      on outstanding invoices answers 429 + error JSON.

import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { craftBolt11ForHash, startMockWallet, type MockWallet } from './mock-nwc.js';
import { startMockRelay, type MockRelay } from './mock-relay.js';

interface RawResponse {
  status: number;
  body: string;
  json(): any;
}

const TOKEN = 'paywall-test-token';
const DEAD_RELAY = 'ws://127.0.0.1:1';

let relay: MockRelay;
let wallet: MockWallet;
let daemon: { port: number; dir: string } | undefined;
let server: Server | undefined;
const tmpDirs: string[] = [];

function req(opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const r = httpRequest(
      {
        hostname: '127.0.0.1',
        port: daemon!.port,
        path: opts.path,
        method: opts.method ?? 'GET',
        headers: { authorization: `Bearer ${TOKEN}`, ...(opts.headers ?? {}) },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, json: () => JSON.parse(body) }));
      },
    );
    r.on('error', reject);
    if (opts.body !== undefined) r.write(opts.body);
    r.end();
  });
}

const verifyBond = (bondId: string, extra = ''): Promise<RawResponse> =>
  req({ path: `/bonds/verify?bond_id=${encodeURIComponent(bondId)}${extra}` });
const redeem = (bondId: string, paymentHash: string, extra = ''): Promise<RawResponse> =>
  verifyBond(bondId, `&payment_hash=${paymentHash}${extra}`);
const lookupWallet = (paymentHash: string): Promise<RawResponse> =>
  req({ path: `/wallet/invoice?payment_hash=${paymentHash}` });

/** Ask for a verification invoice and assert the 402 + invoice contract. */
async function expectInvoice(bondId: string): Promise<{ invoice: string; payment_hash: string }> {
  const res = await verifyBond(bondId);
  expect(res.status).toBe(402);
  const body = res.json();
  expect(typeof body.invoice).toBe('string');
  expect(/^[0-9a-f]{64}$/.test(body.payment_hash)).toBe(true);
  expect(body.price_sats).toBe(10);
  return body;
}

async function bootDaemon(opts: { maxPending?: number } = {}): Promise<void> {
  if (server) await new Promise((resolve) => server!.close(resolve));
  const dir = mkdtempSync(join(tmpdir(), 'pact-paywall-'));
  tmpDirs.push(dir);
  process.env.PACT_HOME = dir;
  process.env.PACT_TOKEN = TOKEN;
  process.env.PACT_RELAYS = relay.url;
  process.env.PACT_NWC = wallet.nwcUri;
  process.env.PACT_VERIFY_PRICE_SATS = '10';
  if (opts.maxPending != null) process.env.PACT_VERIFY_MAX_PENDING = String(opts.maxPending);
  else delete process.env.PACT_VERIFY_MAX_PENDING;
  for (const k of ['PACT_NO_AUTH', 'PACT_HOST', 'PACT_PUBLIC_MODE']) delete process.env[k];
  vi.resetModules();
  const serverMod = await import('../packages/pactd/src/server.js');
  server = serverMod.createDaemon();
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  daemon = { port: (server.address() as AddressInfo).port, dir };
}

beforeAll(async () => {
  relay = await startMockRelay();
  wallet = await startMockWallet();
});

afterEach(() => {
  wallet.quirks = {};
  wallet.delays = {};
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server!.close(resolve));
  await wallet.close();
  await relay.close();
  for (const dir of tmpDirs) {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
  for (const k of ['PACT_HOME', 'PACT_TOKEN', 'PACT_RELAYS', 'PACT_NWC', 'PACT_VERIFY_PRICE_SATS', 'PACT_VERIFY_MAX_PENDING']) {
    delete process.env[k];
  }
});

describe('invoice issuance is bounded (#11): per-bond reuse + global cap', () => {
  beforeAll(() => bootDaemon({ maxPending: 2 }));

  it('re-asking for the same bond returns the SAME invoice (no second make_invoice call)', async () => {
    const minted = wallet.counts.make_invoice ?? 0;
    const first = await expectInvoice('urn:mate:reuse-1');
    const second = await expectInvoice('urn:mate:reuse-1');
    expect(second.invoice).toBe(first.invoice);
    expect(second.payment_hash).toBe(first.payment_hash);
    expect(wallet.counts.make_invoice).toBe(minted + 1);
  });

  it('mints a fresh invoice for a DIFFERENT bond, then rejects new issuance with 429 beyond the cap', async () => {
    const minted = wallet.counts.make_invoice ?? 0;
    const other = await expectInvoice('urn:mate:reuse-2');
    expect(wallet.counts.make_invoice).toBe(minted + 1);
    expect(other.payment_hash).not.toBe((await expectInvoice('urn:mate:reuse-1')).payment_hash);
    // cap = 2 outstanding: reuse-1 and reuse-2 hold the slots
    const over = await verifyBond('urn:mate:reuse-3');
    expect(over.status).toBe(429);
    expect(typeof over.json().error).toBe('string');
    expect(wallet.counts.make_invoice).toBe(minted + 1);
  });

  it('redeeming a paid invoice frees its slot under the cap', async () => {
    const first = await expectInvoice('urn:mate:reuse-1');
    wallet.markPaid(first.payment_hash);
    const paid = await redeem('urn:mate:reuse-1', first.payment_hash);
    expect(paid.status).toBe(200);
    expect(paid.json().paid).toBe(true);
    // slot freed: a so-far-rejected bond can now be issued an invoice
    const nowOk = await expectInvoice('urn:mate:reuse-3');
    expect(nowOk.payment_hash).not.toBe(first.payment_hash);
    // and the consumed invoice never verifies again
    const replay = await redeem('urn:mate:reuse-1', first.payment_hash);
    expect(replay.status).toBe(402);
  });
});

describe('NWC response authentication (#4)', () => {
  beforeAll(() => bootDaemon());

  it('a forged-envelope replay of a settled response never marks an unpaid invoice paid', async () => {
    // Given invoice A, genuinely settled — capture the wallet's wire response.
    const a = await expectInvoice('urn:mate:forge-a');
    wallet.markPaid(a.payment_hash);
    const lookupA = await lookupWallet(a.payment_hash);
    expect(lookupA.json().paid).toBe(true);
    const captured = wallet.responded.find((r) => r.method === 'lookup_invoice' && r.paymentHash === a.payment_hash && r.settled);
    expect(captured).toBeTruthy();

    // When the attacker replays A's settled ciphertext in a forged envelope
    // (wallet-spoofed pubkey, junk sig, correct #e) against B's lookup,
    const b = await expectInvoice('urn:mate:forge-b');
    wallet.forgeNextResponse(captured!.event.content);
    const forged = await redeem('urn:mate:forge-b', b.payment_hash);
    // Then B is still unpaid and its redemption is untouched.
    expect(forged.status).toBe(402);
    expect(wallet.isPaid(b.payment_hash)).toBe(false);
    const again = await redeem('urn:mate:forge-b', b.payment_hash);
    expect(again.status).toBe(402);
    expect(again.json().error).toContain('not settled');
  });

  it('a genuinely-signed response whose result_type does not match the request is rejected', async () => {
    const inv = await expectInvoice('urn:mate:rtype');
    wallet.quirks.wrongResultType = true;
    const lookup = await lookupWallet(inv.payment_hash);
    expect(lookup.status).toBe(500);
    expect(lookup.json().error).toContain('result_type');
  });

  it('a settled response echoing a DIFFERENT payment_hash is not trusted', async () => {
    const inv = await expectInvoice('urn:mate:wronghash');
    wallet.markPaid(inv.payment_hash);
    wallet.quirks.wrongPaymentHash = true;
    const lookup = await lookupWallet(inv.payment_hash);
    expect(lookup.status).toBe(500);
    wallet.quirks.wrongPaymentHash = false;
    const control = await lookupWallet(inv.payment_hash);
    expect(control.json().paid).toBe(true);
  });

  it('a settled_at of 0 without a preimage is not settlement evidence', async () => {
    const inv = await expectInvoice('urn:mate:settledzero');
    wallet.markPaid(inv.payment_hash);
    wallet.quirks.settledAtZero = true;
    const lookup = await lookupWallet(inv.payment_hash);
    expect(lookup.status).toBe(200);
    expect(lookup.json().paid).toBe(false);
    // control: the same invoice with a real settled_at settles fine
    wallet.quirks.settledAtZero = false;
    const control = await lookupWallet(inv.payment_hash);
    expect(control.json().paid).toBe(true);
  });

  it('a pay response whose preimage does not sha256 to the invoice hash is not settled', async () => {
    const invoice = craftBolt11ForHash('11'.repeat(32));
    wallet.quirks.badPreimage = true;
    const pay = await req({
      method: 'POST',
      path: '/wallet/pay',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ invoice }),
    });
    expect(pay.status).toBe(200);
    expect(pay.json().status).not.toBe('settled');
  });
});

describe('fulfill-before-consume (#10)', () => {
  beforeAll(() => bootDaemon());

  it('a relay failure during redemption answers 502 and leaves the paid invoice redeemable', async () => {
    const inv = await expectInvoice('urn:mate:relayfail');
    wallet.markPaid(inv.payment_hash);
    // When the bond relays are unreachable, fulfillment cannot happen.
    const failed = await redeem('urn:mate:relayfail', inv.payment_hash, `&relay=${encodeURIComponent(DEAD_RELAY)}`);
    expect(failed.status).toBe(502);
    // Then the redemption is NOT burned: after the relay recovers, it verifies.
    const retried = await redeem('urn:mate:relayfail', inv.payment_hash);
    expect(retried.status).toBe(200);
    expect(retried.json().paid).toBe(true);
    // and single-use still holds afterwards
    const third = await redeem('urn:mate:relayfail', inv.payment_hash);
    expect(third.status).toBe(402);
  });

  it('a concurrent duplicate redemption is rejected with 409', async () => {
    const inv = await expectInvoice('urn:mate:dup');
    wallet.markPaid(inv.payment_hash);
    const priorLookups = wallet.counts.lookup_invoice ?? 0;
    wallet.delays.lookup_invoice = 250; // keep the first redemption in flight
    const p1 = redeem('urn:mate:dup', inv.payment_hash);
    await vi.waitFor(() => {
      expect(wallet.counts.lookup_invoice).toBeGreaterThan(priorLookups);
    });
    const p2 = redeem('urn:mate:dup', inv.payment_hash);
    const [r1, r2] = await Promise.all([p1, p2]);
    delete wallet.delays.lookup_invoice;
    expect([r1.status, r2.status].sort((a, b) => a - b)).toEqual([200, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    expect(typeof loser.json().error).toBe('string');
    // the winner consumed the invoice — single-use intact
    const third = await redeem('urn:mate:dup', inv.payment_hash);
    expect(third.status).toBe(402);
  });
});

describe('consume failure fails closed (#9)', () => {
  beforeAll(() => bootDaemon());

  it('a failed ledger write answers 500 and the redemption stays redeemable', async () => {
    const inv = await expectInvoice('urn:mate:perm');
    wallet.markPaid(inv.payment_hash);
    // When the ledger dir becomes unwritable mid-flight,
    chmodSync(daemon!.dir, 0o555);
    let first: RawResponse;
    try {
      first = await redeem('urn:mate:perm', inv.payment_hash);
    } finally {
      chmodSync(daemon!.dir, 0o700);
    }
    // Then the redemption does NOT silently succeed half-persisted.
    expect(first.status).toBe(500);
    const onDisk = JSON.parse(readFileSync(join(daemon!.dir, 'verifications.json'), 'utf8')) as Record<string, { consumed: boolean }>;
    expect(onDisk[inv.payment_hash].consumed).toBe(false);
    // And once writes work again, the paid retry goes through exactly once.
    const retry = await redeem('urn:mate:perm', inv.payment_hash);
    expect(retry.status).toBe(200);
    expect(retry.json().paid).toBe(true);
    const again = await redeem('urn:mate:perm', inv.payment_hash);
    expect(again.status).toBe(402);
  });
});
