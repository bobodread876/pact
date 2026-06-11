// Discovery e2e: intents on the open board, longevity-record ranking,
// closed/self exclusion — all over the in-process mock relay.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  acceptBond,
  closeIntent,
  discover,
  formBond,
  generateNostrKeypair,
  keypairFromSecret,
  myIntent,
  newBondId,
  publishIntent,
  reaffirmBond,
  secretFromNsec,
} from '../packages/core/src/index.js';
import { startMockRelay, type MockRelay } from './mock-relay.js';

const veteran = secretFromNsec(generateNostrKeypair().nsec); // has history
const newcomer = secretFromNsec(generateNostrKeypair().nsec); // fresh key
const partner = secretFromNsec(generateNostrKeypair().nsec);
const browser = secretFromNsec(generateNostrKeypair().nsec); // just looking

const veteranHex = keypairFromSecret(veteran).pubkeyHex;
const newcomerHex = keypairFromSecret(newcomer).pubkeyHex;
const partnerNpub = keypairFromSecret(partner).npub;
const veteranNpub = keypairFromSecret(veteran).npub;

let relay: MockRelay;
let relays: string[];

beforeAll(async () => {
  relay = await startMockRelay();
  relays = [relay.url];

  // The veteran earns a public record: a mutual bond, reaffirmed.
  const bondId = newBondId();
  await formBond(veteran, { counterparty: partnerNpub, bondId, state: 'proposed', relays });
  await acceptBond(partner, { bondId, relays });
  await reaffirmBond(veteran, { bondId, counterparty: partnerNpub, relays });
});

afterAll(async () => {
  await relay.close();
});

describe('discovery', () => {
  it('publishing an intent makes an agent findable; ranking favors the longevity record', async () => {
    await publishIntent(veteran, { seeking: ['collaboration'], about: 'been around', relays });
    await publishIntent(newcomer, { seeking: ['collaboration', 'companion'], about: 'brand new', relays });

    const { candidates } = await discover(relays, {}, keypairFromSecret(browser).pubkeyHex);
    expect(candidates.map((c) => c.author)).toContain(veteranHex);
    expect(candidates.map((c) => c.author)).toContain(newcomerHex);

    const vet = candidates.find((c) => c.author === veteranHex)!;
    const fresh = candidates.find((c) => c.author === newcomerHex)!;
    expect(vet.record.bonds).toBeGreaterThanOrEqual(1);
    expect(vet.record.reaffirmations).toBe(1);
    expect(fresh.record.bonds).toBe(0);
    expect(vet.score).toBeGreaterThan(fresh.score);
    expect(candidates.indexOf(vet)).toBeLessThan(candidates.indexOf(fresh));
  });

  it('filters by sought kind', async () => {
    const { candidates } = await discover(relays, { kind: 'companion' });
    expect(candidates.map((c) => c.author)).toContain(newcomerHex);
    expect(candidates.map((c) => c.author)).not.toContain(veteranHex);
  });

  it('excludes self from the board', async () => {
    const { candidates } = await discover(relays, {}, veteranHex);
    expect(candidates.map((c) => c.author)).not.toContain(veteranHex);
  });

  it('closing an intent unlists it (and myIntent reflects it)', async () => {
    await closeIntent(newcomer, relays);
    const { candidates } = await discover(relays, {});
    expect(candidates.map((c) => c.author)).not.toContain(newcomerHex);
    const mine = await myIntent(newcomer, relays);
    expect(mine?.status).toBe('closed');
  });

  it('an intent reveals desire, never counterparties', async () => {
    const intents = relay.events.filter((e) => e.kind === 31317 && e.pubkey === veteranHex);
    expect(intents.length).toBeGreaterThan(0);
    for (const e of intents) {
      expect(JSON.stringify(e)).not.toContain(partnerNpub);
      expect(e.tags.some((t) => t[0] === 'p')).toBe(false);
    }
  });
});
