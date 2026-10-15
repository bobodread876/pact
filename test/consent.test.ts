// Consent-integrity regressions (security audit P0 cluster). Each test mirrors
// a reproduced attack: state-blind mutuality, one-directional/self-tag mutual,
// junk-signature griefing, forged-proposal steering, private rumor tag/doc
// tampering, and selective-disclosure key substitution.

import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  acceptBond,
  buildBondStateEvent,
  buildUnsignedBondStateEvent,
  createRumor,
  formBond,
  generateNostrKeypair,
  keypairFromSecret,
  listBonds,
  listPrivateBonds,
  makeBondDocument,
  newBondId,
  publishEvent,
  secretFromNsec,
  signMateDocumentNostr,
  verifyBond,
  verifyBondDisclosure,
  verifyProof,
  wrapRumor,
} from '../packages/core/src/index.js';
import { startMockRelay, type MockRelay } from './mock-relay.js';

const alice = secretFromNsec(generateNostrKeypair().nsec);
const bob = secretFromNsec(generateNostrKeypair().nsec);
const mallory = secretFromNsec(generateNostrKeypair().nsec);

const aliceHex = keypairFromSecret(alice).pubkeyHex;
const aliceNpub = keypairFromSecret(alice).npub;
const aliceDid = keypairFromSecret(alice).did;
const bobHex = keypairFromSecret(bob).pubkeyHex;
const bobNpub = keypairFromSecret(bob).npub;
const malloryHex = keypairFromSecret(mallory).pubkeyHex;
const malloryNpub = keypairFromSecret(mallory).npub;
const malloryDid = keypairFromSecret(mallory).did;

/** A syntactically plausible but invalid Schnorr signature. */
const BAD_SIG = '00'.repeat(64);

let relay: MockRelay;
let relays: string[];

beforeAll(async () => {
  relay = await startMockRelay();
  relays = [relay.url];
});

afterAll(async () => {
  await relay.close();
});

describe('mutual verdict is state-blind (bugs 1-2)', () => {
  it('Bob rejects Alice\'s proposal → not mutual', async () => {
    // Given: Alice proposes, Bob answers the same bond id with `rejected`.
    const bondId = newBondId();
    await formBond(alice, { counterparty: bobNpub, bondId, state: 'proposed', relays });
    // When: the bond is verified.
    await formBond(bob, { counterparty: aliceNpub, bondId, state: 'rejected', relays });
    // Then: a terminal/rejected side can never compose into mutual.
    const verdict = await verifyBond(bondId, relays);
    expect(verdict.mutual).toBe(false);
  });

  it('Bob accepts then revokes → not mutual (latest state wins)', async () => {
    // Given: a bond that genuinely reached mutual.
    const bondId = newBondId();
    await formBond(alice, { counterparty: bobNpub, bondId, state: 'proposed', relays });
    await acceptBond(bob, { bondId, relays });
    expect((await verifyBond(bondId, relays)).mutual).toBe(true);
    // When: Bob revokes his side (addressable kind: his latest event replaces the accept).
    await formBond(bob, { counterparty: aliceNpub, bondId, state: 'revoked', relays });
    // Then: the verdict follows the revocation.
    const verdict = await verifyBond(bondId, relays);
    expect(verdict.mutual).toBe(false);
  });

  it('Mallory self-tags Alice\'s observed proposal id → not mutual; honest pair still mutual', async () => {
    // Given: an honest mutual bond (control) on one id…
    const honest = newBondId();
    await formBond(alice, { counterparty: bobNpub, bondId: honest, state: 'proposed', relays });
    await acceptBond(bob, { bondId: honest, relays });
    // …and a second bond id where Alice proposed to Bob and Mallory published
    // a valid event p-tagging HERSELF on the same d.
    const hijack = newBondId();
    await formBond(alice, { counterparty: bobNpub, bondId: hijack, state: 'proposed', relays });
    await formBond(mallory, { counterparty: malloryNpub, bondId: hijack, state: 'active', relays });
    // When: both are verified.
    // Then: the control verifies mutual; the self-tag never counts as a second side.
    expect((await verifyBond(honest, relays)).mutual).toBe(true);
    expect((await verifyBond(hijack, relays)).mutual).toBe(false);
  });

  it('duped echo: A(p→V) plus V tricked into echoing the id toward C → not mutual', async () => {
    // Given: Alice publishes an active side toward the victim, and the victim
    // was tricked into publishing the attacker-chosen bond id toward Carol.
    const victim = secretFromNsec(generateNostrKeypair().nsec);
    const carol = secretFromNsec(generateNostrKeypair().nsec);
    const victimNpub = keypairFromSecret(victim).npub;
    const carolNpub = keypairFromSecret(carol).npub;
    const bondId = newBondId();
    // When: both valid, live-state events share one d but point in mixed directions.
    await formBond(alice, { counterparty: victimNpub, bondId, state: 'active', relays });
    await formBond(victim, { counterparty: carolNpub, bondId, state: 'active', relays });
    // Then: no reciprocal pair exists, so the bond cannot be mutual.
    expect((await verifyBond(bondId, relays)).mutual).toBe(false);
  });
});

