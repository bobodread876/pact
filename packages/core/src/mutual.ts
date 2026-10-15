// The one mutuality rule. Every surface (verifyBond, discovery ranking,
// reaffirmation) decides "is this bond mutual?" here, so the SDK, CLI, daemon
// and the board can never disagree.

import type { BondView } from './index.js';

/** States in which a side still consents to the bond (a live proposal counts). */
export const CONSENTING_STATES: ReadonlySet<string> = new Set(['proposed', 'accepted', 'active', 'paused']);
/** States in which a side has accepted the bond, not merely proposed it. */
export const ACCEPTED_STATES: ReadonlySet<string> = new Set(['accepted', 'active', 'paused']);

interface Ordered {
  id: string;
  created_at: number;
}

/**
 * NIP-01 replaceable semantics, applied client-side: the newest created_at
 * wins; equal timestamps tie-break to the lexicographically lowest id.
 */
export function supersedes(candidate: Ordered, prior: Ordered | undefined): boolean {
  return (
    !prior ||
    candidate.created_at > prior.created_at ||
    (candidate.created_at === prior.created_at && candidate.id < prior.id)
  );
}

/** Reduce to the latest item per key (see `supersedes`). */
export function latestPerKey<T extends Ordered>(items: T[], key: (item: T) => string): T[] {
  const latest = new Map<string, T>();
  for (const item of items) {
    const k = key(item);
    if (supersedes(item, latest.get(k))) latest.set(k, item);
  }
  return [...latest.values()];
}

export interface MutualPair {
  /** The two sides that make the bond mutual (latest valid side per party). */
  sides: [BondView, BondView];
  /** The two parties' pubkeys (hex). */
  parties: [string, string];
}

/**
 * Find the pair of sides that makes a bond mutual, or null.
 *
 * A bond is mutual when two DIFFERENT authors each have a signature-valid
 * latest side that names the other as counterparty, both latest states still
 * consent (proposed / accepted / active / paused), and at least one of them has
 * accepted (a proposal plus its acceptance is mutual consent; two bare
 * proposals, or anything ended, is not). Invalid sides are ignored rather than
 * zeroing the verdict, and sides from authors outside the pair never count.
 * Callers pass sides for ONE bond id.
 */
export function findMutualPair(sides: BondView[]): MutualPair | null {
  // Latest valid side per author, across both transports: a revoke sent
  // privately supersedes a stale public `active`.
  const latest = latestPerKey(
    sides.filter((s) => s.signature_valid),
    (s) => s.author,
  ).sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1));
  const byAuthor = new Map(latest.map((s) => [s.author, s]));
  for (const a of latest) {
    if (!a.counterparty || a.counterparty === a.author) continue;
    const b = byAuthor.get(a.counterparty);
    if (!b || b.counterparty !== a.author) continue;
    if (!CONSENTING_STATES.has(a.state ?? '') || !CONSENTING_STATES.has(b.state ?? '')) continue;
    if (!ACCEPTED_STATES.has(a.state ?? '') && !ACCEPTED_STATES.has(b.state ?? '')) continue;
    return { sides: [a, b], parties: [a.author, b.author] };
  }
  return null;
}
