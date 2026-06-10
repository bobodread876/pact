// End-to-end bond flows over an in-process mock relay: public and private
// transports, propose → accept → verify, including what outsiders can(not) see.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  acceptBond,
  formBond,
  listReaffirmations,
  reaffirmBond,
  generateNostrKeypair,
  keypairFromSecret,
  listBonds,
  listPrivateBonds,
  newBondId,
  secretFromNsec,
  verifyBond,
} from '../packages/core/src/index.js';
import { startMockRelay, type MockRelay } from './mock-relay.js';

const alice = secretFromNsec(generateNostrKeypair().nsec);
const bob = secretFromNsec(generateNostrKeypair().nsec);
const mallory = secretFromNsec(generateNostrKeypair().nsec);

const aliceHex = keypairFromSecret(alice).pubkeyHex;
const bobHex = keypairFromSecret(bob).pubkeyHex;
const bobNpub = keypairFromSecret(bob).npub;

let relay: MockRelay;
let relays: string[];

beforeAll(async () => {
  relay = await startMockRelay();
  relays = [relay.url];
});

afterAll(async () => {
  await relay.close();
});

describe('public bonds (regression)', () => {
  const bondId = newBondId();

  it('forms, accepts, and verifies a mutual public bond', async () => {
    const proposal = await formBond(alice, {
      counterparty: bobNpub,
      bondId,
      state: 'proposed',
      relays,
    });
    expect(proposal.visibility).toBe('public');
    expect(proposal.stateEvent.relays[0].accepted).toBe(true);

    // Bob auto-resolves the proposer and echoes the channel (public).
    const accept = await acceptBond(bob, { bondId, relays });
    expect(accept.visibility).toBe('public');

    const verdict = await verifyBond(bondId, relays);
    expect(verdict.mutual).toBe(true);
    expect(verdict.count).toBe(2);
    expect(verdict.private).toBeUndefined();
    expect(verdict.bonds.every((b) => b.visibility === 'public')).toBe(true);
  });

  it('exposes public bonds to any observer', async () => {
    const { bonds } = await listBonds({ '#d': [bondId] }, relays);
    expect(bonds).toHaveLength(2);
  });
});

describe('private bonds', () => {
  const bondId = newBondId();

  it('forms a private bond: two wraps, no public metadata on the relay', async () => {
    const before = relay.events.length;
    const proposal = await formBond(alice, {
      counterparty: bobNpub,
      bondId,
      state: 'proposed',
      visibility: 'private',
      relays,
    });
    expect(proposal.visibility).toBe('private');
    expect(proposal.wraps?.toCounterparty.relays[0].accepted).toBe(true);
    expect(proposal.wraps?.toSelf.relays[0].accepted).toBe(true);

    // Relay-side: only kind 1059, ephemeral authors, no bond metadata anywhere.
    const stored = relay.events.slice(before);
    expect(stored).toHaveLength(2);
    for (const event of stored) {
      expect(event.kind).toBe(1059);
      expect(event.pubkey).not.toBe(aliceHex);
      expect(JSON.stringify(event)).not.toContain(bondId);
      expect(JSON.stringify(event.tags)).not.toContain('mate-bond');
    }
  });

  it('the counterparty resolves and authenticates the private proposal', async () => {
    const { bonds } = await listPrivateBonds(bob, relays);
    const proposal = bonds.find((b) => b.bond === bondId);
    expect(proposal).toBeDefined();
    expect(proposal?.author).toBe(aliceHex);
    expect(proposal?.counterparty).toBe(bobHex);
    expect(proposal?.state).toBe('proposed');
    expect(proposal?.kind).toBe('companion');
    expect(proposal?.visibility).toBe('private');
    // signature_valid = unwrap chain + embedded BIP-340 proof + subject match.
    expect(proposal?.signature_valid).toBe(true);
  });

  it('outsiders see nothing: no public events, undecryptable wraps', async () => {
    const { bonds: publicView } = await listBonds({ '#d': [bondId] }, relays);
    expect(publicView).toHaveLength(0);

    const { bonds: malloryView } = await listPrivateBonds(mallory, relays);
    expect(malloryView.find((b) => b.bond === bondId)).toBeUndefined();

    // Without a decryption key the verifier finds nothing at all.
    const verdict = await verifyBond(bondId, relays);
    expect(verdict.count).toBe(0);
    expect(verdict.mutual).toBe(false);
  });

  it('accept auto-resolves the private proposer and echoes the private channel', async () => {
    const accept = await acceptBond(bob, { bondId, relays });
    expect(accept.visibility).toBe('private');
  });

  it('both parties verify the bond as mutual + private; outsiders still cannot', async () => {
    for (const secret of [alice, bob]) {
      const verdict = await verifyBond(bondId, relays, { secret });
      expect(verdict.mutual).toBe(true);
      expect(verdict.private).toBe(true);
      expect(verdict.count).toBe(2);
    }

    const outsider = await verifyBond(bondId, relays, { secret: mallory });
    expect(outsider.count).toBe(0);
    expect(outsider.mutual).toBe(false);
  });

  it('latest state wins per author after an update', async () => {
    // Rumor timestamps are unix seconds — cross a second boundary so the
    // update is strictly newer (same-second ties fall back to NIP-01 id order).
    await new Promise((r) => setTimeout(r, 1100));
    await formBond(alice, {
      counterparty: bobNpub,
      bondId,
      state: 'active',
      visibility: 'private',
      relays,
    });
    const { bonds } = await listPrivateBonds(bob, relays, { bondId });
    const fromAlice = bonds.filter((b) => b.author === aliceHex);
    expect(fromAlice).toHaveLength(1);
    expect(fromAlice[0].state).toBe('active');
  });
});

