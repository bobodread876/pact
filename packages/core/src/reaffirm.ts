// Reaffirmation: the deliberate act of choosing a bond again. Publishes a
// kind:1317 `bond.reaffirmed` lifecycle event (gift-wrapped on private bonds).
// Reaffirmations accumulate into the bond's longevity record — the signal that
// a relationship lasted, not just started.

import {
  DEFAULT_RELAYS,
  KIND_BOND_HISTORY,
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
import { PactError } from './errors.js';
import { listBonds, verifyBond, type BondView, type BondVisibility } from './index.js';
import { fetchInbox, listPrivateBonds } from './private.js';

export const REAFFIRM_TYPE = 'bond.reaffirmed';

export interface ReaffirmBondInput {
  bondId: string;
  /** Counterparty identity (did:nostr / npub / hex). Omit to resolve it from the bond. */
  counterparty?: string;
  relays?: string[];
  /**
   * Omit to follow the bond's channel (gift-wrapped when private). Only when
   * BOTH this and `counterparty` are passed is the bond lookup skipped.
   */
  visibility?: BondVisibility;
}

export interface ReaffirmBondResult {
  bondId: string;
  type: typeof REAFFIRM_TYPE;
  visibility: BondVisibility;
  at: string;
  event: { id: string; relays: PublishResult[] };
}

/**
 * Publish a `bond.reaffirmed` lifecycle event for an existing bond.
 *
 * Unless both `counterparty` and `visibility` are given, the bond is resolved
 * from this identity's own view (public sides + its private inbox): it must be
 * mutual with this identity as a party, the counterparty comes from the pair,
 * and the channel echoes this identity's own latest side. There is no public
 * default — guessing "public" for a private bond would publish its id and the
 * two parties' linkage on the open graph.
 */
export async function reaffirmBond(secret: Uint8Array, input: ReaffirmBondInput): Promise<ReaffirmBondResult> {
  const relays = input.relays?.length ? input.relays : DEFAULT_RELAYS;
  const selfHex = keypairFromSecret(secret).pubkeyHex;
  let counterparty = input.counterparty;
  let visibility = input.visibility;

  if (!counterparty || !visibility) {
    const verdict = await verifyBond(input.bondId, relays, {
      secret,
      parties: counterparty ? [counterparty] : [],
    });
    if (!verdict.mutual || !verdict.parties?.includes(selfHex)) {
      throw new PactError(
        'not_found',
        `no mutual bond ${input.bondId} with this identity as a party on these relays — form or accept it first (or pass both counterparty and visibility)`,
      );
    }
    const other = verdict.parties[0] === selfHex ? verdict.parties[1] : verdict.parties[0];
    if (counterparty && pubkeyHexFromIdentity(counterparty) !== other) {
      throw new PactError('conflict', `bond ${input.bondId} is with ${other}, not ${counterparty}`);
    }
    counterparty = counterparty ?? other;
    const own = verdict.bonds
      .filter((b) => b.author === selfHex && b.signature_valid)
      .sort((a, b) => b.created_at - a.created_at)[0];
    visibility = visibility ?? own.visibility;
  }

  const at = new Date().toISOString();
  const subjectDid = keypairFromSecret(secret).did;
  const doc = makeBondDocument(subjectDid, counterparty, {
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
 *
 * Only reaffirmations of this identity's own bonds, by one of that bond's two
 * parties, are kept: anyone can p-tag us with a `bond.reaffirmed` for any bond
 * id, and that must not show up as "they chose this bond again".
 */
export async function listReaffirmations(
  secret: Uint8Array,
  relays: string[] = DEFAULT_RELAYS,
): Promise<{ relaysReached: string[]; reaffirmations: ReaffirmationView[] }> {
  const selfHex = keypairFromSecret(secret).pubkeyHex;

  const [mine, toward, wraps, ownSides, privSides] = await Promise.all([
    resolveEvents(relays, { kinds: [KIND_BOND_HISTORY], '#t': [REAFFIRM_TYPE], authors: [selfHex], limit: 200 }),
    resolveEvents(relays, { kinds: [KIND_BOND_HISTORY], '#t': [REAFFIRM_TYPE], '#p': [selfHex], limit: 200 }),
    fetchInbox(secret, relays),
    listBonds({ authors: [selfHex] }, relays),
    listPrivateBonds(secret, relays),
  ]);

  // This identity's bonds, from its own sides: bond id → the counterparties it
  // named. A reaffirmation counts only from self or from one of those.
  const counterparties = new Map<string, Set<string>>();
  for (const b of [...ownSides.bonds, ...privSides.bonds]) {
    if (b.author !== selfHex || !b.bond || !b.counterparty || !b.signature_valid) continue;
    const set = counterparties.get(b.bond) ?? new Set<string>();
    set.add(b.counterparty);
    counterparties.set(b.bond, set);
  }
  const isParty = (bondId: string, author: string) => {
    const set = counterparties.get(bondId);
    return Boolean(set && (author === selfHex || set.has(author)));
  };

  const latest = new Map<string, ReaffirmationView>();
  const fold = (bondId: string | null, author: string, at: number, visibility: BondVisibility) => {
    if (!bondId || !isParty(bondId, author)) return;
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
