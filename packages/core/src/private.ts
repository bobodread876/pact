// Private bond runtime: resolve and authenticate gift-wrapped bonds.
//
// The wire mechanism (NIP-44, NIP-59, embedded-proof rule) is L1
// (@mate-protocol/core, extension §13); this module is the L2 runtime view —
// turning an encrypted inbox into the same BondView shape the public path
// produces, so daemons and SDKs can treat both transports uniformly.

import {
  KIND_BOND_STATE,
  KIND_GIFT_WRAP,
  keypairFromSecret,
  pubkeyHexFromIdentity,
  resolveEvents,
  selectBondRumors,
  verifyProof,
  type MateDocument,
  type NostrEvent,
  type PrivateBondRumor,
  type RelayFilter,
} from '@mate-protocol/core';

import { kindFromContent } from './bond.js';
import type { BondView } from './index.js';
import { latestPerKey } from './mutual.js';

/** Wraps fetched per page when reading an inbox. */
const INBOX_PAGE = 200;
/** Upper bound on pages read (INBOX_PAGE × this wraps), so a flood can't hang a read. */
const INBOX_MAX_PAGES = 50;

/**
 * Fetch every kind:1059 gift wrap addressed to `secret`'s key, paging backwards
 * with `until` cursors. One fixed window is not enough: the inbox is
 * public-write and shared with NIP-17 DMs, and NIP-59 backdates wraps by up to
 * two days, so a single page of the newest wraps can push a real proposal out.
 */
export async function fetchInbox(
  secret: Uint8Array,
  relays: string[],
): Promise<{ relaysReached: string[]; events: NostrEvent[] }> {
  const selfHex = keypairFromSecret(secret).pubkeyHex;
  const byId = new Map<string, NostrEvent>();
  const reached = new Set<string>();
  let until: number | undefined;
  for (let page = 0; page < INBOX_MAX_PAGES; page++) {
    const filter = {
      kinds: [KIND_GIFT_WRAP],
      '#p': [selfHex],
      limit: INBOX_PAGE,
      ...(until === undefined ? {} : { until }),
    } as RelayFilter;
    const { events, relaysReached } = await resolveEvents(relays, filter);
    for (const r of relaysReached) reached.add(r);
    let fresh = 0;
    let oldest = Infinity;
    for (const event of events) {
      if (!byId.has(event.id)) {
        byId.set(event.id, event);
        fresh += 1;
      }
      oldest = Math.min(oldest, event.created_at);
    }
    // Done when a page brings nothing new or is short on every relay. `until`
    // is inclusive, so events sharing the oldest second are re-read, never lost.
    if (fresh === 0 || events.length < INBOX_PAGE || !Number.isFinite(oldest)) break;
    until = oldest;
  }
  return { relaysReached: [...reached], events: [...byId.values()] };
}

export interface PrivateBondFilter {
  /** Match a specific bond id (post-decryption — wraps carry no bond tags). */
  bondId?: string;
  /** Match rumors authored by this identity. */
  author?: string;
  /** Match rumors p-tagging this identity. */
  counterparty?: string;
}

/**
 * Authenticate a private bond rumor end-to-end and project it as a BondView.
 *
 * `signature_valid` for a private bond means the full chain held:
 * seal signature (checked during unwrap) → seal/rumor author match → embedded
 * document proof verifies → document subject is the authenticated author.
 * Public bonds get the same flag from the event signature alone; the embedded
 * proof is what survives disclosure, so it is what we verify here.
 */
export function toBondView(r: PrivateBondRumor): BondView {
  let proofValid = false;
  try {
    const doc = JSON.parse(r.rumor.content) as MateDocument;
    const proofs = doc.proofs ?? [];
    proofValid =
      proofs.length > 0 &&
      // Every proof verifies AND is made by the authenticated author's key
      // (verifyProof checks the signature, not who the verificationMethod is).
      proofs.every((proof) => verifyProof(doc, proof) && pubkeyHexFromIdentity(proof.verificationMethod) === r.author) &&
      pubkeyHexFromIdentity(doc.subject.id) === r.author &&
      // The signed document must say what the rumor tags (which the BondView
      // reports and the verdict counts) say — otherwise disclosure would prove
      // something other than what was counted.
      doc.bond.id === r.bond &&
      pubkeyHexFromIdentity(doc.object.id) === r.counterparty &&
      doc.bond.state === r.state;
  } catch {
    proofValid = false;
  }
  return {
    id: r.rumor.id,
    author: r.author,
    bond: r.bond,
    counterparty: r.counterparty,
    state: r.state,
    kind: kindFromContent(r.rumor.content),
    created_at: r.rumor.created_at,
    signature_valid: proofValid,
    visibility: 'private',
  };
}

/**
 * Resolve this identity's private bond inbox: fetch kind:1059 gift wraps
 * addressed to the key, unwrap + authenticate each, and project bond rumors
 * to BondViews. Wraps that fail any check are skipped (inboxes are
 * public-write), and only the latest rumor per (author, bond) survives —
 * kind:1059 is a regular kind, so the client performs the replaceable
 * reduction the relay does for public kind:30317.
 */
export async function listPrivateBonds(
  secret: Uint8Array,
  relays: string[],
  filter: PrivateBondFilter = {},
): Promise<{ relaysReached: string[]; bonds: BondView[] }> {
  const { events, relaysReached } = await fetchInbox(secret, relays);

  const authorHex = filter.author ? pubkeyHexFromIdentity(filter.author) : null;
  const counterpartyHex = filter.counterparty ? pubkeyHexFromIdentity(filter.counterparty) : null;

  const views: BondView[] = [];
  for (const rumor of selectBondRumors(events, secret)) {
    // State views come from kind:30317 rumors only; kind:1317 lifecycle rumors
    // (reaffirmations etc.) are resolved separately by listReaffirmations.
    if (rumor.rumor.kind !== KIND_BOND_STATE) continue;
    if (filter.bondId && rumor.bond !== filter.bondId) continue;
    if (authorHex && rumor.author !== authorHex) continue;
    if (counterpartyHex && rumor.counterparty !== counterpartyHex) continue;
    views.push(toBondView(rumor));
  }

  // kind:1059 is a regular kind, so perform the replaceable reduction the relay
  // does for public kind:30317: latest per (author, bond).
  const bonds = latestPerKey(views, (v) => `${v.author}:${v.bond ?? v.id}`).sort((a, b) => b.created_at - a.created_at);
  return { relaysReached, bonds };
}
