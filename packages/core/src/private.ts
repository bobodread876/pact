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
  type PrivateBondRumor,
} from '@mate-protocol/core';

import { kindFromContent } from './bond.js';
import type { BondView } from './index.js';

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
function toBondView(r: PrivateBondRumor): BondView {
  let proofValid = false;
  try {
    const doc = JSON.parse(r.rumor.content) as MateDocument;
    const proofs = doc.proofs ?? [];
    proofValid =
      proofs.length > 0 &&
      proofs.every((proof) => verifyProof(doc, proof)) &&
      pubkeyHexFromIdentity(doc.subject.id) === r.author;
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
  const selfHex = keypairFromSecret(secret).pubkeyHex;
  const { events, relaysReached } = await resolveEvents(relays, {
    kinds: [KIND_GIFT_WRAP],
    '#p': [selfHex],
    limit: 200,
  });

  const authorHex = filter.author ? pubkeyHexFromIdentity(filter.author) : null;
  const counterpartyHex = filter.counterparty ? pubkeyHexFromIdentity(filter.counterparty) : null;

  const latest = new Map<string, BondView>();
  for (const rumor of selectBondRumors(events, secret)) {
    // State views come from kind:30317 rumors only; kind:1317 lifecycle rumors
    // (reaffirmations etc.) are resolved separately by listReaffirmations.
    if (rumor.rumor.kind !== KIND_BOND_STATE) continue;
    if (filter.bondId && rumor.bond !== filter.bondId) continue;
    if (authorHex && rumor.author !== authorHex) continue;
    if (counterpartyHex && rumor.counterparty !== counterpartyHex) continue;
    const view = toBondView(rumor);
    const key = `${view.author}:${view.bond ?? view.id}`;
    const prior = latest.get(key);
    // NIP-01 replaceable semantics, applied client-side: newest created_at
    // wins; equal timestamps tie-break to the lexicographically lowest id.
    if (
      !prior ||
      view.created_at > prior.created_at ||
      (view.created_at === prior.created_at && view.id < prior.id)
    ) {
      latest.set(key, view);
    }
  }

  const bonds = [...latest.values()].sort((a, b) => b.created_at - a.created_at);
  return { relaysReached, bonds };
}
