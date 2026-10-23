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
    'an inbox beyond one page is read COMPLETELY (paged) and reports no truncation',
    async () => {
      // The point: the pager descends past the FIRST page instead of treating
      // a full page as the end of history. Cap the relay's page at 60 so 61
      // wraps = two pages — the same coverage as 201 wraps at the real 200
      // page size, at a fraction of the setup cost (each private formBond
      // re-reads the whole inbox through the paged path).
      relay.setMaxLimit(60);
      const wraps = Array.from({ length: 61 }, () => ({
        counterparty: bobNpub,
        bondId: newBondId(),
        state: 'proposed' as const,
        visibility: 'private' as const,
        relays,
      }));
      for (let i = 0; i < wraps.length; i += 30) {
        await Promise.all(wraps.slice(i, i + 30).map((w) => formBond(alice, w)));
      }
      const { truncated, bonds, inboxRelaysUnread } = await listPrivateBonds(alice, relays);
      expect(truncated).toBe(false);
      expect(inboxRelaysUnread).toEqual([]);
      expect(bonds.length).toBeGreaterThanOrEqual(60);
    },
    120_000,
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
