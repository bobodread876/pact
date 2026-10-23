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
    'a 201-wrap inbox is read COMPLETELY (paged) and reports no truncation',
    async () => {
      // Each wrap carries its own bond id, so every first-stamp wait is
      // independent — publish concurrently (serial would cost ~1s per wrap).
      await Promise.all(
        Array.from({ length: 201 }, () =>
          formBond(alice, {
            counterparty: bobNpub,
            bondId: newBondId(),
            state: 'proposed',
            visibility: 'private',
            relays,
          }),
        ),
      );
      // The inbox pages per relay until history is exhausted: a 201-wrap
      // window is fully read (two pages), so nothing is truncated and no
      // withdrawal can hide beyond the first page.
      const { truncated, bonds, inboxRelaysUnread } = await listPrivateBonds(alice, relays);
      expect(truncated).toBe(false);
      expect(inboxRelaysUnread).toEqual([]);
      expect(bonds.length).toBeGreaterThanOrEqual(201);
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

    // With the key, the private inbox is fully read (paged): no truncation.
    const withKey = await verifyBond(bondId, relays, { secret: alice });
    expect(withKey.truncated).toBeUndefined();

    const withoutKey = await verifyBond(bondId, relays);
    expect(withoutKey.truncated).toBeUndefined();

    const quietKey = await verifyBond(bondId, relays, { secret: carol });
    expect(quietKey.truncated).toBeUndefined();
  });
});
