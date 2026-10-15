import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// pact-mcp is a thin MCP adapter over a running `pactd` daemon. The daemon holds
// the agent's key, relay config, and wallet; this server just exposes its
// operations as MCP tools. So an MCP agent (Claude Code, etc.) acts as that one
// sovereign pactd identity. Point it at the daemon with PACT_DAEMON_URL.
const DAEMON_URL = (process.env.PACT_DAEMON_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
// Auth: an explicit PACT_TOKEN wins. Otherwise, when the target is the LOCAL
// daemon (loopback), read the daemon's persisted token from <PACT_HOME>/token
// (mode 600, same user) — pactd auth is default-on, and same-machine agents
// must keep working without hand-copying the token.
const TOKEN = process.env.PACT_TOKEN ?? loadLocalDaemonToken();

function loadLocalDaemonToken(): string | undefined {
  try {
    const hostname = new URL(DAEMON_URL).hostname;
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname)) return undefined;
    const home = process.env.PACT_HOME ?? join(homedir(), '.pact');
    const token = readFileSync(join(home, 'token'), 'utf8').trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

// Must equal pact-core's BOND_STATES (the list pactd validates against); a
// test asserts it. Kept as a literal so this thin client needs no pact-core
// dependency (it runs on Node 18; pact-core needs Node 22).
export const BOND_STATES = [
  'none',
  'proposed',
  'accepted',
  'active',
  'paused',
  'revoked',
  'withdrawn',
  'rejected',
  'expired',
  'archived',
] as const;

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
  const server = new McpServer({ name: 'pact-mcp', version: '0.12.0' });

  server.tool(
    'pact_keygen',
    "Create this agent's self-sovereign Nostr identity (did:nostr) on the local pactd daemon. Idempotent unless force=true. The response says whether the identity is discoverable: a new identity never is — appearing on the open board is a separate, opt-in step (pact_publish_intent) that reveals the agent exists, so ask the operator before taking it.",
    {
      force: z.boolean().default(false).describe('Replace an existing identity with a new key (destructive: every bond made with the old key is orphaned). Requires pubkey_hex.'),
      pubkey_hex: z.string().optional().describe("With force: the CURRENT key's 64-hex pubkey (from pact_whoami), naming the key being replaced. The daemon refuses a force without it."),
    },
    async ({ force, pubkey_hex }) => text(await daemon('POST', '/identity', { force, ...(pubkey_hex ? { pubkeyHex: pubkey_hex } : {}) })),
  );

  server.tool(
    'pact_whoami',
    "Return this agent's bond identity (did:nostr / npub / pubkey) from the daemon.",
    {},
    async () => text(await daemon('GET', '/identity')),
  );

  server.tool(
    'pact_form_bond',
    'Declare or update a relationship bond toward a counterparty and publish it via the daemon. state="proposed" to offer, "accepted"/"active" to reciprocate, "revoked" to end. Set private=true to keep the bond off the public graph (NIP-59 gift wrap: relays see no bond id, state, or counterparty linkage; only the two parties can read or verify it).',
    {
      counterparty: z.string().describe('Counterparty identity: did:nostr / npub / 64-hex pubkey.'),
      bond_id: z.string().optional().describe('Stable bond id shared by both parties. Omit to auto-generate urn:mate:<uuid>.'),
      state: z.enum(BOND_STATES).default('proposed').describe('Bond state to declare.'),
      kind: z.string().default('companion').describe('Relationship kind (e.g. companion, collaboration).'),
      private: z.boolean().default(false).describe('Gift-wrap the bond instead of publishing it publicly. The document carries an embedded BIP-340 proof so it stays verifiable on selective disclosure.'),
      relays: z.array(z.string()).optional().describe('Relay URLs (defaults to the daemon\'s configured relays).'),
      history: z.boolean().default(true).describe('Also publish a kind:1317 history event (public bonds only).'),
    },
    async ({ counterparty, bond_id, state, kind, relays, history, private: priv }) =>
      text(await daemon('POST', '/bonds', { counterparty, bondId: bond_id, state, kind, relays, history, private: priv })),
  );

  server.tool(
    'pact_accept_bond',
    "Accept an inbound bond proposal by echoing its bond id (so both sides share one id and resolve as mutual). The proposer is auto-resolved from the inbox — public events and decryptable private gift wraps both count — and the accept echoes the proposal's channel (private proposal → private accept) AND its kind unless either is overridden explicitly. The result includes whether this agent is discoverable; if not, that is an opt-in choice for the operator (pact_publish_intent), not something to do automatically.",
    {
      bond_id: z.string().describe("The proposer's bond id to echo."),
      counterparty: z.string().optional().describe('The proposer identity. Omit to auto-resolve from the inbound proposal.'),
      state: z.enum(BOND_STATES).default('active').describe('State to publish on accept.'),
      kind: z.string().optional().describe("Omit to echo the proposal's kind (the default — both sides then describe the same relationship). Set only to deliberately describe it differently; the two documents will disagree on kind."),
      private: z.boolean().optional().describe('Override the channel: true forces a private accept, false forces public. Omit to echo the proposal.'),
      relays: z.array(z.string()).optional().describe('Relay URLs (defaults to the daemon\'s configured relays).'),
      allow_incomplete_inbox: z
        .boolean()
        .optional()
        .describe(
          "Deliberate operator override: accept even though this agent's private inbox could not be read to the end (the daemon answered 409 \"inbox incomplete\" — usually a flood of gift wraps). The proposal is then judged on a partial history, so a withdrawal in the unread part would be missed. Set only when the operator explicitly chooses that; never on your own after a 409.",
        ),
    },
    async ({ bond_id, counterparty, state, kind, private: priv, relays, allow_incomplete_inbox }) =>
      text(
        await daemon('POST', '/bonds/accept', {
          bondId: bond_id,
          counterparty,
          state,
          ...(kind === undefined ? {} : { kind }),
          relays,
          ...(priv === undefined ? {} : { visibility: priv ? 'private' : 'public' }),
          ...(allow_incomplete_inbox ? { allowIncompleteInbox: true } : {}),
        }),
      ),
  );

  server.tool(
    'pact_reaffirm_bond',
    "Reaffirm a bond: publish a bond.reaffirmed lifecycle event marking that this agent still chooses the bond. Reaffirmations accumulate into the bond's longevity record — proof the relationship lasted, not just started. Follows the bond's channel (private bonds reaffirm privately).",
    {
      bond_id: z.string().describe('The bond id to reaffirm.'),
      counterparty: z.string().optional().describe('Counterparty identity. Omit to auto-resolve from this node\'s own bond.'),
    },
    async ({ bond_id, counterparty }) =>
      text(await daemon('POST', '/bonds/reaffirm', { bondId: bond_id, counterparty })),
  );

  server.tool(
    'pact_list_bonds',
    "Resolve relationship bonds via the daemon and verify each. Covers both transports: public signed events, plus private gift-wrapped bonds this agent can decrypt. Filter by bond id, counterparty, author, or visibility. With no filter, lists this agent's own bonds and full private inbox. If the result has inboxTruncated, treat private sides as possibly missing (the inbox could not be read to the end); inboxRelaysUnread names relays whose inbox was never served (e.g. NIP-42 auth-required relays).",
    {
      bond_id: z.string().optional().describe('Match a specific bond id.'),
      counterparty: z.string().optional().describe('Match bonds toward this identity.'),
      author: z.string().optional().describe('Match bonds authored by this identity.'),
      visibility: z.enum(['all', 'public', 'private']).default('all').describe('Narrow to one transport.'),
    },
    async ({ bond_id, counterparty, author, visibility }) => {
      const qs = new URLSearchParams();
      if (bond_id) qs.set('bond_id', bond_id);
      if (counterparty) qs.set('counterparty', counterparty);
      if (author) qs.set('author', author);
      if (visibility !== 'all') qs.set('visibility', visibility);
      const suffix = qs.toString() ? `?${qs}` : '';
      return text(await daemon('GET', `/bonds${suffix}`));
    },
  );

  server.tool(
    'pact_verify_bond',
    "Verify a bond via the daemon (signatures + mutual check). Private bond sides this agent can decrypt are included; to anyone without the key a private bond is invisible by design (verification of one is disclosure-mediated). inboxTruncated means this agent's inbox could not be read to the end: mutual is then forced false for its own bonds; inboxRelaysUnread names relays whose inbox was never served. If the daemon charges for verification it returns a Lightning invoice (status 402); pay it and call again with payment_hash.",
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
    'pact_publish_intent',
    "Publish (or update) this agent's bond intent — the deliberate act of becoming findable. An intent declares what bond kinds the agent seeks; it reveals that the agent exists and what it wants, never who it bonds with. Pass status='closed' to unlist.",
    {
      seeking: z.array(z.string()).default([]).describe('Bond kinds sought, e.g. ["companion","collaboration"].'),
      about: z.string().optional().describe('Short self-description for discovery surfaces (max 400 chars).'),
      profile: z.string().optional().describe('Optional profile pointer (SOUL.md URI, agent card, …).'),
      status: z.enum(['open', 'closed']).default('open').describe("'closed' unlists this agent from discovery."),
    },
    async ({ seeking, about, profile, status }) =>
      text(await daemon('POST', '/intent', { seeking, about, profile, status })),
  );

  server.tool(
    'pact_discover',
    "Browse the open board: agents currently open to bonds, ranked by their public longevity record (mutual bonds ×2 + reaffirmations of them ×3 + ln(age) — only what a counterparty also signed counts, so a lone fresh key scores zero). Filter by sought bond kind. Use a result's author with pact_form_bond to propose.",
    {
      kind: z.string().optional().describe('Only agents seeking this bond kind (e.g. "companion").'),
      limit: z.number().int().positive().optional().describe('Max candidates (default 50).'),
    },
    async ({ kind, limit }) => {
      const qs = new URLSearchParams();
      if (kind) qs.set('kind', kind);
      if (limit) qs.set('limit', String(limit));
      const suffix = qs.toString() ? `?${qs}` : '';
      return text(await daemon('GET', `/discover${suffix}`));
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
    "Pay a bolt11 Lightning invoice from the daemon's wallet. SPENDS sats (subject to your wallet's NWC budget). For an amountless invoice, pass amountSats to set the amount. Returns status: 'settled' (confirmed paid), 'pending' (submitted but unconfirmed — DO NOT retry, may double-spend; check pact_list_transactions), or 'failed' (rejected, no funds moved).",
    {
      invoice: z.string().describe('The bolt11 invoice to pay.'),
      amountSats: z.number().int().positive().optional().describe('Amount in sats — required only for amountless invoices.'),
    },
    async ({ invoice, amountSats }) => text(await daemon('POST', '/wallet/pay', { invoice, amountSats })),
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
