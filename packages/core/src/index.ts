// @pact/core — the agent-relationship runtime.
//
// Identity, bond signing, and transport come from the L1 protocol package
// (@mate-protocol/core). This package adds the L2 runtime helpers on top.
// (L2 depends on L1; L1 never depends on L2.)

export * from '@mate-protocol/core';
export { makeBondDocument, type BondState, type MakeBondOptions } from './bond.js';
export * from './keystore.js';

import {
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

import { makeBondDocument, type BondState } from './bond.js';

function getTag(event: NostrEvent, name: string): string | null {
  return event.tags.find((entry) => entry[0] === name)?.[1] ?? null;
}

export interface FormBondInput {
  /** Counterparty identity (did:nostr / npub / hex). */
  counterparty: string;
  bondId: string;
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
  const doc = makeBondDocument(subjectDid, input.counterparty, {
    bondId: input.bondId,
    state: input.state,
    kind: input.kind,
  });
  const relays = input.relays?.length ? input.relays : DEFAULT_RELAYS;
  const createdAt = Math.floor(Date.now() / 1000);

  const stateEvent = buildBondStateEvent(doc, secret, { createdAt });
  const result: FormBondResult = {
    bondId: input.bondId,
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
  const { events, relaysReached } = await resolveEvents(relays, { kinds: [30317], limit: 50, ...filter });
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
