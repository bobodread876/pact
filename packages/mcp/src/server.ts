import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  DEFAULT_RELAYS,
  ensureIdentity,
  formBond,
  hasIdentity,
  listBonds,
  loadIdentity,
  loadSecret,
  pubkeyHexFromIdentity,
  type BondState,
  type RelayFilter,
} from '@pact/core';

const BOND_STATES = [
  'proposed',
  'accepted',
  'active',
  'paused',
  'revoked',
  'withdrawn',
  'rejected',
] as const;

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

export function createServer(): McpServer {
  const server = new McpServer({ name: 'pact-mcp', version: '0.1.0' });

  server.tool(
    'pact_keygen',
    'Create this agent\'s self-sovereign Nostr identity (did:nostr) for forming relationship bonds. Stored locally at ~/.pact. Idempotent unless force=true.',
    { force: z.boolean().default(false).describe('Regenerate even if an identity already exists (destructive).') },
    async ({ force }) => text(ensureIdentity(force)),
  );

  server.tool(
    'pact_whoami',
    "Return this agent's bond identity (did:nostr / npub / pubkey), or indicate none exists yet.",
    {},
    async () => {
      if (!hasIdentity()) return text({ identity: null, hint: 'run pact_keygen first' });
      const id = loadIdentity();
      return text({ did: id.did, npub: id.npub, pubkeyHex: id.pubkeyHex });
    },
  );

  server.tool(
    'pact_form_bond',
    'Declare or update a relationship bond toward a counterparty and publish it to relays. Use state="proposed" to offer a bond, "accepted"/"active" to reciprocate, "revoked" to end it.',
    {
      counterparty: z.string().describe('Counterparty identity: did:nostr / npub / 64-hex pubkey.'),
      bond_id: z.string().describe('Stable bond id shared by both parties, e.g. "urn:mate:my-bond-01".'),
      state: z.enum(BOND_STATES).default('proposed').describe('Bond state to declare.'),
      kind: z.string().default('companion').describe('Relationship kind (e.g. companion, collaboration).'),
      relays: z.array(z.string()).optional().describe('Relay URLs (defaults to Pact public relays).'),
      history: z.boolean().default(true).describe('Also publish a kind:1317 history event.'),
    },
    async ({ counterparty, bond_id, state, kind, relays, history }) => {
      const result = await formBond(loadSecret(), {
        counterparty,
        bondId: bond_id,
        state: state as BondState,
        kind,
        relays,
        history,
      });
      return text(result);
    },
  );

  server.tool(
    'pact_list_bonds',
    'Resolve relationship bonds from relays and verify each signature. Filter by bond id, counterparty, or author. With no filter, lists this agent\'s own bonds.',
    {
      bond_id: z.string().optional().describe('Match a specific bond id (d tag).'),
      counterparty: z.string().optional().describe('Match bonds toward this identity (p tag).'),
      author: z.string().optional().describe('Match bonds authored by this identity. Defaults to self.'),
      relays: z.array(z.string()).optional().describe('Relay URLs (defaults to Pact public relays).'),
    },
    async ({ bond_id, counterparty, author, relays }) => {
      const filter: Pick<RelayFilter, 'authors' | '#d' | '#p'> = {};
      if (author) filter.authors = [pubkeyHexFromIdentity(author)];
      if (counterparty) filter['#p'] = [pubkeyHexFromIdentity(counterparty)];
      if (bond_id) filter['#d'] = [bond_id];
      if (!author && !counterparty && !bond_id && hasIdentity()) {
        filter.authors = [loadIdentity().pubkeyHex];
      }
      const result = await listBonds(filter, relays?.length ? relays : DEFAULT_RELAYS);
      return text(result);
    },
  );

  server.tool(
    'pact_verify_bond',
    'Resolve a specific bond and report whether each side\'s event signature is valid and whether it is a mutual bond (both parties p-tagging each other).',
    {
      bond_id: z.string().describe('The bond id to verify.'),
      relays: z.array(z.string()).optional().describe('Relay URLs (defaults to Pact public relays).'),
    },
    async ({ bond_id, relays }) => {
      const { relaysReached, bonds } = await listBonds({ '#d': [bond_id] }, relays?.length ? relays : DEFAULT_RELAYS);
      const authors = new Set(bonds.map((b) => b.author));
      const mutual =
        bonds.length >= 2 &&
        bonds.every((b) => b.signature_valid) &&
        bonds.some((b) => authors.has(b.counterparty ?? ''));
      return text({ bond_id, relaysReached, count: bonds.length, mutual, bonds });
    },
  );

  return server;
}
