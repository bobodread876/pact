import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// pact-mcp is a thin MCP adapter over a running `pactd` daemon. The daemon holds
// the agent's key, relay config, and wallet; this server just exposes its
// operations as MCP tools. So an MCP agent (Claude Code, etc.) acts as that one
// sovereign pactd identity. Point it at the daemon with PACT_DAEMON_URL.
const DAEMON_URL = (process.env.PACT_DAEMON_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const TOKEN = process.env.PACT_TOKEN; // matches the daemon's PACT_TOKEN, if set

const BOND_STATES = ['proposed', 'accepted', 'active', 'paused', 'revoked', 'withdrawn', 'rejected'] as const;

function text(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  };
}

async function daemon(method: string, path: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  let res: Response;
  try {
    res = await fetch(`${DAEMON_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    return { error: `cannot reach pactd at ${DAEMON_URL} — is the daemon running? (${String(error)})` };
  }
  const raw = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    data = raw;
  }
  return { status: res.status, ...(typeof data === 'object' && data ? data : { data }) };
}

export function createServer(): McpServer {
  const server = new McpServer({ name: 'pact-mcp', version: '0.2.0' });

  server.tool(
    'pact_keygen',
    "Create this agent's self-sovereign Nostr identity (did:nostr) on the local pactd daemon. Idempotent unless force=true.",
    { force: z.boolean().default(false).describe('Regenerate even if an identity already exists (destructive).') },
    async ({ force }) => text(await daemon('POST', '/identity', { force })),
  );

  server.tool(
    'pact_whoami',
    "Return this agent's bond identity (did:nostr / npub / pubkey) from the daemon.",
    {},
    async () => text(await daemon('GET', '/identity')),
  );

  server.tool(
    'pact_form_bond',
    'Declare or update a relationship bond toward a counterparty and publish it via the daemon. state="proposed" to offer, "accepted"/"active" to reciprocate, "revoked" to end.',
    {
      counterparty: z.string().describe('Counterparty identity: did:nostr / npub / 64-hex pubkey.'),
      bond_id: z.string().describe('Stable bond id shared by both parties, e.g. "urn:mate:my-bond-01".'),
      state: z.enum(BOND_STATES).default('proposed').describe('Bond state to declare.'),
      kind: z.string().default('companion').describe('Relationship kind (e.g. companion, collaboration).'),
      relays: z.array(z.string()).optional().describe('Relay URLs (defaults to the daemon\'s configured relays).'),
      history: z.boolean().default(true).describe('Also publish a kind:1317 history event.'),
    },
    async ({ counterparty, bond_id, state, kind, relays, history }) =>
      text(await daemon('POST', '/bonds', { counterparty, bondId: bond_id, state, kind, relays, history })),
  );

  server.tool(
    'pact_list_bonds',
    "Resolve relationship bonds via the daemon and verify each signature. Filter by bond id, counterparty, or author. With no filter, lists this agent's own bonds.",
    {
      bond_id: z.string().optional().describe('Match a specific bond id.'),
      counterparty: z.string().optional().describe('Match bonds toward this identity.'),
      author: z.string().optional().describe('Match bonds authored by this identity.'),
    },
    async ({ bond_id, counterparty, author }) => {
      const qs = new URLSearchParams();
      if (bond_id) qs.set('bond_id', bond_id);
      if (counterparty) qs.set('counterparty', counterparty);
      if (author) qs.set('author', author);
      const suffix = qs.toString() ? `?${qs}` : '';
      return text(await daemon('GET', `/bonds${suffix}`));
    },
  );

  server.tool(
    'pact_verify_bond',
    'Verify a bond via the daemon (signatures + mutual check). If the daemon charges for verification it returns a Lightning invoice (status 402); pay it and call again with payment_hash.',
    {
      bond_id: z.string().describe('The bond id to verify.'),
      payment_hash: z.string().optional().describe('Payment hash of a paid invoice, to satisfy a paywalled verify.'),
    },
    async ({ bond_id, payment_hash }) => {
      const qs = new URLSearchParams({ bond_id });
      if (payment_hash) qs.set('payment_hash', payment_hash);
      return text(await daemon('GET', `/bonds/verify?${qs}`));
    },
  );

  server.tool(
    'pact_wallet',
    "Report the daemon's Lightning wallet status and balance (via Nostr Wallet Connect), or that none is connected.",
    {},
    async () => text(await daemon('GET', '/wallet')),
  );

  server.tool(
    'pact_create_invoice',
    "Create a Lightning invoice on the daemon's wallet to RECEIVE sats. Returns a bolt11 invoice + payment hash.",
    {
      amountSats: z.number().int().positive().describe('Amount to receive, in sats.'),
      description: z.string().optional().describe('Invoice memo.'),
    },
    async ({ amountSats, description }) => text(await daemon('POST', '/wallet/invoice', { amountSats, description })),
  );

  server.tool(
    'pact_lookup_invoice',
    'Check whether an invoice has been paid (by payment hash or bolt11).',
    {
      payment_hash: z.string().optional().describe('Payment hash to look up.'),
      invoice: z.string().optional().describe('bolt11 invoice to look up.'),
    },
    async ({ payment_hash, invoice }) => {
      const qs = new URLSearchParams();
      if (payment_hash) qs.set('payment_hash', payment_hash);
      if (invoice) qs.set('invoice', invoice);
      return text(await daemon('GET', `/wallet/invoice?${qs}`));
    },
  );

  server.tool(
    'pact_pay_invoice',
    "Pay a bolt11 Lightning invoice from the daemon's wallet. SPENDS sats (subject to your wallet's NWC budget). Returns status: 'settled' (confirmed paid), 'pending' (submitted but unconfirmed — DO NOT retry, may double-spend; check pact_list_transactions), or 'failed' (rejected, no funds moved).",
    { invoice: z.string().describe('The bolt11 invoice to pay.') },
    async ({ invoice }) => text(await daemon('POST', '/wallet/pay', { invoice })),
  );

  server.tool(
    'pact_list_transactions',
    "List Lightning transactions (received + sent). By DEFAULT shows only Pact's own payments (invoices Pact created + payments it made), so it never exposes unrelated transactions from other apps sharing the same wallet. Set all=true to show the entire wallet ledger (operator-only). The reliable settlement audit — unlike get_balance.",
    {
      limit: z.number().int().positive().optional().describe('Max transactions to return (default 20).'),
      unpaid: z.boolean().optional().describe('Include unpaid/pending invoices.'),
      all: z.boolean().optional().describe("Show the ENTIRE wallet, not just Pact's payments. Exposes other apps' transactions — use deliberately."),
    },
    async ({ limit, unpaid, all }) => {
      const qs = new URLSearchParams();
      if (limit) qs.set('limit', String(limit));
      if (unpaid) qs.set('unpaid', 'true');
      if (all) qs.set('all', 'true');
      const suffix = qs.toString() ? `?${qs}` : '';
      return text(await daemon('GET', `/wallet/transactions${suffix}`));
    },
  );

  return server;
}
