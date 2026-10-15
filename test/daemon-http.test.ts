// pactd over real HTTP: auth, the token never on the page, cross-site and
// rebinding defenses, client errors as 4xx, the paid-verification flow end to
// end (with a stub wallet), and the event stream's interval clamp.

import { mkdtempSync, rmSync } from 'node:fs';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { formBond, generateNostrKeypair, keypairFromSecret, newBondId, secretFromNsec } from '../packages/core/src/index.js';
import type { LightningProvider } from '../packages/pactd/src/lightning.js';
import { startMockRelay, type MockRelay } from './mock-relay.js';

const TOKEN = 'test-token-0123456789abcdef';

let relay: MockRelay;
let home: string;

/** A wallet whose invoices are paid only when the test says so. */
function stubWallet() {
  const invoices = new Map<string, { paid: boolean }>();
  let n = 0;
  const provider: LightningProvider = {
    getInfo: async () => ({ alias: 'stub' }),
    getBalanceSats: async () => 0,
    makeInvoice: async () => {
      const hash = (++n).toString(16).padStart(64, '0');
      invoices.set(hash, { paid: false });
      return { invoice: `lnbcstub${hash}`, paymentHash: hash };
    },
    payInvoice: async () => ({ status: 'failed', error: 'stub' }) as never,
    // Await like a real wallet round trip, so concurrent redemptions interleave.
    lookupInvoice: async ({ paymentHash }) => {
      await new Promise((r) => setTimeout(r, 50));
      return { paid: invoices.get(paymentHash ?? '')?.paid ?? false };
    },
    listTransactions: async () => [],
    getCapabilities: async () => ({ methods: [], backend: 'stub', canPayAmountless: false }),
  };
  return { provider, pay: (hash: string) => invoices.set(hash, { paid: true }) };
}

async function startDaemon(env: Record<string, string | undefined>, options: Record<string, unknown> = {}) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  const server = await import('../packages/pactd/src/server.js');
  const daemon: Server = server.createDaemon(options as never);
  await new Promise<void>((resolve) => daemon.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(daemon.address() as AddressInfo).port}`;
  return { daemon, base, close: () => new Promise<void>((r) => daemon.close(() => r())) };
}

function call(base: string, method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; auth?: boolean } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
  if (opts.auth) headers.authorization = `Bearer ${TOKEN}`;
  return fetch(`${base}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
  });
}

beforeAll(async () => {
  relay = await startMockRelay();
  home = mkdtempSync(join(tmpdir(), 'pact-http-'));
});

afterAll(async () => {
  await relay.close();
  rmSync(home, { recursive: true, force: true });
  for (const k of ['PACT_TOKEN', 'PACT_VERIFY_PRICE_SATS', 'PACT_HOME', 'PACT_RELAYS', 'PACT_ALLOWED_HOSTS', 'PACT_VERIFY_MAX_PENDING', 'PACT_VERIFY_INVOICES_PER_MIN']) delete process.env[k];
});

