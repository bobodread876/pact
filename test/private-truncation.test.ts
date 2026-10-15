// Private-inbox truncation: listPrivateBonds resolves at most 200 gift wraps,
// and when crowding fills that window the caller must see `truncated: true`
// instead of a silently-incomplete view — the private counterpart of the
// public listBonds crowding signal. Uses the real wrap path (formBond with
// visibility 'private', 201 bonds) rather than a mocked seam so the count the
// relay window enforces is the count being tested.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  formBond,
  generateNostrKeypair,
  keypairFromSecret,
  listPrivateBonds,
  newBondId,
  secretFromNsec,
  verifyBond,
} from '../packages/core/src/index.js';
import { startMockRelay, type MockRelay } from './mock-relay.js';

const alice = secretFromNsec(generateNostrKeypair().nsec); // crowded inbox
const carol = secretFromNsec(generateNostrKeypair().nsec); // one bond only
const bob = secretFromNsec(generateNostrKeypair().nsec);

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

describe('private inbox truncation signal', () => {
  it(
    'a 201-wrap inbox reports truncated: the window filled',
    async () => {
      for (let i = 0; i < 201; i++) {
        await formBond(alice, {
          counterparty: bobNpub,
          bondId: newBondId(),
          state: 'proposed',
          visibility: 'private',
          relays,
        });
      }
      const { truncated } = await listPrivateBonds(alice, relays);
      expect(truncated).toBe(true);
    },
    60_000,
  );

  it('control: a one-wrap inbox is not truncated', async () => {
    await formBond(carol, {
      counterparty: bobNpub,
      bondId: newBondId(),
      state: 'proposed',
      visibility: 'private',
      relays,
    });
    const { truncated } = await listPrivateBonds(carol, relays);
    expect(truncated).toBe(false);
  });

  it('verifyBond surfaces private-side truncation even when the public side is quiet', async () => {
    const bondId = newBondId();
    await formBond(alice, {
      counterparty: bobNpub,
      bondId,
      state: 'proposed',
      visibility: 'private',
      relays,
    });

    const withKey = await verifyBond(bondId, relays, { secret: alice });
    expect(withKey.truncated).toBe(true);

    const withoutKey = await verifyBond(bondId, relays);
    expect(withoutKey.truncated).toBe(false);

    const quietKey = await verifyBond(bondId, relays, { secret: carol });
    expect(quietKey.truncated).toBe(false);
  });
});