describe('junk-signature griefing (bug 3)', () => {
  it('an invalid-signature event on the bond id does not flip an honest mutual bond', async () => {
    // Given: an honest mutual bond.
    const bondId = newBondId();
    await formBond(alice, { counterparty: bobNpub, bondId, state: 'proposed', relays });
    await acceptBond(bob, { bondId, relays });
    expect((await verifyBond(bondId, relays)).mutual).toBe(true);
    // When: Mallory drops a junk-signature event on the same d tag.
    const doc = makeBondDocument(malloryDid, aliceNpub, { bondId, state: 'active' });
    const signed = buildBondStateEvent(doc, mallory, { createdAt: Math.floor(Date.now() / 1000) });
    await publishEvent(relays, { ...signed, sig: BAD_SIG });
    // Then: the invalid record is excluded from the verdict — mutual stands.
    const verdict = await verifyBond(bondId, relays);
    expect(verdict.mutual).toBe(true);
    expect(verdict.bonds.filter((b) => !b.signature_valid)).toHaveLength(1);
  });

  it('spam crowding the relay\'s result window surfaces as truncated (inconclusive)', async () => {
    // Given: 50 junk sides (the public result limit) fill the window BEFORE the
    // honest pair arrives — the relay answer can no longer contain the truth.
    const bondId = newBondId();
    for (let i = 0; i < 50; i++) {
      const spam = secretFromNsec(generateNostrKeypair().nsec);
      await formBond(spam, { counterparty: aliceNpub, bondId, state: 'active', relays });
    }
    await formBond(alice, { counterparty: bobNpub, bondId, state: 'proposed', relays });
    await acceptBond(bob, { bondId, relays });
    // When: the bond is listed / verified.
    const listed = await listBonds({ '#d': [bondId] }, relays);
    const verdict = await verifyBond(bondId, relays);
    // Then: callers can see the window was hit and treat the verdict as inconclusive.
    expect(listed.truncated).toBe(true);
    expect(verdict.truncated).toBe(true);
    expect(verdict.mutual).toBe(false);
  });
});

describe('acceptBond proposer steering (bug 4)', () => {
  it('a forged junk-signature proposal p-tagging the victim resolves no proposer → throws', async () => {
    // Given: the only "proposal" for this bond id is forged (pubkey=Carol, junk sig).
    const victim = secretFromNsec(generateNostrKeypair().nsec);
    const carol = secretFromNsec(generateNostrKeypair().nsec);
    const victimHex = keypairFromSecret(victim).pubkeyHex;
    const carolDid = keypairFromSecret(carol).did;
    const carolHex = keypairFromSecret(carol).pubkeyHex;
    const bondId = newBondId();
    const doc = makeBondDocument(carolDid, keypairFromSecret(victim).npub, { bondId, state: 'proposed' });
    const signed = buildBondStateEvent(doc, carol, { createdAt: Math.floor(Date.now() / 1000) });
    await publishEvent(relays, { ...signed, sig: BAD_SIG });
    // When: the victim tries to accept.
    // Then: nothing valid proposed this bond — acceptBond throws instead of
    // steering a signed acceptance toward Carol.
    await expect(acceptBond(victim, { bondId, relays })).rejects.toThrow(/no inbound proposal/);
    const { bonds } = await listBonds({ authors: [victimHex] }, relays);
    expect(bonds.filter((b) => b.bond === bondId)).toHaveLength(0);
    expect(bonds.some((b) => b.counterparty === carolHex)).toBe(false);
  });

  it('a forged competitor alongside a real proposal still resolves the real proposer', async () => {
    // Given: Alice's real proposal plus Mallory's junk-signature forgery, both
    // p-tagging the victim on the same bond id.
    const victim = secretFromNsec(generateNostrKeypair().nsec);
    const victimNpub = keypairFromSecret(victim).npub;
    const bondId = newBondId();
    await formBond(alice, { counterparty: victimNpub, bondId, state: 'proposed', relays });
    const doc = makeBondDocument(malloryDid, victimNpub, { bondId, state: 'proposed' });
    const forged = buildBondStateEvent(doc, mallory, { createdAt: Math.floor(Date.now() / 1000) });
    await publishEvent(relays, { ...forged, sig: BAD_SIG });
    // When: the victim accepts.
    const accept = await acceptBond(victim, { bondId, relays });
    // Then: the acceptance echoes Alice's proposal, and the pair verifies mutual.
    const victimHex = keypairFromSecret(victim).pubkeyHex;
    const { bonds } = await listBonds({ authors: [victimHex] }, relays);
    const side = bonds.find((b) => b.bond === bondId);
    expect(side?.counterparty).toBe(aliceHex);
    expect((await verifyBond(bondId, relays)).mutual).toBe(true);
    expect(accept.bondId).toBe(bondId);
  });

  it('two genuinely valid proposers stay ambiguous → throws', async () => {
    // Given: two real, valid proposals for the same bond id p-tagging the victim.
    const victim = secretFromNsec(generateNostrKeypair().nsec);
    const victimNpub = keypairFromSecret(victim).npub;
    const bondId = newBondId();
    await formBond(alice, { counterparty: victimNpub, bondId, state: 'proposed', relays });
    await formBond(mallory, { counterparty: victimNpub, bondId, state: 'proposed', relays });
    // When / Then: the ambiguity guard is intact.
    await expect(acceptBond(victim, { bondId, relays })).rejects.toThrow(/ambiguous/);
  });
});

