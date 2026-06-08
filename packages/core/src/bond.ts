// Bond document model + assembly. Mirrors the MATE.md v0.2 core shape.

export type BondState =
  | 'none'
  | 'proposed'
  | 'accepted'
  | 'active'
  | 'paused'
  | 'revoked'
  | 'withdrawn'
  | 'rejected'
  | 'expired'
  | 'archived';

export interface BondConsent {
  required?: boolean;
  mutual?: boolean;
  revocable: boolean;
  unilateral_exit_allowed?: boolean;
  accepted_at?: string | null;
  revoked_at?: string | null;
  withdrawn_at?: string | null;
  rejected_at?: string | null;
  expired_at?: string | null;
}

export interface BondDocument {
  mate_version: string;
  subject: { id: string };
  object: { id: string };
  bond: {
    id: string;
    state: BondState;
    kind?: string | null;
    created_at?: string | null;
    updated_at?: string | null;
  };
  consent: BondConsent;
  proofs?: unknown[];
}

export interface MakeBondOptions {
  bondId: string;
  state: BondState;
  kind?: string;
  createdAt?: string;
}

/** Assemble a bond document, filling the consent timestamp the state requires. */
export function makeBondDocument(subjectId: string, objectId: string, options: MakeBondOptions): BondDocument {
  const now = new Date().toISOString();
  const consent: BondConsent = {
    required: true,
    mutual: true,
    revocable: true,
    unilateral_exit_allowed: true,
  };

  if (['accepted', 'active', 'paused', 'revoked'].includes(options.state)) {
    consent.accepted_at = now;
  }
  const terminalAt: Partial<Record<BondState, keyof BondConsent>> = {
    revoked: 'revoked_at',
    withdrawn: 'withdrawn_at',
    rejected: 'rejected_at',
    expired: 'expired_at',
  };
  const field = terminalAt[options.state];
  if (field) (consent as unknown as Record<string, unknown>)[field] = now;

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
    consent,
    proofs: [],
  };
}
