// pact-core — the agent-relationship runtime.
//
// Identity, bond signing, and transport come from the L1 protocol package
// (@mate-protocol/core). This package adds the L2 runtime helpers on top.
// (L2 depends on L1; L1 never depends on L2.)

export * from '@mate-protocol/core';
export { makeBondDocument, type BondState, type MakeBondOptions } from './bond.js';
export * from './keystore.js';
export { listPrivateBonds, type PrivateBondFilter } from './private.js';

import {
  BOND_TAG,
  DEFAULT_RELAYS,
  buildBondHistoryEvent,
  buildBondStateEvent,
  buildPrivateBondEvents,
  keypairFromSecret,
  publishEvent,
  resolveEvents,
  signMateDocumentNostr,
  verifyEvent,
  type NostrEvent,
  type PublishResult,
  type RelayFilter,
} from '@mate-protocol/core';

import { randomUUID } from 'node:crypto';

import { makeBondDocument, type BondState } from './bond.js';
import { listPrivateBonds } from './private.js';

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

export type BondVisibility = 'public' | 'private';

export interface FormBondInput {
  /** Counterparty identity (did:nostr / npub / hex). */
  counterparty: string;
  /** Opaque bond id. Omit to auto-generate `urn:mate:<uuid>` (the proposer's id). */
  bondId?: string;
  state: BondState;
  kind?: string;
  relays?: string[];
  /** Also publish a kind:1317 history event (public transport only). */
  history?: boolean;
  /**
   * 'public' (default): a signed kind:30317 event, visible to every relay
   * observer. 'private': the bond stays a NIP-59 gift-wrapped rumor with an
   * embedded BIP-340 document proof — relays see only an ephemeral author and
   * the recipient's p tag; only the two parties (or whoever they disclose the
   * document to) can read or verify it.
   */
  visibility?: BondVisibility;
}

export interface FormBondResult {
  bondId: string;
  state: BondState;
  visibility: BondVisibility;
  /** Public: the signed kind:30317 event. Private: the rumor id + the counterparty wrap's publish results. */
  stateEvent: { id: string; relays: PublishResult[] };
  historyEvent?: { id: string; relays: PublishResult[] };
  /** Private only: both gift wraps as published. */
  wraps?: {
    toCounterparty: { id: string; relays: PublishResult[] };
    toSelf: { id: string; relays: PublishResult[] };
  };
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

  if (input.visibility === 'private') {
    // Rumors are unsigned — the embedded proof is the bond's authorship
    // evidence and what selective disclosure verifies (extension §13.3).
    doc.proofs = [signMateDocumentNostr(doc, secret)];
    const events = buildPrivateBondEvents(doc, secret, { createdAt });
    const toCounterparty = await publishEvent(relays, events.toCounterparty);
    const toSelf = await publishEvent(relays, events.toSelf);
    return {
      bondId,
      state: input.state,
      visibility: 'private',
      stateEvent: { id: events.rumor.id, relays: toCounterparty },
      wraps: {
        toCounterparty: { id: events.toCounterparty.id, relays: toCounterparty },
        toSelf: { id: events.toSelf.id, relays: toSelf },
      },
    };
  }

  const stateEvent = buildBondStateEvent(doc, secret, { createdAt });
  const result: FormBondResult = {
    bondId,
    state: input.state,
    visibility: 'public',
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
  /**
   * Public: the Nostr event signature verified. Private: the full unwrap chain
   * held AND the embedded document proof verified against the authenticated
   * author (see private.ts).
   */
  signature_valid: boolean;
  visibility: BondVisibility;
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
      visibility: 'public' as const,
    }));
  return { relaysReached, bonds };
}

export interface VerifyBondResult {
  bondId: string;
  relaysReached: string[];
  count: number;
  /** Both sides published a valid state event that cross-references the other. */
  mutual: boolean;
  /** True when any side of the bond arrived via the private transport. */
  private?: boolean;
  bonds: BondView[];
}