describe('reaffirmation', () => {
  it('private bond: both sides reaffirm privately, no public trace', async () => {
    const bondId = newBondId();
    await formBond(alice, { counterparty: bobNpub, bondId, state: 'proposed', visibility: 'private', relays });
    await acceptBond(bob, { bondId, relays });

    const before = relay.events.filter((e) => e.kind === 1317).length;
    const r1 = await reaffirmBond(alice, { bondId, counterparty: bobNpub, visibility: 'private', relays });
    expect(r1.visibility).toBe('private');
    const aliceNpub = keypairFromSecret(alice).npub;
    await reaffirmBond(bob, { bondId, counterparty: aliceNpub, visibility: 'private', relays });

    // No public kind:1317 events appeared — reaffirmations rode the gift wrap.
    expect(relay.events.filter((e) => e.kind === 1317).length).toBe(before);

    // Each party sees both reaffirmations, latest-per-author.
    for (const secret of [alice, bob]) {
      const { reaffirmations } = await listReaffirmations(secret, relays);
      const forBond = reaffirmations.filter((r) => r.bondId === bondId);
      expect(forBond).toHaveLength(2);
      expect(new Set(forBond.map((r) => r.author))).toEqual(new Set([aliceHex, bobHex]));
      expect(forBond.every((r) => r.visibility === 'private')).toBe(true);
    }

    // An outsider sees none of it.
    const { reaffirmations: outsider } = await listReaffirmations(mallory, relays);
    expect(outsider.filter((r) => r.bondId === bondId)).toHaveLength(0);
  });

  it('public bond: reaffirmation is a queryable typed history event', async () => {
    const bondId = newBondId();
    await formBond(alice, { counterparty: bobNpub, bondId, state: 'proposed', relays });
    await acceptBond(bob, { bondId, relays });

    const result = await reaffirmBond(alice, { bondId, counterparty: bobNpub, relays });
    expect(result.visibility).toBe('public');
    expect(result.event.relays[0].accepted).toBe(true);

    const { reaffirmations } = await listReaffirmations(alice, relays);
    const mine = reaffirmations.find((r) => r.bondId === bondId && r.author === aliceHex);
    expect(mine).toBeDefined();
    expect(mine?.visibility).toBe('public');
    expect(mine?.count).toBe(1);
  });
});

describe('channel override', () => {
  it('a public proposal can be accepted privately when forced', async () => {
    const bondId = newBondId();
    await formBond(alice, { counterparty: bobNpub, bondId, state: 'proposed', relays });
    const accept = await acceptBond(bob, { bondId, relays, visibility: 'private' });
    expect(accept.visibility).toBe('private');

    // Alice sees both sides (her public + Bob's private-to-her).
    const verdict = await verifyBond(bondId, relays, { secret: alice });
    expect(verdict.count).toBe(2);
    expect(verdict.mutual).toBe(true);
    expect(verdict.private).toBe(true);
  });
});
