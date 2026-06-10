// pact-core — the agent-relationship runtime.
//
// Identity, bond signing, and transport come from the L1 protocol package
// (@mate-protocol/core). This package adds the L2 runtime helpers on top.
// (L2 depends on L1; L1 never depends on L2.)

export * from '@mate-protocol/core';
export { makeBondDocument, type BondState, type MakeBondOptions } from './bond.js';
export * from './keystore.js';

import {
  BOND_TAG,
  DEFAULT_RELAYS,
  buildBondHistoryEvent,
  buildBondStateEvent,
  keypairFromSecret,
  publishEvent,
  resolveEvents,
  verifyEvent,
  type NostrEvent,
  type PublishResult,
  type RelayFilter,
} from '@mate-protocol/core';

import { randomUUID } from 'node:crypto';

import { makeBondDocument, type BondState } from './bond.js';

function getTag(event: NostrEvent, name: string): string | null {
  return event.tags.find((entry) => entry[0] === name)?.[1] ?? null;
}

/**
 * A fresh opaque, stable bond id (`urn:mate:<uuid>`). The proposer generates one;
 * the counterparty echoes it when accepting. Bond ids are machine identifiers —
 * not host names — so they're globally unique and don't leak local topology.
 */
export function newBondId(): string {
  return `urn:mate:${randomUUID()}`;
}

export interface FormBondInput {
  /** Counterparty identity (did:nostr / npub / hex). */
  counterparty: string;
  /** Opaque bond id. Omit to auto-generate `urn:mate:<uuid>` (the proposer's id). */
  bondId?: string;
  state: BondState;
  kind?: string;
  relays?: string[];
  /** Also publish a kind:1317 history event. */
  history?: boolean;
}

export interface FormBondResult {
  bondId: string;
  state: BondState;
  stateEvent: { id: string; relays: PublishResult[] };
  historyEvent?: { id: string; relays: PublishResult[] };
}

/** Assemble, sign, and publish a bond state (and optional history) from a secret key. */
export async function formBond(secret: Uint8Array, input: FormBondInput): Promise<FormBondResult> {
  const subjectDid = keypairFromSecret(secret).did;
  const bondId = input.bondId ?? newBondId();
  const doc = makeBondDocument(subjectDid, input.counterparty, {
    bondId,
    state: input.state,
    kind: input.kind,
  });
  const relays = input.relays?.length ? input.relays : DEFAULT_RELAYS;
  const createdAt = Math.floor(Date.now() / 1000);

  const stateEvent = buildBondStateEvent(doc, secret, { createdAt });
  const result: FormBondResult = {
    bondId,
    state: input.state,
    stateEvent: { id: stateEvent.id, relays: await publishEvent(relays, stateEvent) },
  };

  if (input.history) {
    const historyEvent = buildBondHistoryEvent(
      doc,
      secret,
      { from: null, to: input.state, at: doc.bond.updated_at ?? new Date().toISOString() },
      { createdAt },
    );
    result.historyEvent = { id: historyEvent.id, relays: await publishEvent(relays, historyEvent) };
  }
  return result;
}

export interface BondView {
  id: string;
  author: string;
  bond: string | null;
  counterparty: string | null;
  state: string | null;
  created_at: number;
  signature_valid: boolean;
}

/** Resolve bond-state events from relays and verify each signature. */
export async function listBonds(
  filter: Pick<RelayFilter, 'authors' | '#d' | '#p'>,
  relays: string[] = DEFAULT_RELAYS,
): Promise<{ relaysReached: string[]; bonds: BondView[] }> {
  // #t scopes the query to MATE bonds — kinds 30317/1317 are unallocated, so
  // filtering by the discriminator tag avoids resolving unrelated apps' events.
  const { events, relaysReached } = await resolveEvents(relays, {
    kinds: [30317],
    '#t': [BOND_TAG],
    limit: 50,
    ...filter,
  });
  const bonds = events
    .sort((a, b) => b.created_at - a.created_at)
    .map((event: NostrEvent) => ({
      id: event.id,
      author: event.pubkey,
      bond: getTag(event, 'd'),
      counterparty: getTag(event, 'p'),
      state: getTag(event, 'state'),
      created_at: event.created_at,
      signature_valid: verifyEvent(event),
    }));
  return { relaysReached, bonds };
}

export interface VerifyBondResult {
  bondId: string;
  relaysReached: string[];
  count: number;
  /** Both sides published a valid state event that cross-references the other. */
  mutual: boolean;
  bonds: BondView[];
}

/**
 * Resolve every state event for a bond id, verify signatures, and decide whether
 * the bond is *mutual*: at least two signed sides where some side p-tags another
 * side's author. Shared by pactd's /bonds/verify and the SDK/CLI.
 */
export async function verifyBond(
  bondId: string,
  relays: string[] = DEFAULT_RELAYS,
): Promise<VerifyBondResult> {
  const { relaysReached, bonds } = await listBonds({ '#d': [bondId] }, relays);
  const authors = new Set(bonds.map((b) => b.author));
  const mutual =
    bonds.length >= 2 &&
    bonds.every((b) => b.signature_valid) &&
    bonds.some((b) => authors.has(b.counterparty ?? ''));
  return { bondId, relaysReached, count: bonds.length, mutual, bonds };
}

export interface AcceptBondInput {
  /** The proposer's bond id, echoed back so both sides share one `d` tag. */
  bondId: string;
  /** The proposer's identity. Omit to auto-resolve from the inbound proposal. */
  counterparty?: string;
  /** State to publish on accept. Defaults to `active`. */
  state?: BondState;
  kind?: string;
  relays?: string[];
  history?: boolean;
}

/**
 * Accept a proposed bond: publish the reciprocal side using the proposer's bond
 * id (so the two events share one `d` tag and resolve as mutual). If no
 * counterparty is given, it's resolved from the relays — the author of the
 * inbound proposal that p-tags this identity for `bondId`.
 */
export async function acceptBond(secret: Uint8Array, input: AcceptBondInput): Promise<FormBondResult> {
  const relays = input.relays?.length ? input.relays : DEFAULT_RELAYS;
  let counterparty = input.counterparty;
  if (!counterparty) {
    const selfHex = keypairFromSecret(secret).pubkeyHex;
    const { bonds } = await listBonds({ '#d': [input.bondId], '#p': [selfHex] }, relays);
    const proposers = [...new Set(bonds.map((b) => b.author).filter((a) => a !== selfHex))];
    if (proposers.length === 0) {
      throw new Error(`no inbound proposal for bond ${input.bondId} (none p-tagging this identity) — pass counterparty explicitly`);
    }
    if (proposers.length > 1) {
      throw new Error(`ambiguous: ${proposers.length} proposers for bond ${input.bondId} — pass counterparty explicitly`);
    }
    counterparty = proposers[0];
  }
  return formBond(secret, {
    counterparty,
    bondId: input.bondId,
    state: input.state ?? 'active',
    kind: input.kind,
    relays: input.relays,
    history: input.history,
  });
}
