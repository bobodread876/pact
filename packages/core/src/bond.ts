// L2 bond assembly. Builds a MATE.md document (the L1 type) from bond params.

import type { MateDocument } from '@mate-protocol/core';

/**
 * Every legal bond state, in lifecycle order. The one list every surface
 * (daemon, CLI, MCP) validates against, so they agree on what is publishable.
 */
export const BOND_STATES = [
  'none',
  'proposed',
  'accepted',
  'active',
  'paused',
  'revoked',
  'withdrawn',
  'rejected',
  'expired',
  'archived',
] as const;

export type BondState = (typeof BOND_STATES)[number];

/** Whether `value` is one of BOND_STATES. */
export function isBondState(value: unknown): value is BondState {
  return typeof value === 'string' && (BOND_STATES as readonly string[]).includes(value);
}

/** bond.kind from an event's carried MATE.md document content, if parseable. */
export function kindFromContent(content: string): string | null {
  try {
    const doc = JSON.parse(content) as { bond?: { kind?: unknown } };
    return typeof doc.bond?.kind === 'string' ? doc.bond.kind : null;
  } catch {
    return null;
  }
}

export interface MakeBondOptions {
  bondId: string;
  state: BondState;
  kind?: string;
  createdAt?: string;
}

/** Assemble a bond document, filling the consent timestamp the state requires. */
export function makeBondDocument(subjectId: string, objectId: string, options: MakeBondOptions): MateDocument {
  const now = new Date().toISOString();
  const consent: Record<string, unknown> = {
    required: true,
    mutual: true,
    revocable: true,
    unilateral_exit_allowed: true,
  };

  if (['accepted', 'active', 'paused', 'revoked'].includes(options.state)) {
    consent.accepted_at = now;
  }
  const terminalAt: Record<string, string> = {
    revoked: 'revoked_at',
    withdrawn: 'withdrawn_at',
    rejected: 'rejected_at',
    expired: 'expired_at',
  };
  if (terminalAt[options.state]) consent[terminalAt[options.state]] = now;

  return {
    mate_version: '0.2',
    subject: { id: subjectId },
    object: { id: objectId },
    bond: {
      id: options.bondId,
      state: options.state,
      kind: options.kind ?? 'companion',
      created_at: options.createdAt ?? now,
      updated_at: now,
    },
    consent: consent as unknown as MateDocument['consent'],
    proofs: [],
  };
}
