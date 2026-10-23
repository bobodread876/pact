// Payment-policy gate for pact-mcp (security audit F-05). An MCP server lets
// an agent execute LLM-suggested tool calls, and pact-mcp exposes
// pact_pay_invoice (real money movement) next to tools that return raw relay
// text — indirect prompt injection would otherwise have a live path to the
// wallet. The gate: PACT_MCP_ALLOW_PAYMENTS=1 opts payments in, and
// PACT_MCP_MAX_PAYMENT_SATS (default 1000, whole-sats env semantics like
// pactd) caps a single payment even then. The gate reads env per call — never
// cached at module load — so this suite varies it inside one process: two
// seams are locked, the exported predicate and the live MCP tool handler with
// fetch stubbed at the transport boundary.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { paymentPolicyViolation } from '../packages/mcp/src/policy.js';
import { createServer } from '../packages/mcp/src/server.js';

const POLICY_ENV_KEYS = ['PACT_MCP_ALLOW_PAYMENTS', 'PACT_MCP_MAX_PAYMENT_SATS'] as const;

let savedEnv: Record<string, string | undefined>;

beforeAll(() => {
  savedEnv = Object.fromEntries(POLICY_ENV_KEYS.map((k) => [k, process.env[k]]));
});

afterEach(() => {
  for (const k of POLICY_ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Payments denied (default posture). */
function denyPayments(): void {
  delete process.env.PACT_MCP_ALLOW_PAYMENTS;
  delete process.env.PACT_MCP_MAX_PAYMENT_SATS;
}

/** Payments allowed; cap is unset (default 1000) unless given. */
function allowPayments(cap?: string): void {
  process.env.PACT_MCP_ALLOW_PAYMENTS = '1';
  if (cap === undefined) delete process.env.PACT_MCP_MAX_PAYMENT_SATS;
  else process.env.PACT_MCP_MAX_PAYMENT_SATS = cap;
}

const DISABLED_REFUSAL = {
  error: 'payments disabled by policy',
  howToEnable: 'set PACT_MCP_ALLOW_PAYMENTS=1',
} as const;

describe('paymentPolicyViolation (exported predicate seam)', () => {
  it('returns the disabled-by-policy refusal when PACT_MCP_ALLOW_PAYMENTS is unset', () => {
    // Given no opt-in env (the default posture),
    // When a payment is requested,
    // Then the refusal is the exact structured object — the agent sees a clean error.
    denyPayments();
    expect(paymentPolicyViolation({ invoice: 'lnbc1x', amountSats: 1 })).toEqual(DISABLED_REFUSAL);
  });

  it.each(['true', '0', 'yes', '2'])(
    'treats PACT_MCP_ALLOW_PAYMENTS=%s as disabled (only exactly "1" enables)',
    (value) => {
      // Given a positive-looking but non-explicit value,
      // When a payment is requested,
      // Then it is still refused.
      process.env.PACT_MCP_ALLOW_PAYMENTS = value;
      delete process.env.PACT_MCP_MAX_PAYMENT_SATS;
      expect(paymentPolicyViolation({ invoice: 'lnbc1x', amountSats: 1 })).toEqual(DISABLED_REFUSAL);
    },
  );

  it('allows a payment at or under the cap when payments are enabled', () => {
    // Given the opt-in and a 1000-sat cap,
    // When payments of 500 and exactly 1000 sats are requested,
    // Then both pass the gate (undefined = may proceed to the daemon).
    allowPayments('1000');
    expect(paymentPolicyViolation({ invoice: 'lnbc1x', amountSats: 500 })).toBeUndefined();
    expect(paymentPolicyViolation({ invoice: 'lnbc1x', amountSats: 1000 })).toBeUndefined();
  });

  it('refuses a payment above the cap with a structured error even when enabled', () => {
    // Given the opt-in and a 1000-sat cap,
    // When a 1001-sat payment is requested,
    // Then a structured refusal names the cap and the amount.
    allowPayments('1000');
    const refusal = paymentPolicyViolation({ invoice: 'lnbc1x', amountSats: 1001 });
    expect(refusal).toMatchObject({ capSats: 1000, amountSats: 1001 });
    expect(String(refusal?.error)).toContain('PACT_MCP_MAX_PAYMENT_SATS');
  });

  it('defaults the cap to 1000 sats when PACT_MCP_MAX_PAYMENT_SATS is unset', () => {
    // Given the opt-in but no cap override,
    // When a 5000-sat payment is requested,
    // Then the default 1000 cap refuses it; 1000 sats still passes.
    allowPayments();
    expect(paymentPolicyViolation({ invoice: 'lnbc1x', amountSats: 1000 })).toBeUndefined();
    expect(paymentPolicyViolation({ invoice: 'lnbc1x', amountSats: 1001 })).toMatchObject({ capSats: 1000 });
  });

  it('clips a fractional cap to whole sats (pactd env semantics)', () => {
    // Given cap "1000.9" — the daemon clips env sats to whole integers,
    // When amounts straddling the clipped value are requested,
    // Then the gate behaves exactly as if the cap were 1000.
    allowPayments('1000.9');
    expect(paymentPolicyViolation({ invoice: 'lnbc1x', amountSats: 1000 })).toBeUndefined();
    expect(paymentPolicyViolation({ invoice: 'lnbc1x', amountSats: 1001 })).toMatchObject({ capSats: 1000 });
  });

  it('falls back to the default cap on a non-numeric value', () => {
    // Given a garbage cap value,
    // When payments are requested,
    // Then the default 1000-sat cap applies.
    allowPayments('lots');
    expect(paymentPolicyViolation({ invoice: 'lnbc1x', amountSats: 1000 })).toBeUndefined();
    expect(paymentPolicyViolation({ invoice: 'lnbc1x', amountSats: 1001 })).toMatchObject({ capSats: 1000 });
  });

  it('applies the cap to the amount embedded in the bolt11 HRP, not just to amountSats', () => {
    // Given the opt-in with the default cap,
    // When invoices carry their own amounts ("lnbc250u1…" = 25 000 sats,
    // "lnbc10u1…" = 1000 sats) and no explicit amountSats is passed,
    // Then the over-cap invoice is refused and the at-cap one passes.
    allowPayments();
    expect(paymentPolicyViolation({ invoice: 'lnbc250u1qqqq' })).toMatchObject({ amountSats: 25000 });
    expect(paymentPolicyViolation({ invoice: 'lnbc10u1qqqq' })).toBeUndefined();
  });

  it('leaves an amountless invoice with no explicit amount to wallet-side validation', () => {
    // Given the opt-in and an invoice with no determinable amount,
    // When the gate evaluates it,
    // Then it passes — the wallet rejects amountless-without-amount; nothing moves.
    allowPayments();
    expect(paymentPolicyViolation({ invoice: 'lnbc1qqqq' })).toBeUndefined();
  });
});

describe('payment tools through the live MCP server (handler seam)', () => {
  let client: Client;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    // The transport boundary the daemon() helper already uses: global fetch.
    fetchSpy = vi.fn(
      async (_input: unknown, _init?: unknown): Promise<Response> =>
        new Response(JSON.stringify({ status: 'settled' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    await server.connect(serverTransport);
    client = new Client({ name: 'mcp-policy-test', version: '0.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    vi.unstubAllGlobals();
  });

  async function callToolJson(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await client.callTool({ name, arguments: args });
    const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
    const item = content?.[0];
    if (!item || item.type !== 'text' || typeof item.text !== 'string') {
      throw new Error(`unexpected ${name} response shape`);
    }
    return JSON.parse(item.text) as unknown;
  }

  it('pact_pay_invoice returns the disabled refusal and never touches the daemon when payments are off', async () => {
    // Given no payment opt-in,
    // When the payment tool is invoked,
    // Then the tool responds with the structured refusal and no HTTP call leaves.
    denyPayments();
    fetchSpy.mockClear();
    const res = await callToolJson('pact_pay_invoice', { invoice: 'lnbc1x', amountSats: 1 });
    expect(res).toEqual(DISABLED_REFUSAL);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('pact_pay_invoice refuses an over-cap payment without touching the daemon, even when enabled', async () => {
    // Given payments allowed with a 50-sat cap,
    // When a 5000-sat payment is invoked,
    // Then the structured cap refusal comes back and the transport stays silent.
    allowPayments('50');
    fetchSpy.mockClear();
    const res = await callToolJson('pact_pay_invoice', { invoice: 'lnbc1x', amountSats: 5000 });
    expect(res).toMatchObject({ capSats: 50, amountSats: 5000 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('pact_pay_invoice posts to /wallet/pay when enabled and under the cap', async () => {
    // Given payments allowed with a 5000-sat cap,
    // When a 5000-sat payment is invoked,
    // Then exactly one POST reaches the daemon's /wallet/pay route.
    allowPayments('5000');
    fetchSpy.mockClear();
    const res = await callToolJson('pact_pay_invoice', { invoice: 'lnbc1x', amountSats: 5000 });
    expect(res).toMatchObject({ status: 'settled' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [unknown, { method?: string } | undefined];
    expect(String(url)).toContain('/wallet/pay');
    expect(init?.method).toBe('POST');
  });

  it('read and receive-side tools stay open while payments are off', async () => {
    // Given no payment opt-in,
    // When a read tool and a receive-side wallet tool are invoked,
    // Then both reach the daemon — only the spending tool is gated.
    denyPayments();
    fetchSpy.mockClear();
    await callToolJson('pact_whoami', {});
    await callToolJson('pact_create_invoice', { amountSats: 5 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