describe('private rumor tag/doc binding (bug 5)', () => {
  it('a validly-signed doc under tampered outer tags is dropped from the inbox', async () => {
    // Given: Mallory seals a document SHE validly signed (subject = Mallory,
    // satisfying the seal-author pin) naming her own bond id…
    const victim = secretFromNsec(generateNostrKeypair().nsec);
    const victimHex = keypairFromSecret(victim).pubkeyHex;
    const victimNpub = keypairFromSecret(victim).npub;
    const docBondId = newBondId();
    const tagBondId = newBondId(); // the id the attacker wants the view filed under
    const doc = makeBondDocument(malloryDid, victimNpub, { bondId: docBondId, state: 'active' });
    doc.proofs = [signMateDocumentNostr(doc, mallory)];
    // …embedded in a rumor (proofs ride the encrypted content, per the honest
    // transport) but with tampered outer tags pointing at the victim's bond id.
    const unsigned = buildUnsignedBondStateEvent(doc, malloryHex, { createdAt: Math.floor(Date.now() / 1000) });
    unsigned.content = JSON.stringify({ ...JSON.parse(unsigned.content) as object, proofs: doc.proofs });
    unsigned.tags = unsigned.tags.map((t) => (t[0] === 'd' ? ['d', tagBondId] : t));
    const rumor = createRumor(unsigned);
    await publishEvent(relays, wrapRumor(rumor, mallory, victimHex));
    // When: the victim reads her private inbox and verifies the tag's bond id.
    const { bonds } = await listPrivateBonds(victim, relays);
    // Then: no BondView under the tag's id or the doc's id — the rumor was dropped.
    expect(bonds.find((b) => b.bond === tagBondId)).toBeUndefined();
    expect(bonds.find((b) => b.bond === docBondId)).toBeUndefined();
    const verdict = await verifyBond(tagBondId, relays, { secret: victim });
    expect(verdict.bonds.filter((b) => b.visibility === 'private')).toHaveLength(0);
    expect(verdict.mutual).toBe(false);
  });
});

describe('selective-disclosure proof binding (bug 6)', () => {
  it('a document naming Alice as subject but signed by Mallory is rejected by the wrapper', () => {
    // Given: a fabricated document (subject = Alice, object = Carol) carrying a
    // proof whose verificationMethod resolves to Mallory's key.
    const carolNpub = keypairFromSecret(secretFromNsec(generateNostrKeypair().nsec)).npub;
    const doc = makeBondDocument(aliceDid, carolNpub, { bondId: newBondId(), state: 'active' });
    doc.proofs = [signMateDocumentNostr(doc, mallory)];
    const [proof] = doc.proofs;
    // Control: the L1 verifies it (the hole this wrapper closes).
    expect(verifyProof(doc, proof)).toBe(true);
    // Then: the subject-bound wrapper rejects it.
    expect(verifyBondDisclosure(doc, proof)).toBe(false);
  });

  it('an honestly-issued disclosure (subject == signer) still verifies', () => {
    // Given: Alice signs a document whose subject is Alice.
    const doc = makeBondDocument(aliceDid, bobNpub, { bondId: newBondId(), state: 'proposed' });
    doc.proofs = [signMateDocumentNostr(doc, alice)];
    // When / Then: the wrapper defers to the L1 and the disclosure verifies.
    expect(verifyBondDisclosure(doc, doc.proofs[0])).toBe(true);
  });
});

describe('daemon shares the core predicate', () => {
  const serverSource = readFileSync(new URL('../packages/pactd/src/server.ts', import.meta.url), 'utf8');

  it('pactd imports computeMutual from pact-core and carries no local mutual predicate', () => {
    expect(serverSource).toContain('computeMutual');
    expect(serverSource).not.toContain('.every((b) => b.signature_valid)');
  });
});
