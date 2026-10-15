// Adversarial bond flows over the (now realistic) mock relay: third-party
// sides, ended states, stale relays, junk and flooded inboxes, consent on
// accept, channel safety on reaffirm, and who may reaffirm. Each case is a
// finding from the Simon review of main that the earlier suite let through.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  acceptBond,
  buildBondHistoryEvent,
  buildBondStateEvent,
  buildPrivateBondEvents,
  createRumor,
  finalizeEvent,
  formBond,
  generateNostrKeypair,
  keypairFromSecret,
  listBonds,
  listPrivateBonds,
  listReaffirmations,
  makeBondDocument,
  newBondId,
  publishEvent,
  reaffirmBond,
  secretFromNsec,
  signMateDocumentNostr,
  verifyBond,
  wrapRumor,
} from '../packages/core/src/index.js';
import { startMockRelay, type MockRelay } from './mock-relay.js';

const fresh = () => secretFromNsec(generateNostrKeypair().nsec);
const alice = fresh();
const bob = fresh();
const mallory = fresh();
const alice2 = fresh(); // Alice's own second key

const aliceHex = keypairFromSecret(alice).pubkeyHex;
const bobHex = keypairFromSecret(bob).pubkeyHex;
const aliceNpub = keypairFromSecret(alice).npub;
const bobNpub = keypairFromSecret(bob).npub;

let r1: MockRelay;
let r2: MockRelay;
let relays: string[];

beforeAll(async () => {
  r1 = await startMockRelay();
  r2 = await startMockRelay();
  relays = [r1.url];
});

afterAll(async () => {
  await r1.close();
  await r2.close();
});

const tick = () => new Promise((r) => setTimeout(r, 1100));

describe('verifyBond: the mutual pair predicate', () => {
  it('a third party (or the proposer\'s own second key) p-tagging the proposer is not mutual', async () => {
    for (const intruder of [mallory, alice2]) {
      const bondId = newBondId();
      await formBond(alice, { counterparty: bobNpub, bondId, state: 'proposed', relays });
      // Bob never signed anything; someone else publishes the same id naming Alice.
      await formBond(intruder, { counterparty: aliceNpub, bondId, state: 'active', relays });
      const verdict = await verifyBond(bondId, relays);
      expect(verdict.count).toBe(2);
      expect(verdict.mutual).toBe(false);
    }
  });

  it('a proposal plus an acceptance is mutual, and the pair is reported', async () => {
    const bondId = newBondId();
    await formBond(alice, { counterparty: bobNpub, bondId, state: 'proposed', relays });
    await formBond(mallory, { counterparty: aliceNpub, bondId, state: 'active', relays }); // noise
    await acceptBond(bob, { bondId, counterparty: aliceNpub, relays });
    const verdict = await verifyBond(bondId, relays);
    expect(verdict.mutual).toBe(true);
    expect(new Set(verdict.parties)).toEqual(new Set([aliceHex, bobHex]));
  });

  it.each([
    ['proposed', 'rejected'],
    ['withdrawn', 'active'],
    ['revoked', 'revoked'],
    ['proposed', 'proposed'],
    ['active', 'expired'],
  ] as const)('%s + %s is not mutual', async (aliceState, bobState) => {
    const bondId = newBondId();
    await formBond(alice, { counterparty: bobNpub, bondId, state: aliceState, relays });
    await formBond(bob, { counterparty: aliceNpub, bondId, state: bobState, relays });
    const verdict = await verifyBond(bondId, relays);
    expect(verdict.count).toBe(2);
    expect(verdict.mutual).toBe(false);
  });

  it('a revoke that reached only one relay supersedes the stale active on the other', async () => {
    const both = [r1.url, r2.url];
    const bondId = newBondId();
    await formBond(alice, { counterparty: bobNpub, bondId, state: 'proposed', relays: both });
    await acceptBond(bob, { bondId, relays: both });
    expect((await verifyBond(bondId, both)).mutual).toBe(true);

    await tick();
    await formBond(bob, { counterparty: aliceNpub, bondId, state: 'revoked', relays: [r2.url] });

    const { bonds } = await listBonds({ '#d': [bondId] }, both);
    const bobSides = bonds.filter((b) => b.author === bobHex);
    expect(bobSides).toHaveLength(1);
    expect(bobSides[0].state).toBe('revoked');
    expect((await verifyBond(bondId, both)).mutual).toBe(false);
  });

  it('one junk gift wrap from a stranger cannot zero out a real mutual bond', async () => {
    const bondId = newBondId();
    await formBond(alice, { counterparty: bobNpub, bondId, state: 'proposed', relays });
    await acceptBond(bob, { bondId, relays });
    expect((await verifyBond(bondId, relays, { secret: bob })).mutual).toBe(true);

    // Mallory wraps Bob a rumor for the same bond id with a junk proof.
    const doc = makeBondDocument(keypairFromSecret(mallory).did, bobNpub, { bondId, state: 'active' });
    const proof = signMateDocumentNostr(doc, mallory);
    doc.proofs = [{ ...proof, proofValue: 'z' + '1'.repeat(80) }];
    const junk = buildPrivateBondEvents(doc, mallory);
    await publishEvent(relays, junk.toCounterparty);

    const verdict = await verifyBond(bondId, relays, { secret: bob });
    expect(verdict.invalid?.some((b) => b.author === keypairFromSecret(mallory).pubkeyHex)).toBe(true);
    expect(verdict.mutual).toBe(true);
  });

  it('a flood of other authors\' events on the bond id cannot crowd the parties out', async () => {
    const bondId = newBondId();
    await formBond(alice, { counterparty: bobNpub, bondId, state: 'proposed', relays });
    await acceptBond(bob, { bondId, relays });
    await tick();
    // 220 strangers publish newer sides for the same id (more than one page).
    for (let i = 0; i < 220; i++) {
      const spammer = fresh();
      const doc = makeBondDocument(keypairFromSecret(spammer).did, aliceNpub, { bondId, state: 'active' });
      await publishEvent(relays, buildBondStateEvent(doc, spammer, { createdAt: Math.floor(Date.now() / 1000) }));
    }
    const verdict = await verifyBond(bondId, relays, { secret: bob });
    expect(verdict.mutual).toBe(true);
    expect(new Set(verdict.parties)).toEqual(new Set([aliceHex, bobHex]));
  }, 60_000);
});