describe('token-protected daemon with a paid verification market', () => {
  let d: Awaited<ReturnType<typeof startDaemon>>;
  const wallet = stubWallet();

  beforeAll(async () => {
    d = await startDaemon(
      { PACT_HOME: home, PACT_RELAYS: relay.url, PACT_TOKEN: TOKEN, PACT_VERIFY_PRICE_SATS: '10', PACT_UI_EMBED_TOKEN: undefined, PACT_ALLOWED_HOSTS: undefined },
      { lightning: wallet.provider },
    );
  });
  afterAll(async () => d.close());

  it('GET / is served without auth but never contains the token', async () => {
    const res = await fetch(`${d.base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(TOKEN);
  });

  it('admin endpoints need the token', async () => {
    expect((await call(d.base, 'GET', '/identity')).status).toBe(401);
    expect((await call(d.base, 'GET', '/wallet')).status).toBe(401);
    const created = await call(d.base, 'POST', '/identity', { auth: true, body: {} });
    expect(created.status).toBe(200);
  });

  it('a text/plain POST (the no-preflight cross-site shape) is refused with 415', async () => {
    const res = await call(d.base, 'POST', '/wallet/disconnect', { auth: true, headers: { 'content-type': 'text/plain' }, body: '{}' });
    expect(res.status).toBe(415);
  });

  it('cross-site requests are refused (Origin and Sec-Fetch-Site)', async () => {
    const byOrigin = await call(d.base, 'POST', '/relays', { auth: true, headers: { origin: 'http://evil.example' }, body: { relays: ['wss://attacker.example'] } });
    expect(byOrigin.status).toBe(403);
    const bySite = await call(d.base, 'GET', '/identity', { auth: true, headers: { 'sec-fetch-site': 'cross-site' } });
    expect(bySite.status).toBe(403);
    const sameSite = await call(d.base, 'GET', '/identity', { auth: true, headers: { 'sec-fetch-site': 'same-origin' } });
    expect(sameSite.status).toBe(200);
  });

  it('client mistakes are 4xx, not 500', async () => {
    expect((await call(d.base, 'POST', '/bonds', { auth: true, body: 'null' })).status).toBe(400);
    expect((await call(d.base, 'POST', '/bonds', { auth: true, body: '{not json' })).status).toBe(400);
    expect((await call(d.base, 'POST', '/bonds', { auth: true, body: { counterparty: keypairFromSecret(secretFromNsec(generateNostrKeypair().nsec)).npub, state: 'banana' } })).status).toBe(400);
    expect((await call(d.base, 'POST', '/bonds', { auth: true, body: { counterparty: 'not-an-identity' } })).status).toBe(400);
    expect((await call(d.base, 'GET', '/bonds?author=zzz', { auth: true })).status).toBe(400);
    expect((await call(d.base, 'POST', '/bonds/accept', { auth: true, body: { bondId: newBondId() } })).status).toBe(404);
    expect((await call(d.base, 'POST', '/bonds/reaffirm', { auth: true, body: { bondId: newBondId() } })).status).toBe(404);
  });

  it('identity force needs the current pubkeyHex', async () => {
    const id = (await (await call(d.base, 'GET', '/identity', { auth: true })).json()) as { pubkeyHex: string };
    const refused = await call(d.base, 'POST', '/identity', { auth: true, body: { force: true } });
    expect(refused.status).toBe(409);
    const still = (await (await call(d.base, 'GET', '/identity', { auth: true })).json()) as { pubkeyHex: string };
    expect(still.pubkeyHex).toBe(id.pubkeyHex);
  });

  it('402 → unpaid rejected → paid 200 → replay 402 → wrong bond 402, all without the admin token', async () => {
    const bondId = newBondId();
    const first = await call(d.base, 'GET', `/bonds/verify?bond_id=${encodeURIComponent(bondId)}`);
    expect(first.status).toBe(402);
    const { payment_hash: hash } = (await first.json()) as { payment_hash: string };

    const unpaid = await call(d.base, 'GET', `/bonds/verify?bond_id=${encodeURIComponent(bondId)}&payment_hash=${hash}`);
    expect(unpaid.status).toBe(402);
    expect(((await unpaid.json()) as { error: string }).error).toMatch(/not settled/);

    const other = newBondId();
    wallet.pay(hash);
    const wrong = await call(d.base, 'GET', `/bonds/verify?bond_id=${encodeURIComponent(other)}&payment_hash=${hash}`);
    expect(wrong.status).toBe(402);

    const ok = await call(d.base, 'GET', `/bonds/verify?bond_id=${encodeURIComponent(bondId)}&payment_hash=${hash}`);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { paid: boolean }).paid).toBe(true);

    const replay = await call(d.base, 'GET', `/bonds/verify?bond_id=${encodeURIComponent(bondId)}&payment_hash=${hash}`);
    expect(replay.status).toBe(402);
  });

  it('concurrent redemptions of one paid hash over HTTP: exactly one wins', async () => {
    const bondId = newBondId();
    const q = `/bonds/verify?bond_id=${encodeURIComponent(bondId)}`;
    const { payment_hash: hash } = (await (await call(d.base, 'GET', q)).json()) as { payment_hash: string };
    wallet.pay(hash);
    const results = await Promise.all(Array.from({ length: 4 }, () => call(d.base, 'GET', `${q}&payment_hash=${hash}`)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 402, 402, 402]);
  });

  it('strangers get the public verdict only; the operator also sees private sides', async () => {
    const id = (await (await call(d.base, 'GET', '/identity', { auth: true })).json()) as { npub: string };
    const alice = secretFromNsec(generateNostrKeypair().nsec);
    const bondId = newBondId();
    await formBond(alice, { counterparty: id.npub, bondId, state: 'proposed', visibility: 'private', relays: [relay.url] });

    const buy = async (auth: boolean) => {
      const q = `/bonds/verify?bond_id=${encodeURIComponent(bondId)}`;
      const { payment_hash: hash } = (await (await call(d.base, 'GET', q, { auth })).json()) as { payment_hash: string };
      wallet.pay(hash);
      return (await (await call(d.base, 'GET', `${q}&payment_hash=${hash}`, { auth })).json()) as { count: number };
    };
    expect((await buy(false)).count).toBe(0);
    expect((await buy(true)).count).toBe(1);
  });

  it('?interval=x is clamped to the default, not a 1 ms timer', async () => {
    const before = relay.reqCount();
    const ctrl = new AbortController();
    const res = await fetch(`${d.base}/events?interval=x`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: ctrl.signal });
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain('"intervalMs":30000');
    await new Promise((r) => setTimeout(r, 600));
    ctrl.abort();
    // One poll = a handful of REQs (public + paged inbox), not hundreds.
    expect(relay.reqCount() - before).toBeLessThan(10);
  });
});

describe('anonymous /bonds/verify: the caller never picks the relays', () => {
  it('an unauthenticated ?relay= is never dialed; the operator\'s still is; party params are validated', async () => {
    const attacker = await startMockRelay();
    const subHome = mkdtempSync(join(tmpdir(), 'pact-http-relay-'));
    // Price set AND a wallet: the market route is open to strangers (paid).
    const wallet = stubWallet();
    const d = await startDaemon(
      { PACT_HOME: subHome, PACT_RELAYS: relay.url, PACT_TOKEN: TOKEN, PACT_VERIFY_PRICE_SATS: '5', PACT_ALLOWED_HOSTS: undefined },
      { lightning: wallet.provider },
    );
    try {
      const bondId = encodeURIComponent(newBondId());
      const evil = Array.from({ length: 20 }, () => `relay=${encodeURIComponent(attacker.url)}`).join('&');
      const before = relay.reqCount();
      const quote = await call(d.base, 'GET', `/bonds/verify?bond_id=${bondId}&${evil}`);
      expect(quote.status).toBe(402);
      const { payment_hash: hash } = (await quote.json()) as { payment_hash: string };
      wallet.pay(hash);
      const anon = await call(d.base, 'GET', `/bonds/verify?bond_id=${bondId}&payment_hash=${hash}&${evil}`);
      expect(anon.status).toBe(200);
      expect(((await anon.json()) as { relaysReached: string[] }).relaysReached).not.toContain(attacker.url);
      expect(attacker.reqCount()).toBe(0);
      expect(relay.reqCount()).toBeGreaterThan(before);

      // The operator pays like anyone else when a wallet is connected, but may pick relays.
      const opQuote = await call(d.base, 'GET', `/bonds/verify?bond_id=${bondId}&${evil}`, { auth: true });
      expect(opQuote.status).toBe(402);
      const { payment_hash: opHash } = (await opQuote.json()) as { payment_hash: string };
      wallet.pay(opHash);
      const op = await call(d.base, 'GET', `/bonds/verify?bond_id=${bondId}&payment_hash=${opHash}&${evil}`, { auth: true });
      expect(op.status).toBe(200);
      // Deduped: twenty copies of one relay are one relay.
      expect(((await op.json()) as { relaysReached: string[] }).relaysReached).toEqual([attacker.url]);

      // Party params are validated before the paywall: a good one is quoted (402), a bad one is 400.
      const npub = keypairFromSecret(secretFromNsec(generateNostrKeypair().nsec)).npub;
      expect((await call(d.base, 'GET', `/bonds/verify?bond_id=${bondId}&party=${npub}`)).status).toBe(402);
      expect((await call(d.base, 'GET', `/bonds/verify?bond_id=${bondId}&party=zzz`)).status).toBe(400);
    } finally {
      await d.close();
      await attacker.close();
      rmSync(subHome, { recursive: true, force: true });
    }
  });
});

describe('anonymous invoice issuing is bounded', () => {
  it('per-client rate limit and pending caps apply to strangers; the operator is exempt', async () => {
    const subHome = mkdtempSync(join(tmpdir(), 'pact-http-cap-'));
    const wallet = stubWallet();
    const d = await startDaemon(
      { PACT_HOME: subHome, PACT_RELAYS: relay.url, PACT_TOKEN: TOKEN, PACT_VERIFY_PRICE_SATS: '5', PACT_VERIFY_INVOICES_PER_MIN: '3', PACT_VERIFY_MAX_PENDING: '5', PACT_ALLOWED_HOSTS: undefined },
      { lightning: wallet.provider },
    );
    try {
      const q = () => `/bonds/verify?bond_id=${encodeURIComponent(newBondId())}`;
      const anon = [];
      for (let i = 0; i < 4; i++) anon.push((await call(d.base, 'GET', q())).status);
      expect(anon).toEqual([402, 402, 402, 429]);
      // The operator is exempt from the rate limit and from the pending caps:
      // they can always verify on their own node.
      const op = [];
      for (let i = 0; i < 4; i++) op.push((await call(d.base, 'GET', q(), { auth: true })).status);
      expect(op).toEqual([402, 402, 402, 402]);
    } finally {
      await d.close();
      rmSync(subHome, { recursive: true, force: true });
      delete process.env.PACT_VERIFY_INVOICES_PER_MIN;
      delete process.env.PACT_VERIFY_MAX_PENDING;
    }
  });

  it('one client can hold only its share of the pending pool; others still get invoices', async () => {
    const subHome = mkdtempSync(join(tmpdir(), 'pact-http-share-'));
    const wallet = stubWallet();
    const d = await startDaemon(
      {
        PACT_HOME: subHome,
        PACT_RELAYS: relay.url,
        PACT_TOKEN: TOKEN,
        PACT_VERIFY_PRICE_SATS: '5',
        PACT_VERIFY_INVOICES_PER_MIN: '100',
        PACT_VERIFY_MAX_PENDING: '5',
        PACT_VERIFY_MAX_PENDING_PER_CLIENT: '2',
        PACT_TRUSTED_PROXY: '1', // key clients on X-Forwarded-For so the test can be several clients
        PACT_ALLOWED_HOSTS: undefined,
      },
      { lightning: wallet.provider },
    );
    try {
      const q = () => `/bonds/verify?bond_id=${encodeURIComponent(newBondId())}`;
      // The proxy APPENDS the real peer; whatever the client put first is untrusted.
      const as = (ip: string, spoofed = '198.51.100.1') => ({ headers: { 'x-forwarded-for': `${spoofed}, ${ip}` } });
      // Client A fills its share (2) and is refused on the third, with the pool far from full.
      const a = [];
      for (let i = 0; i < 3; i++) a.push((await call(d.base, 'GET', q(), as('203.0.113.7'))).status);
      expect(a).toEqual([402, 402, 429]);
      // Rotating the client-chosen leftmost entry does not buy a fresh bucket.
      expect((await call(d.base, 'GET', q(), as('203.0.113.7', '203.0.113.99'))).status).toBe(429);
      expect((await call(d.base, 'GET', q(), as('203.0.113.7', '2001:db8::1'))).status).toBe(429);
      // IPv6 clients are bucketed by /64: two hosts in one /64 share a bucket.
      expect((await call(d.base, 'GET', q(), as('2001:db8:1:2::10'))).status).toBe(402);
      expect((await call(d.base, 'GET', q(), as('2001:db8:1:2::11'))).status).toBe(402);
      expect((await call(d.base, 'GET', q(), as('2001:db8:1:2:ffff::1'))).status).toBe(429);
      // Client B is unaffected by A's holdings. Pool is now 4/5 (A 2 + the /64 pair 2).
      expect((await call(d.base, 'GET', q(), as('203.0.113.8'))).status).toBe(402);
      // D hits the global cap.
      expect((await call(d.base, 'GET', q(), as('203.0.113.10'))).status).toBe(429);
      // The operator is never locked out by strangers' unpaid invoices.
      expect((await call(d.base, 'GET', q(), { auth: true })).status).toBe(402);
    } finally {
      await d.close();
      rmSync(subHome, { recursive: true, force: true });
      for (const k of ['PACT_VERIFY_INVOICES_PER_MIN', 'PACT_VERIFY_MAX_PENDING', 'PACT_VERIFY_MAX_PENDING_PER_CLIENT', 'PACT_TRUSTED_PROXY']) delete process.env[k];
    }
  });
});

describe('open (tokenless) daemon: loopback names only', () => {
  let d: Awaited<ReturnType<typeof startDaemon>>;
  beforeAll(async () => {
    d = await startDaemon({ PACT_HOME: home, PACT_RELAYS: relay.url, PACT_TOKEN: undefined, PACT_AUTO_TOKEN: undefined, PACT_VERIFY_PRICE_SATS: undefined, PACT_ALLOWED_HOSTS: undefined });
  });
  afterAll(async () => d.close());

  it('refuses a rebound Host header', async () => {
    // fetch can't override Host; send it raw, as a DNS-rebinding page would.
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(d.base);
      const req = request({ host: u.hostname, port: u.port, path: '/', headers: { host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
    expect((await call(d.base, 'GET', '/healthz')).status).toBe(200);
  });

  it('refuses the no-cors simple POST that used to replace the identity', async () => {
    const before = (await (await call(d.base, 'GET', '/identity')).json()) as { pubkeyHex: string };
    const res = await call(d.base, 'POST', '/identity', { headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ force: true, pubkeyHex: before.pubkeyHex }) });
    expect(res.status).toBe(415);
    const after = (await (await call(d.base, 'GET', '/identity')).json()) as { pubkeyHex: string };
    expect(after.pubkeyHex).toBe(before.pubkeyHex);
  });
});

describe('API-only listener', () => {
  it('serves the API but answers / with 404', async () => {
    const d = await startDaemon({ PACT_HOME: home, PACT_RELAYS: relay.url, PACT_TOKEN: TOKEN }, { serveUI: false });
    try {
      expect((await fetch(`${d.base}/`)).status).toBe(404);
      expect((await call(d.base, 'GET', '/identity', { auth: true })).status).toBe(200);
    } finally {
      await d.close();
    }
  });
});

describe('a price without a wallet is not a market', () => {
  it('anonymous /bonds/verify gets 401, not a free unthrottled verify', async () => {
    const subHome = mkdtempSync(join(tmpdir(), 'pact-http-nowallet-'));
    const d = await startDaemon(
      { PACT_HOME: subHome, PACT_RELAYS: relay.url, PACT_TOKEN: TOKEN, PACT_VERIFY_PRICE_SATS: '5', PACT_ALLOWED_HOSTS: undefined },
      { lightning: null },
    );
    try {
      const before = relay.reqCount();
      const anon = await call(d.base, 'GET', `/bonds/verify?bond_id=${encodeURIComponent(newBondId())}`);
      expect(anon.status).toBe(401);
      expect(relay.reqCount()).toBe(before); // no relay was dialed for a stranger
      const op = await call(d.base, 'GET', `/bonds/verify?bond_id=${encodeURIComponent(newBondId())}`, { auth: true });
      expect(op.status).toBe(200);
    } finally {
      await d.close();
      rmSync(subHome, { recursive: true, force: true });
    }
  });
});
