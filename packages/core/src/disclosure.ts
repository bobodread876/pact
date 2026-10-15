// Selective-disclosure verification with subject binding.
//
// The L1 verifyProof resolves the verification key from
// `proof.verificationMethod` — a field the prover chooses — and never binds it
// to the document's subject. A fabricated document (subject = victim) signed
// by an attacker's key therefore verifies. This wrapper closes that hole: the
// proof's verificationMethod must resolve to the SAME key as `doc.subject.id`;
// on any mismatch the disclosure is invalid without consulting the L1. Only a
// subject-bound proof reaches the L1's signature check.

import { timingSafeEqual } from 'node:crypto';

import { resolveDid, verifyProof, type MateDocument, type Proof } from '@mate-protocol/core';

/**
 * Verify a disclosed bond document's proof, subject-bound. True only when the
 * verificationMethod resolves to the subject's own key AND the L1's signature
 * verification passes.
 */
export function verifyBondDisclosure(doc: MateDocument, proof: Proof): boolean {
  try {
    const subject = resolveDid(doc.subject.id);
    const method = resolveDid(proof.verificationMethod);
    if (subject.algorithm !== method.algorithm) return false;
    const subjectKey = Buffer.from(subject.publicKey);
    const methodKey = Buffer.from(method.publicKey);
    if (subjectKey.length !== methodKey.length || !timingSafeEqual(subjectKey, methodKey)) {
      return false;
    }
  } catch {
    // Unresolvable did / malformed method — not a verifiable disclosure.
    return false;
  }
  return verifyProof(doc, proof);
}
