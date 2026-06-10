// Reaffirmation: the deliberate act of choosing a bond again. Publishes a
// kind:1317 `bond.reaffirmed` lifecycle event (gift-wrapped on private bonds).
// Reaffirmations accumulate into the bond's longevity record — the signal that
// a relationship lasted, not just started.

import {
  DEFAULT_RELAYS,
  KIND_BOND_HISTORY,
  KIND_GIFT_WRAP,
  buildBondHistoryEvent,
  buildPrivateBondHistoryEvents,
  keypairFromSecret,
  publishEvent,
  pubkeyHexFromIdentity,
  resolveEvents,
  selectBondRumors,
  verifyEvent,
  type PublishResult,
  type Transition,
} from '@mate-protocol/core';

import { makeBondDocument } from './bond.js';
import type { BondVisibility } from './index.js';

export const REAFFIRM_TYPE = 'bond.reaffirmed';

export interface ReaffirmBondInput {
  bondId: string;
  /** Counterparty identity (did:nostr / npub / hex). */
  counterparty: string;
  relays?: string[];
  /** Publish on the bond's channel: gift-wrapped when private. */
  visibility?: BondVisibility;
}

export interface ReaffirmBondResult {
  bondId: string;
  type: typeof REAFFIRM_TYPE;
  visibility: BondVisibility;
  at: string;
  event: { id: string; relays: PublishResult[] };
}

/** Publish a `bond.reaffirmed` lifecycle event for an existing bond. */
export async function reaffirmBond(secret: Uint8Array, input: ReaffirmBondInput): Promise<ReaffirmBondResult> {
  const relays = input.relays?.length ? input.relays : DEFAULT_RELAYS;
  const visibility = input.visibility ?? 'public';
  const at = new Date().toISOString();
  const subjectDid = keypairFromSecret(secret).did;
  const doc = makeBondDocument(subjectDid, input.counterparty, {
    bondId: input.bondId,
    state: 'active',
  });
  const transition: Transition = { from: 'active', to: 'active', type: REAFFIRM_TYPE, at };
  const createdAt = Math.floor(Date.now() / 1000);

  if (visibility === 'private') {
    const events = buildPrivateBondHistoryEvents(doc, secret, transition, { createdAt });
    const toCounterparty = await publishEvent(relays, events.toCounterparty);
    await publishEvent(relays, events.toSelf);
    return { bondId: input.bondId, type: REAFFIRM_TYPE, visibility, at, event: { id: events.rumor.id, relays: toCounterparty } };
  }

  const event = buildBondHistoryEvent(doc, secret, transition, { createdAt });
  return {
    bondId: input.bondId,
    type: REAFFIRM_TYPE,
    visibility,
    at,
    event: { id: event.id, relays: await publishEvent(relays, event) },
  };
}

export interface ReaffirmationView {
  bondId: string;
  author: string;
  /** Latest reaffirmation, unix seconds. */
  at: number;
  count: number;
  visibility: BondVisibility;
}

/**
 * Resolve reaffirmations visible to this identity — public `bond.reaffirmed`
 * events it authored or that p-tag it, plus private ones in its encrypted
 * inbox — reduced to latest-per-(bond, author). One call covers a whole UI.
 */
export async function listReaffirmations(
  secret: Uint8Array,
  relays: string[] = DEFAULT_RELAYS,
): Promise<{ relaysReached: string[]; reaffirmations: ReaffirmationView[] }> {
  const selfHex = keypairFromSecret(secret).pubkeyHex;

  const [mine, toward, wraps] = await Promise.all([
    resolveEvents(relays, { kinds: [KIND_BOND_HISTORY], '#t': [REAFFIRM_TYPE], authors: [selfHex], limit: 200 }),
    resolveEvents(relays, { kinds: [KIND_BOND_HISTORY], '#t': [REAFFIRM_TYPE], '#p': [selfHex], limit: 200 }),
    resolveEvents(relays, { kinds: [KIND_GIFT_WRAP], '#p': [selfHex], limit: 200 }),
  ]);

  const latest = new Map<string, ReaffirmationView>();
  const fold = (bondId: string | null, author: string, at: number, visibility: BondVisibility) => {
    if (!bondId) return;
    const key = `${bondId}:${author}`;
    const prior = latest.get(key);
    if (prior) {
      prior.count += 1;
      if (at > prior.at) prior.at = at;
    } else {
      latest.set(key, { bondId, author, at, count: 1, visibility });
    }
  };

  const tag = (tags: string[][], name: string, skip?: string) =>
    tags.find((t) => t[0] === name && t[1] !== skip)?.[1] ?? null;

  for (const event of [...mine.events, ...toward.events]) {
    if (!verifyEvent(event)) continue;
    fold(tag(event.tags, 'd'), event.pubkey, event.created_at, 'public');
  }
  for (const rumor of selectBondRumors(wraps.events, secret)) {
    if (rumor.rumor.kind !== KIND_BOND_HISTORY) continue;
    if (tag(rumor.rumor.tags, 't', 'mate-bond') !== REAFFIRM_TYPE) continue;
    fold(rumor.bond, rumor.author, rumor.rumor.created_at, 'private');
  }

  return {
    relaysReached: [...new Set([...mine.relaysReached, ...toward.relaysReached, ...wraps.relaysReached])],
    reaffirmations: [...latest.values()].sort((a, b) => b.at - a.at),
  };
}