describe('verifyBond: a junk flood p-tagging the proposer', () => {
  it('the proposer, an outsider naming her, and reaffirmBond(alice) still see the mutual bond', async () => {
    const relay = await startMockRelay();
    try {
      const rs = [relay.url];
      const bondId = newBondId();
      await formBond(alice, { counterparty: bobNpub, bondId, state: 'proposed', relays: rs });
      await acceptBond(bob, { bondId, relays: rs });
      await tick();
      // 210 fresh keys publish newer sides for the same id naming Alice: they
      // fill both the #d page and the #p page, and push the inferred-pair set
      // past its cap.
      for (let i = 0; i < 210; i++) {
        const spammer = fresh();
        const doc = makeBondDocument(keypairFromSecret(spammer).did, aliceNpub, { bondId, state: 'active' });
        await publishEvent(rs, buildBondStateEvent(doc, spammer, { createdAt: Math.floor(Date.now() / 1000) }));
      }

      const asAlice = await verifyBond(bondId, rs, { secret: alice });
      expect(asAlice.mutual).toBe(true);
      expect(new Set(asAlice.parties)).toEqual(new Set([aliceHex, bobHex]));

      const outsider = await verifyBond(bondId, rs, { parties: [aliceNpub] });
      expect(outsider.mutual).toBe(true);
      expect(new Set(outsider.parties)).toEqual(new Set([aliceHex, bobHex]));

      const r = await reaffirmBond(alice, { bondId, relays: rs });
      expect(r.visibility).toBe('public');
    } finally {
      await relay.close();
    }
  }, 60_000);
});

describe('private sides: the disclosed document must match what is counted', () => {
  it('a rumor whose tags say active but whose signed document says proposed is invalid', async () => {
    const bondId = newBondId();
    const doc = makeBondDocument(keypairFromSecret(alice).did, bobNpub, { bondId, state: 'proposed' });
    doc.proofs = [signMateDocumentNostr(doc, alice)];
    const honest = buildPrivateBondEvents(doc, alice);
    const tags = honest.rumor.tags.map((t) => (t[0] === 'state' ? ['state', 'active'] : t));
    const lying = createRumor({ pubkey: aliceHex, created_at: honest.rumor.created_at, kind: honest.rumor.kind, tags, content: honest.rumor.content });
    await publishEvent(relays, wrapRumor(lying, alice, bobHex));

    const { bonds } = await listPrivateBonds(bob, relays, { bondId });
    expect(bonds).toHaveLength(1);
    expect(bonds[0].state).toBe('active');
    expect(bonds[0].signature_valid).toBe(false);
  });

  it('a proof made by a different key than the author is invalid', async () => {
    const bondId = newBondId();
    const doc = makeBondDocument(keypairFromSecret(alice).did, bobNpub, { bondId, state: 'proposed' });
    doc.proofs = [signMateDocumentNostr(doc, mallory)]; // verifies, but not Alice's key
    await publishEvent(relays, buildPrivateBondEvents(doc, alice).toCounterparty);
    const { bonds } = await listPrivateBonds(bob, relays, { bondId });
    expect(bonds[0].signature_valid).toBe(false);
  });
});