export interface VerifyBondOptions {
  /**
   * This node's secret key. When given, the verdict also covers the private
   * transport: gift wraps addressed to this key are unwrapped and merged into
   * the mutuality check. Without it only public events are visible — a private
   * bond verifies as "not found" to outsiders, by design.
   */
  secret?: Uint8Array;
}

/**
 * Resolve every state event for a bond id, verify signatures, and decide whether
 * the bond is *mutual*: at least two signed sides where some side p-tags another
 * side's author. Shared by pactd's /bonds/verify and the SDK/CLI.
 *
 * With `options.secret`, private (gift-wrapped) sides this key can decrypt are
 * included — so the two parties see their mutual private bond verified, while
 * third parties see nothing.
 */
export async function verifyBond(
  bondId: string,
  relays: string[] = DEFAULT_RELAYS,
  options: VerifyBondOptions = {},
): Promise<VerifyBondResult> {
  const { relaysReached, bonds } = await listBonds({ '#d': [bondId] }, relays);

  let merged = bonds;
  let reached = relaysReached;
  if (options.secret) {
    const priv = await listPrivateBonds(options.secret, relays, { bondId });
    merged = [...bonds, ...priv.bonds];
    reached = [...new Set([...relaysReached, ...priv.relaysReached])];
  }

  const authors = new Set(merged.map((b) => b.author));
  const mutual =
    merged.length >= 2 &&
    merged.every((b) => b.signature_valid) &&
    merged.some((b) => authors.has(b.counterparty ?? ''));
  const anyPrivate = merged.some((b) => b.visibility === 'private');
  return {
    bondId,
    relaysReached: reached,
    count: merged.length,
    mutual,
    ...(anyPrivate ? { private: true } : {}),
    bonds: merged,
  };
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
  /**
   * Omit to echo the proposal's channel: a privately-proposed bond is accepted
   * privately, a public one publicly. Set explicitly to override (e.g. the
   * §13.7 consensual go-public transition).
   */
  visibility?: BondVisibility;
}

/**
 * Accept a proposed bond: publish the reciprocal side using the proposer's bond
 * id (so the two events share one `d` tag and resolve as mutual). If no
 * counterparty is given, it's resolved from the relays — the author of the
 * inbound proposal (public event or decryptable gift wrap) that p-tags this
 * identity for `bondId`.
 */
export async function acceptBond(secret: Uint8Array, input: AcceptBondInput): Promise<FormBondResult> {
  const relays = input.relays?.length ? input.relays : DEFAULT_RELAYS;
  let counterparty = input.counterparty;
  let visibility = input.visibility;

  if (!counterparty || !visibility) {
    const selfHex = keypairFromSecret(secret).pubkeyHex;
    const { bonds: publicBonds } = await listBonds({ '#d': [input.bondId], '#p': [selfHex] }, relays);
    const { bonds: privateBonds } = await listPrivateBonds(secret, relays, {
      bondId: input.bondId,
      counterparty: selfHex,
    });
    const inbound = [...publicBonds, ...privateBonds].filter((b) => b.author !== selfHex);
    const proposers = [...new Set(inbound.map((b) => b.author))];

    if (!counterparty) {
      if (proposers.length === 0) {
        throw new Error(`no inbound proposal for bond ${input.bondId} (none p-tagging this identity) — pass counterparty explicitly`);
      }
      if (proposers.length > 1) {
        throw new Error(`ambiguous: ${proposers.length} proposers for bond ${input.bondId} — pass counterparty explicitly`);
      }
      counterparty = proposers[0];
    }

    if (!visibility) {
      // Echo the channel the (resolved) proposer used; default public when the
      // proposal isn't visible to us at all.
      const proposal = inbound.find((b) => b.author === counterparty);
      visibility = proposal?.visibility ?? 'public';
    }
  }

  return formBond(secret, {
    counterparty,
    bondId: input.bondId,
    state: input.state ?? 'active',
    kind: input.kind,
    relays: input.relays,
    history: input.history,
    visibility,
  });
}
