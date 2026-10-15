// The single mutuality predicate, shared by verifyBond (core) and pactd.
//
// "Mutual" is a consent verdict, not a record count: a reciprocal pair whose
// latest signed states complete the handshake, with the two sides pointing
// strictly at each other. Junk signatures, self-tags, mixed directions, and
// superseded/terminal states can never compose a pair.

import type { BondView } from './index.js';

/**
 * Handshake semantics: a `proposed` record is a standing offer; an
 * `accepted`/`active` record is consent to that offer. A mutual bond is an
 * offer matched by consent — so a pair qualifies only when BOTH sides' latest
 * states are in the open set AND at least one side has accepted. Two proposals
 * never compose (`proposed` alone never counts), and terminal states
 * (`rejected`, `revoked`, `withdrawn`, `expired`, `archived`, `paused`,
 * `none`) never count.
 */
const OPEN_STATES: ReadonlySet<string> = new Set(['proposed', 'accepted', 'active']);
const ACCEPT_STATES: ReadonlySet<string> = new Set(['accepted', 'active']);

/**
 * Decide whether `records` prove a mutual bond: a pair of signature-valid
 * records for the same bond id that cross-reference each other
 * (side1.author ↔ side2.counterparty and vice versa, always by distinct
 * authors) and whose latest states complete the handshake — both in the open
 * set, at least one an acceptance (see the state sets above).
 *
 * Records are first reduced to the latest per (author, d) — newest created_at
 * wins, equal timestamps tie-break to the lexicographically lowest id (NIP-01
 * replaceable semantics, the same rule listPrivateBonds applies) — because a
 * mixed-relay merge can surface stale replicas. Invalid-signature records are
 * excluded BEFORE the reduction so a forgery cannot shadow an honest record.
 */
export function computeMutual(records: BondView[], bondId?: string): boolean {
  const latest = new Map<string, BondView>();
  for (const record of records) {
    if (bondId !== undefined && record.bond !== bondId) continue;
    if (!record.signature_valid) continue;
    if (record.bond === null) continue;
    const key = `${record.author}:${record.bond}`;
    const prior = latest.get(key);
    if (
      !prior ||
      record.created_at > prior.created_at ||
      (record.created_at === prior.created_at && record.id < prior.id)
    ) {
      latest.set(key, record);
    }
  }

  const open = [...latest.values()].filter(
    (r): r is BondView & { state: string } => r.state !== null && OPEN_STATES.has(r.state),
  );
  for (const side1 of open) {
    for (const side2 of open) {
      if (side1.author === side2.author) continue;
      if (side1.bond !== side2.bond) continue;
      if (side1.counterparty !== side2.author || side2.counterparty !== side1.author) continue;
      if (ACCEPT_STATES.has(side1.state) || ACCEPT_STATES.has(side2.state)) return true;
    }
  }
  return false;
}