describe('acceptBond: consent and channel', () => {
  it.each(['withdrawn', 'rejected', 'revoked'] as const)('refuses to accept a %s proposal (auto-resolve and explicit)', async (state) => {
    const bondId = newBondId();
    await formBond(alice, { counterparty: bobNpub, bondId, state: 'proposed', relays });
    await formBond(alice, { counterparty: bobNpub, bondId, state, relays });
    await expect(acceptBond(bob, { bondId, relays })).rejects.toThrow(new RegExp(`is ${state} — nothing to accept`));
    await expect(acceptBond(bob, { bondId, counterparty: aliceNpub, relays, visibility: 'public', kind: 'companion' })).rejects.toThrow(/nothing to accept/);
    expect((await verifyBond(bondId, relays)).mutual).toBe(false);
  });

  it('refuses a withdrawn private proposal too — even when the withdraw lands in the same second', async () => {
    const bondId = newBondId();
    await formBond(alice, { counterparty: bobNpub, bondId, state: 'proposed', visibility: 'private', relays });
    // No sleep: the private side must stamp strictly after the prior side, or a
    // same-second tie is broken by lowest id and the withdrawal loses half the time.
    await formBond(alice, { counterparty: bobNpub, bondId, state: 'withdrawn', visibility: 'private', relays });
    await expect(acceptBond(bob, { bondId, relays })).rejects.toThrow(/is withdrawn/);
  });

  it('more than a page of wraps in one second never hides a withdrawal: the read is flagged incomplete and nothing is accepted', async () => {
    const a = await startMockRelay();
    try {
      const bondId = newBondId();
      await formBond(alice, { counterparty: bobNpub, bondId, state: 'proposed', visibility: 'private', relays: [a.url] });
      await formBond(alice, { counterparty: bobNpub, bondId, state: 'withdrawn', visibility: 'private', relays: [a.url] });
      // 201 wraps p-tagging Bob, all in ONE second newer than the bond: page 1
      // is 200 of them, and `until = that second` returns the same 200 again.
      const t = Math.floor(Date.now() / 1000) + 60;
      for (let i = 0; i < 201; i++) {
        const junkKey = fresh();
        await publishEvent([a.url], finalizeEvent({ pubkey: keypairFromSecret(junkKey).pubkeyHex, created_at: t, kind: 1059, tags: [['p', bobHex]], content: 'x' }, junkKey));
      }
      const inbox = await listPrivateBonds(bob, [a.url], { bondId });
      expect(inbox.truncated).toBe(true);
      // Stepping past the saturated second still reaches the older history…
      expect(inbox.bonds.map((x) => x.state)).toEqual(['withdrawn']);
      // …but an incomplete inbox is never accepted on, whatever it shows.
      await expect(acceptBond(bob, { bondId, relays: [a.url] })).rejects.toThrow(/inbox incomplete|is withdrawn/);
      const v = await verifyBond(bondId, [a.url], { secret: bob });
      expect(v.inboxTruncated).toBe(true);
      expect(v.mutual).toBe(false);
    } finally {
      await a.close();
    }
  }, 60_000);

  it('a withdrawal on one relay is seen even when another relay is flooded with skewed history', async () => {
    // Relay A: Alice's proposal AND her withdrawal, plus 200 fresh junk wraps on top.
    // Relay B: only the proposal, plus 200 wraps backdated 49 days. A shared
    // `until` cursor would jump both relays to 49 days ago after page 1 and skip
    // A's withdrawal entirely; per-relay cursors must not.
    const a = await startMockRelay();
    const b = await startMockRelay();
    try {
      const bondId = newBondId();
      await formBond(alice, { counterparty: bobNpub, bondId, state: 'proposed', visibility: 'private', relays: [a.url, b.url] });
      await formBond(alice, { counterparty: bobNpub, bondId, state: 'withdrawn', visibility: 'private', relays: [a.url] });
      const now = Math.floor(Date.now() / 1000);
      const flood = async (relayUrl: string, base: number) => {
        for (let i = 0; i < 200; i++) {
          const junkKey = fresh();
          await publishEvent([relayUrl], finalizeEvent({ pubkey: keypairFromSecret(junkKey).pubkeyHex, created_at: base + i, kind: 1059, tags: [['p', bobHex]], content: 'x' }, junkKey));
        }
      };
      await flood(a.url, now + 60); // fresh junk on A
      await flood(b.url, now - 49 * 86400); // backdated junk on B

      const { bonds } = await listPrivateBonds(bob, [a.url, b.url], { bondId });
      expect(bonds.map((x) => x.state)).toEqual(['withdrawn']);
      await expect(acceptBond(bob, { bondId, relays: [a.url, b.url] })).rejects.toThrow(/is withdrawn/);
    } finally {
      await a.close();
      await b.close();
    }
  }, 60_000);

  it('a flooded inbox still finds the private proposal; the accept stays private', async () => {
    const relay = await startMockRelay();
    try {
      const rs = [relay.url];
      const bondId = newBondId();
      await formBond(alice, { counterparty: bobNpub, bondId, state: 'proposed', visibility: 'private', relays: rs });
      // 250 newer kind:1059 events addressed to Bob (DMs, junk): more than one page.
      const now = Math.floor(Date.now() / 1000) + 60;
      for (let i = 0; i < 250; i++) {
        const junkKey = fresh();
        await publishEvent(rs, finalizeEvent({ pubkey: keypairFromSecret(junkKey).pubkeyHex, created_at: now + i, kind: 1059, tags: [['p', bobHex]], content: 'x' }, junkKey));
      }
      const before = relay.events.filter((e) => e.kind === 30317).length;
      const accepted = await acceptBond(bob, { bondId, counterparty: aliceNpub, relays: rs });
      expect(accepted.visibility).toBe('private');
      // Nothing public about this bond.
      expect(relay.events.filter((e) => e.kind === 30317).length).toBe(before);
      expect((await listBonds({ '#d': [bondId] }, rs)).bonds).toEqual([]);
    } finally {
      await relay.close();
    }
  }, 60_000);
});

