// Discovery stays opt-in, but the daemon says so at the right moments; and an
// accept echoes the proposal's kind unless the acceptor deliberately changes it.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  acceptBond,
  closeIntent,
  formBond,
  generateNostrKeypair,
  keypairFromSecret,
  listBonds,
  loadSecret,
  myIntent,
  newBondId,
  secretFromNsec,
} from '../packages/core/src/index.js';
import { startMockRelay, type MockRelay } from './mock-relay.js';

let relay: MockRelay;
let relays: string[];
let daemon: Server;
let base: string;
let home: string;
let intentconfig: typeof import('../packages/pactd/src/intentconfig.js');

const alice = secretFromNsec(generateNostrKeypair().nsec);
const bob = secretFromNsec(generateNostrKeypair().nsec);
const aliceNpub = keypairFromSecret(alice).npub;
const bobNpub = keypairFromSecret(bob).npub;

async function api(method: string, path: string, body?: unknown): Promise<Record<string, any>> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await res.json()) as Record<string, any>;
}

beforeAll(async () => {
  relay = await startMockRelay();
  relays = [relay.url];
  home = mkdtempSync(join(tmpdir(), 'pact-optin-'));
  process.env.PACT_HOME = home;
  process.env.PACT_RELAYS = relay.url; // read at server import time
  delete process.env.PACT_INTENT_SEEKING;
  delete process.env.PACT_INTENT_ABOUT;
  delete process.env.PACT_TOKEN;
  const server = await import('../packages/pactd/src/server.js');
  intentconfig = await import('../packages/pactd/src/intentconfig.js');
  daemon = server.createDaemon();
  await new Promise<void>((resolve) => daemon.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(daemon.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => daemon.close(() => resolve()));
  await relay.close();
  rmSync(home, { recursive: true, force: true });
});

describe('accept echoes the proposal kind', () => {
  it('omitting kind on accept publishes the same kind the proposer declared', async () => {
    const bondId = newBondId();
    await formBond(alice, { counterparty: bobNpub, bondId, state: 'proposed', kind: 'collaboration', relays });
    const accepted = await acceptBond(bob, { bondId, relays });
    expect(accepted.kind).toBe('collaboration');
    const { bonds } = await listBonds({ '#d': [bondId] }, relays);
    const kinds = new Set(bonds.map((b) => b.kind));
    expect(kinds).toEqual(new Set(['collaboration']));
  });

  it('passing kind on accept is an explicit choice to disagree with the proposer', async () => {
    const bondId = newBondId();
    await formBond(alice, { counterparty: bobNpub, bondId, state: 'proposed', kind: 'collaboration', relays });
    const accepted = await acceptBond(bob, { bondId, kind: 'companion', relays });
    expect(accepted.kind).toBe('companion');
  });

  it('an explicit counterparty in npub or did:nostr form still finds a private proposal (kind + channel)', async () => {
    for (const counterparty of [aliceNpub, keypairFromSecret(alice).did, keypairFromSecret(alice).pubkeyHex]) {
      const bondId = newBondId();
      await formBond(alice, {
        counterparty: bobNpub,
        bondId,
        state: 'proposed',
        kind: 'collaboration',
        relays,
        visibility: 'private',
      });
      const before = relay.events.length;
      const accepted = await acceptBond(bob, { bondId, counterparty, relays });
      expect(accepted.kind).toBe('collaboration');
      expect(accepted.visibility).toBe('private');
      // Nothing about this bond landed on the public graph.
      const { bonds } = await listBonds({ '#d': [bondId] }, relays);
      expect(bonds).toEqual([]);
      expect(relay.events.length).toBeGreaterThan(before);
    }
  });

  it('falls back to the document default when the proposal is not visible', async () => {
    const bondId = newBondId();
    // No proposal on the relays at all — counterparty passed explicitly.
    const accepted = await acceptBond(bob, { bondId, counterparty: aliceNpub, relays });
    expect(accepted.kind).toBe('companion');
  });
});

describe('daemon: discovery is opt-in but announced at the right moments', () => {
  it('a fresh identity reports discoverable:false with the opt-in hint, and publishes no intent', async () => {
    const reqsBefore = relay.reqCount();
    const created = await api('POST', '/identity');
    // A brand-new key cannot have an intent: no relay round trip on keygen.
    expect(relay.reqCount()).toBe(reqsBefore);
    expect(created.created).toBe(true);
    expect(created.discoverable).toBe(false);
    expect(created.hint).toContain('opt-in');
    expect(created.hint).toContain('/intent');
    const mine = await api('GET', '/intent');
    expect(mine.intent).toBeNull();
  });

  it('accepting a bond echoes the kind and carries the discovery status', async () => {
    const me = await api('GET', '/identity');
    const bondId = newBondId();
    await formBond(alice, { counterparty: me.npub, bondId, state: 'proposed', kind: 'collaboration', relays });
    const accepted = await api('POST', '/bonds/accept', { bondId });
    expect(accepted.kind).toBe('collaboration');
    expect(accepted.state).toBe('active');
    expect(accepted.discoverable).toBe(false);
    expect(accepted.hint).toContain('opt-in');

    const overridden = await api('POST', '/bonds/accept', { bondId, kind: 'team' });
    expect(overridden.kind).toBe('team');
  });

  it('a proposal (state proposed) is not decorated; a reciprocal declaration is', async () => {
    const proposed = await api('POST', '/bonds', { counterparty: aliceNpub, state: 'proposed' });
    expect(proposed.discoverable).toBeUndefined();
    const active = await api('POST', '/bonds', { counterparty: aliceNpub, bondId: proposed.bondId, state: 'active' });
    expect(active.discoverable).toBe(false);
  });

  it('once the operator publishes an intent, the hint disappears', async () => {
    await api('POST', '/intent', { seeking: ['collaboration'], about: 'test node' });
    const again = await api('POST', '/identity'); // idempotent; existing key
    expect(again.created).toBe(false);
    expect(again.discoverable).toBe(true);
    expect(again.hint).toBeUndefined();
    const accepted = await api('POST', '/bonds', { counterparty: aliceNpub, state: 'active' });
    expect(accepted.discoverable).toBe(true);
  });
});

describe('PACT_INTENT_SEEKING: the explicit install-time choice', () => {
  it('is null unless set; parses, trims and dedupes kinds', () => {
    expect(intentconfig.configuredIntent({})).toBeNull();
    expect(intentconfig.configuredIntent({ PACT_INTENT_SEEKING: ' , ' })).toBeNull();
    expect(intentconfig.configuredIntent({ PACT_INTENT_SEEKING: 'collaboration, companion,collaboration', PACT_INTENT_ABOUT: ' hi ' }))
      .toEqual({ seeking: ['collaboration', 'companion'], about: 'hi' });
  });

  it('applies once and is idempotent across restarts', async () => {
    const node = secretFromNsec(generateNostrKeypair().nsec);
    expect(await intentconfig.applyConfiguredIntent(node, relays, {})).toBeNull();
    expect(await myIntent(node, relays)).toBeNull();

    const env = { PACT_INTENT_SEEKING: 'guardian', PACT_INTENT_ABOUT: 'configured at install' };
    const first = await intentconfig.applyConfiguredIntent(node, relays, env);
    expect(first?.status).toBe('open');
    expect(first?.seeking).toEqual(['guardian']);
    expect((await myIntent(node, relays))?.about).toBe('configured at install');

    expect(await intentconfig.applyConfiguredIntent(node, relays, env)).toBeNull(); // nothing changed
    const changed = await intentconfig.applyConfiguredIntent(node, relays, { PACT_INTENT_SEEKING: 'guardian,team' });
    expect(changed?.seeking).toEqual(['guardian', 'team']);
  });

  it('an operator unlist survives a restart even with the env still set', async () => {
    const node = secretFromNsec(generateNostrKeypair().nsec);
    const env = { PACT_INTENT_SEEKING: 'collaboration' };
    expect((await intentconfig.applyConfiguredIntent(node, relays, env))?.status).toBe('open');
    await closeIntent(node, relays);
    // Next boot: the closed intent is the operator's decision and wins over the env.
    expect(await intentconfig.applyConfiguredIntent(node, relays, env)).toBeNull();
    expect((await myIntent(node, relays))?.status).toBe('closed');
  });

  it('an unlist holds even when no reachable relay carries the closed record', async () => {
    const unlistHome = mkdtempSync(join(tmpdir(), 'pact-optin-unlist-'));
    const prevHome = process.env.PACT_HOME;
    process.env.PACT_HOME = unlistHome;
    const fresh = await startMockRelay(); // e.g. a relay added after the unlist, while the old one is down
    try {
      const node = secretFromNsec(generateNostrKeypair().nsec);
      const env = { PACT_INTENT_SEEKING: 'collaboration' };
      expect((await intentconfig.applyConfiguredIntent(node, relays, env))?.status).toBe('open');
      intentconfig.markUnlisted(node);
      await closeIntent(node, relays);

      // Next boot sees only the fresh relay: no closed record anywhere it can reach.
      expect(await myIntent(node, [fresh.url])).toBeNull();
      expect(await intentconfig.applyConfiguredIntent(node, [fresh.url], env)).toBeNull();
      expect(await myIntent(node, [fresh.url])).toBeNull();

      // The marker is per identity: another key in the same home is unaffected.
      const other = secretFromNsec(generateNostrKeypair().nsec);
      expect(intentconfig.isUnlisted(other)).toBe(false);
      expect((await intentconfig.applyConfiguredIntent(other, [fresh.url], env))?.status).toBe('open');
    } finally {
      await fresh.close();
      process.env.PACT_HOME = prevHome;
      rmSync(unlistHome, { recursive: true, force: true });
    }
  });

  it('daemon: POST /intent closed records the unlist; an explicit open intent lifts it', async () => {
    const secret = loadSecret(); // the daemon identity created earlier in this file
    const fresh = await startMockRelay();
    const env = { PACT_INTENT_SEEKING: 'collaboration' };
    try {
      await api('POST', '/intent', { status: 'closed' });
      expect(intentconfig.isUnlisted(secret)).toBe(true);
      expect(await intentconfig.applyConfiguredIntent(secret, [fresh.url], env)).toBeNull();
      expect(await myIntent(secret, [fresh.url])).toBeNull();

      const reopened = await api('POST', '/intent', { seeking: ['collaboration'] });
      expect(reopened.status).toBe('open');
      expect(intentconfig.isUnlisted(secret)).toBe(false);
      expect((await intentconfig.applyConfiguredIntent(secret, [fresh.url], env))?.status).toBe('open');
    } finally {
      await fresh.close();
    }
  });

  it('reports discoverable:false when no relay accepted the configured intent', async () => {
    const forcedHome = mkdtempSync(join(tmpdir(), 'pact-optin-reject-'));
    const prevHome = process.env.PACT_HOME;
    process.env.PACT_HOME = forcedHome;
    process.env.PACT_INTENT_SEEKING = 'collaboration';
    relay.setRejectEvents(true);
    try {
      const created = await api('POST', '/identity');
      expect(created.created).toBe(true);
      expect(created.discoverable).toBe(false);
      expect(created.hint).toContain('not accepted by any relay');
      expect(created.intent?.event.relays.every((r: { accepted: boolean }) => !r.accepted)).toBe(true);
    } finally {
      relay.setRejectEvents(false);
      delete process.env.PACT_INTENT_SEEKING;
      process.env.PACT_HOME = prevHome;
      rmSync(forcedHome, { recursive: true, force: true });
    }
  });

  it('a fresh identity created while the env is set becomes findable immediately', async () => {
    const forcedHome = mkdtempSync(join(tmpdir(), 'pact-optin-env-'));
    const prevHome = process.env.PACT_HOME;
    process.env.PACT_HOME = forcedHome;
    process.env.PACT_INTENT_SEEKING = 'collaboration';
    try {
      const created = await api('POST', '/identity');
      expect(created.created).toBe(true);
      expect(created.discoverable).toBe(true);
      expect(created.intent?.seeking).toEqual(['collaboration']);
      const mine = await api('GET', '/intent');
      expect(mine.intent?.seeking).toEqual(['collaboration']);
    } finally {
      delete process.env.PACT_INTENT_SEEKING;
      process.env.PACT_HOME = prevHome;
      rmSync(forcedHome, { recursive: true, force: true });
    }
  });
});
