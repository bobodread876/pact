// Discovery under adversarial conditions: an unlist that reached only one
// relay, a fresh key minting a fake record, and one prolific author trying to
// crowd everyone else's record out of a shared result limit.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  acceptBond,
  buildBondHistoryEvent,
  buildBondIntentEvent,
  buildBondStateEvent,
  closeIntent,
  discover,
  finalizeEvent,
  formBond,
  generateNostrKeypair,
  keypairFromSecret,
  makeBondDocument,
  newBondId,
  publishEvent,
  publishIntent,
  reaffirmBond,
  secretFromNsec,
} from '../packages/core/src/index.js';
import { startMockRelay, type MockRelay } from './mock-relay.js';

const fresh = () => secretFromNsec(generateNostrKeypair().nsec);
let r1: MockRelay;
let r2: MockRelay;

beforeAll(async () => {
  r1 = await startMockRelay();
  r2 = await startMockRelay();
});
afterAll(async () => {
  await r1.close();
  await r2.close();
});

describe('unlisting is honored even when the close reached one relay', () => {
  it('a newer closed intent on relay 2 vetoes the stale open one on relay 1 (with and without kind)', async () => {
    const node = fresh();
    const hex = keypairFromSecret(node).pubkeyHex;
    const both = [r1.url, r2.url];
    await publishIntent(node, { seeking: ['companion'], relays: both });
    // The close reaches relay 2 only, stamped after the open.
    const close = buildBondIntentEvent({ seeking: [], status: 'closed' }, node, { createdAt: Math.floor(Date.now() / 1000) + 5 });
    await publishEvent([r2.url], close);

    expect((await discover(both, {})).candidates.map((c) => c.author)).not.toContain(hex);
    expect((await discover(both, { kind: 'companion' })).candidates.map((c) => c.author)).not.toContain(hex);
  });

  it('closing right after opening (same second) still unlists', async () => {
    const node = fresh();
    const hex = keypairFromSecret(node).pubkeyHex;
    await publishIntent(node, { seeking: ['team'], relays: [r1.url] });
    await closeIntent(node, [r1.url]);
    expect((await discover([r1.url], { kind: 'team' })).candidates.map((c) => c.author)).not.toContain(hex);
  });
});

describe('one author gets one intent slot', () => {
  it('extra intents under other d tags cannot crowd a victim\'s close out of the veto query', async () => {
    const a = await startMockRelay();
    const b = await startMockRelay();
    try {
      const both = [a.url, b.url];
      const victim = fresh();
      const victimHex = keypairFromSecret(victim).pubkeyHex;
      await publishIntent(victim, { seeking: ['companion'], relays: [a.url] });
      const now = Math.floor(Date.now() / 1000);
      await publishEvent([b.url], buildBondIntentEvent({ seeking: [], status: 'closed' }, victim, { createdAt: now + 5 }));

      // Mallory: one real open intent, plus 20 newer "intents" each in its own
      // addressable slot (d = x0..x19), all on relay 2.
      const mallory = fresh();
      const malloryHex = keypairFromSecret(mallory).pubkeyHex;
      await publishIntent(mallory, { seeking: ['companion'], relays: [b.url] });
      for (let i = 0; i < 20; i++) {
        const real = buildBondIntentEvent({ seeking: ['companion'] }, mallory, { createdAt: now + 10 + i });
        const tags = real.tags.map((t) => (t[0] === 'd' ? ['d', `x${i}`] : t));
        await publishEvent([b.url], finalizeEvent({ pubkey: malloryHex, created_at: real.created_at, kind: real.kind, tags, content: real.content }, mallory));
      }

      const { candidates } = await discover(both, { kind: 'companion' });
      const authors = candidates.map((c) => c.author);
      expect(authors).not.toContain(victimHex);
      expect(authors.filter((x) => x === malloryHex)).toHaveLength(1);
      // The off-slot events are never read as Mallory's intent.
      expect(candidates.find((c) => c.author === malloryHex)!.intentAt).toBeLessThan(now + 10);
    } finally {
      await a.close();
      await b.close();
    }
  });
});

describe('the longevity record counts only what a counterparty also signed', () => {
  it('a fresh key with backdated one-sided bonds and reaffirmations of a made-up bond scores zero', async () => {
    const relays = [r1.url];
    const sybil = fresh();
    const sybilHex = keypairFromSecret(sybil).pubkeyHex;
    const yearAgo = Math.floor(Date.now() / 1000) - 365 * 86400;
    for (let i = 0; i < 5; i++) {
      const doc = makeBondDocument(keypairFromSecret(sybil).did, keypairFromSecret(fresh()).npub, { bondId: newBondId(), state: 'active' });
      await publishEvent(relays, buildBondStateEvent(doc, sybil, { createdAt: yearAgo + i }));
    }
    const fake = makeBondDocument(keypairFromSecret(sybil).did, keypairFromSecret(fresh()).npub, { bondId: newBondId(), state: 'active' });
    for (let i = 0; i < 5; i++) {
      const at = new Date().toISOString();
      await publishEvent(relays, buildBondHistoryEvent(fake, sybil, { from: 'active', to: 'active', type: 'bond.reaffirmed', at }, { createdAt: yearAgo + i * 86400 }));
    }
    await publishIntent(sybil, { seeking: ['collaboration'], relays });

    // A real veteran: one mutual, reaffirmed bond.
    const veteran = fresh();
    const partner = fresh();
    const veteranHex = keypairFromSecret(veteran).pubkeyHex;
    const bondId = newBondId();
    await formBond(veteran, { counterparty: keypairFromSecret(partner).npub, bondId, state: 'proposed', relays });
    await acceptBond(partner, { bondId, relays });
    await reaffirmBond(veteran, { bondId, relays });
    await publishIntent(veteran, { seeking: ['collaboration'], relays });

    const { candidates } = await discover(relays, { kind: 'collaboration' });
    const s = candidates.find((c) => c.author === sybilHex)!;
    const v = candidates.find((c) => c.author === veteranHex)!;
    expect(s.record).toEqual({ bonds: 0, reaffirmations: 0, oldestBondDays: 0 });
    expect(v.record.bonds).toBe(1);
    expect(v.record.reaffirmations).toBe(1);
    expect(v.score).toBeGreaterThan(s.score);
  });

  it('one prolific author cannot use up the limit and zero another candidate\'s record', async () => {
    const relay = await startMockRelay();
    try {
      const relays = [relay.url];
      const veteran = fresh();
      const partner = fresh();
      const veteranHex = keypairFromSecret(veteran).pubkeyHex;
      const bondId = newBondId();
      await formBond(veteran, { counterparty: keypairFromSecret(partner).npub, bondId, state: 'proposed', relays });
      await acceptBond(partner, { bondId, relays });
      await publishIntent(veteran, { seeking: ['guardian'], relays });

      const prolific = fresh();
      const now = Math.floor(Date.now() / 1000) + 30;
      for (let i = 0; i < 520; i++) {
        const doc = makeBondDocument(keypairFromSecret(prolific).did, keypairFromSecret(partner).npub, { bondId: newBondId(), state: 'proposed' });
        await publishEvent(relays, buildBondStateEvent(doc, prolific, { createdAt: now + i }));
      }
      await publishIntent(prolific, { seeking: ['guardian'], relays });

      const { candidates } = await discover(relays, { kind: 'guardian' });
      expect(candidates.find((c) => c.author === veteranHex)?.record.bonds).toBe(1);
    } finally {
      await relay.close();
    }
  }, 180_000);
});