describe('reaffirmBond: channel and existence', () => {
  it('reaffirming a private bond without visibility stays private (no public kind:1317)', async () => {
    const bondId = newBondId();
    await formBond(alice, { counterparty: bobNpub, bondId, state: 'proposed', visibility: 'private', relays });
    await acceptBond(bob, { bondId, relays });
    const before = r1.events.filter((e) => e.kind === 1317).length;
    const r = await reaffirmBond(alice, { bondId, counterparty: bobNpub, relays });
    expect(r.visibility).toBe('private');
    const r2b = await reaffirmBond(bob, { bondId, relays }); // counterparty resolved too
    expect(r2b.visibility).toBe('private');
    expect(r1.events.filter((e) => e.kind === 1317).length).toBe(before);
  });

  it('refuses a made-up bond id and a revoked bond unless both fields are explicit', async () => {
    await expect(reaffirmBond(alice, { bondId: newBondId(), counterparty: bobNpub, relays })).rejects.toThrow(/no mutual bond/);

    const bondId = newBondId();
    await formBond(alice, { counterparty: bobNpub, bondId, state: 'proposed', relays });
    await acceptBond(bob, { bondId, relays });
    await formBond(bob, { counterparty: aliceNpub, bondId, state: 'revoked', relays });
    await expect(reaffirmBond(alice, { bondId, relays })).rejects.toThrow(/no mutual bond/);
  });
});

describe('listReaffirmations: only the bond\'s parties count', () => {
  it('a stranger\'s reaffirmation of someone else\'s bond is dropped', async () => {
    const bondId = newBondId();
    await formBond(alice, { counterparty: bobNpub, bondId, state: 'proposed', relays });
    await acceptBond(bob, { bondId, relays });
    await reaffirmBond(alice, { bondId, relays });

    // Mallory publishes a bond.reaffirmed for Alice+Bob's bond, p-tagging Bob,
    // and one for a made-up id.
    for (const id of [bondId, newBondId()]) {
      const doc = makeBondDocument(keypairFromSecret(mallory).did, bobNpub, { bondId: id, state: 'active' });
      const at = new Date().toISOString();
      await publishEvent(relays, buildBondHistoryEvent(doc, mallory, { from: 'active', to: 'active', type: 'bond.reaffirmed', at }, { createdAt: Math.floor(Date.now() / 1000) }));
    }

    const { reaffirmations } = await listReaffirmations(bob, relays);
    const malloryHex = keypairFromSecret(mallory).pubkeyHex;
    expect(reaffirmations.some((r) => r.author === malloryHex)).toBe(false);
    expect(reaffirmations.some((r) => r.bondId === bondId && r.author === aliceHex)).toBe(true);
  });
});
